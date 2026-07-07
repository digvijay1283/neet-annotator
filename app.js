/* ── State ──────────────────────────────────────── */
const state = {
  // ── Data (paper-level) ──
  papers:         [],            // 29 raw paper objects (preserved for export)
  topicData:      null,
  tagList:        [],
  qIndex:         new Map(),     // qid → { paperIdx, qIdx }
  annotations:    new Map(),     // qid → annotation record (global saved/skipped store)
  hiddenQids:     new Set(),     // qids soft-deleted for everyone

  // ── Current paper working set ──
  currentPaperIndex: null,       // null → paper-picker view
  questions:      [],            // current paper's questions (refs, each tagged _qid)
  currentIndex:   0,
  savedIndexSet:  new Set(),     // indices (within current paper) that are saved
  partialIndexSet: new Set(),    // saved but missing a required field (subj/chap/topic/tag)
  skippedSet:     new Set(),
  hiddenIndexSet: new Set(),
  editedBy:       {},            // index → { name, at } for the current paper
  filters:        { subject: '', status: 'all', search: '' },
  currentPage:    1,
  PAGE_SIZE:      15,
  filteredIndices: [],

  // ── Collaboration ──
  userName:       '',
  sb:             null,
  useSupabase:    false,

  // ── Admin (export buttons visible only to unlocked device) ──
  isAdmin:        false
};

/* ── DOM refs ───────────────────────────────────── */
const $ = id => document.getElementById(id);

/* ── Init ───────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  setGlobalStatus('Loading data…');
  try {
    await loadData();
  } catch (e) {
    setGlobalStatus('Error loading data');
    showError('Failed to load data files. Open via a local server (e.g. Live Server). ' + e.message);
    return;
  }

  await ensureUserName();          // identify the annotator (name prompt)
  initAdminGate();                 // show export buttons only to an unlocked device
  populateSubjectDropdowns();
  populateTagDropdown();

  initSupabase();                  // connect shared storage (or fall back)
  await loadRemoteState();         // pull annotations + hidden list (or local)
  applyAllRecords();               // reflect saved records onto question objects

  attachEvents();
  subscribeRealtime();             // live updates from other users

  showPaperView();                 // landing = paper picker
  setGlobalStatus(`${state.papers.length} papers · ${state.qIndex.size} questions`);
}

/* ── Data Loading ───────────────────────────────── */
async function loadData() {
  const [pRes, tRes, tagRes] = await Promise.all([
    fetch('./data/converted_papers.json'),
    fetch('./data/topic.txt'),
    fetch('./data/tags.json').catch(() => null)   // optional
  ]);
  if (!pRes.ok) throw new Error('converted_papers.json not found');
  if (!tRes.ok) throw new Error('topic.txt not found');

  const paperFile = await pRes.json();
  state.papers    = Array.isArray(paperFile) ? paperFile : (paperFile.data || []);
  state.topicData = await tRes.json();

  // Tag each question with a stable id (real id) and build the global index.
  state.qIndex = new Map();
  state.papers.forEach((paper, paperIdx) => {
    (paper.questions || []).forEach((q, qIdx) => {
      q._qid = q.id;
      // Snapshot the original annotatable fields so (a) the context hint strip
      // keeps showing the source names after an overwrite, and (b) "Unsave" can
      // fully restore the question to its original, unmodified state.
      q._ctx = {
        subjectId:   q.subjectId,
        subjectKey:  q.subjectKey,
        subjectName: q.subjectName,
        chapterId:   q.chapterId,
        chapterName: q.chapterName,
        topicId:     q.topicId,
        topicName:   q.topicName,
        markId:      q.markId,
        markName:    q.markName,
        marks:       q.marks,
        difficulty:  q.difficulty,
        tagSlugs:    Array.isArray(q.tagSlugs) ? q.tagSlugs.slice() : []
      };
      state.qIndex.set(q.id, { paperIdx, qIdx });
    });
  });

  // Tags file is optional — accept either the raw array or the API envelope.
  if (tagRes && tagRes.ok) {
    const tagJson = await tagRes.json();
    state.tagList = Array.isArray(tagJson) ? tagJson : (tagJson.data || []);
  }
}

/* ── Identity (name prompt) ─────────────────────── */
const LS_USER = 'neet_user';

function ensureUserName() {
  return new Promise(resolve => {
    const existing = localStorage.getItem(LS_USER);
    if (existing) { state.userName = existing; updateUserChip(); resolve(); return; }

    const modal  = $('name-modal');
    const input  = $('name-input');
    const submit = $('name-submit');
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);

    const done = () => {
      state.userName = (input.value || '').trim() || 'Anonymous';
      localStorage.setItem(LS_USER, state.userName);
      modal.classList.add('hidden');
      updateUserChip();
      resolve();
    };
    submit.addEventListener('click', done);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') done(); });
  });
}

function updateUserChip() {
  const chip = $('user-chip');
  chip.textContent = '👤 ' + state.userName;
  chip.classList.remove('hidden');
}

function changeUserName() {
  const next = prompt('Your name:', state.userName || '');
  if (next && next.trim()) {
    state.userName = next.trim();
    localStorage.setItem(LS_USER, state.userName);
    updateUserChip();
  }
}

/* ── Admin gate (export buttons) ────────────────── */
const LS_ADMIN = 'neet_admin';

function initAdminGate() {
  const secret = (window.APP_CONFIG && window.APP_CONFIG.adminSecret) || '';

  // Look for ?admin=… in the query string OR the #hash (support both).
  const fromQuery = new URLSearchParams(window.location.search).get('admin');
  const fromHash  = new URLSearchParams((window.location.hash || '').replace(/^#/, '')).get('admin');
  const provided  = fromQuery != null ? fromQuery : fromHash;

  if (provided === 'off') {
    localStorage.removeItem(LS_ADMIN);                 // lock this device again
    history.replaceState(null, '', window.location.pathname);
  } else if (secret && provided && provided === secret) {
    localStorage.setItem(LS_ADMIN, '1');               // unlock + remember
    history.replaceState(null, '', window.location.pathname);  // scrub secret from URL bar
  }

  state.isAdmin = localStorage.getItem(LS_ADMIN) === '1';
  applyAdminVisibility();
}

// Show/hide every export control based on admin status.
function applyAdminVisibility() {
  ['btn-export', 'btn-export-today', 'btn-export-all'].forEach(id => {
    const el = $(id);
    if (el) el.style.display = state.isAdmin ? '' : 'none';
  });
}

/* ── Supabase (shared realtime storage) ─────────── */
function initSupabase() {
  const cfg = window.SUPABASE_CONFIG || {};
  const configured =
    cfg.url && cfg.anonKey &&
    !cfg.url.includes('YOUR_SUPABASE') && !cfg.anonKey.includes('YOUR_SUPABASE');

  if (!configured || typeof supabase === 'undefined') {
    state.useSupabase = false;
    setSyncStatus('offline', 'Local only');
    return;
  }
  try {
    state.sb = supabase.createClient(cfg.url, cfg.anonKey);
    state.useSupabase = true;
    setSyncStatus('online', 'Connecting…');
  } catch (e) {
    console.warn('Supabase init failed:', e);
    state.useSupabase = false;
    setSyncStatus('error', 'Local only');
  }
}

/* ── Annotation record helpers ──────────────────── */
// Turn a DB row into an in-memory annotation record.
function rowToRecord(row) {
  return {
    subjectId:   row.subject_id,
    subjectKey:  row.subject_key || row.subject_id,
    subjectName: row.subject_name,
    chapterId:   row.chapter_id,
    chapterName: row.chapter_name,
    topicId:     row.topic_id,
    topicName:   row.topic_name,
    markId:      row.mark_id,
    markName:    row.mark_name,
    difficulty:  row.difficulty || 'Medium',
    tagSlugs:    Array.isArray(row.tag_slugs) ? row.tag_slugs : [],
    status:      row.status || 'saved',
    editedBy:    row.edited_by,
    at:          row.updated_at
  };
}

// Text of the currently-selected <option> in a dropdown (null if none chosen).
function selectedText(id) {
  const el = $(id);
  if (!el || !el.value) return null;
  const opt = el.selectedOptions && el.selectedOptions[0];
  return opt ? opt.text : null;
}

// Write a saved record's chosen IDs *and* names onto the live question object so
// filters, cards and export reflect the expert's selection. The original source
// context is preserved separately on q._ctx (see loadData) for the hint strip.
function applyRecordToQuestion(q, rec) {
  if (!q || !rec || rec.status !== 'saved') return;
  q.subjectId   = rec.subjectId;
  q.subjectKey  = rec.subjectId;   // same value as subjectId (per spec)
  q.subjectName = rec.subjectName;
  q.chapterId   = rec.chapterId;
  q.chapterName = rec.chapterName;
  q.topicId     = rec.topicId;
  q.topicName   = rec.topicName;
  q.markId      = rec.markId;
  q.markName    = rec.markName;
  q.difficulty  = rec.difficulty;
  q.tagSlugs    = rec.tagSlugs;    // extra field kept for our workflow
}

// Revert a question to its original, unmodified state (used by Unsave).
function restoreQuestionDefault(q) {
  if (!q || !q._ctx) return;
  const c = q._ctx;
  q.subjectId   = c.subjectId   ?? null;
  q.subjectKey  = c.subjectKey  ?? null;
  q.subjectName = c.subjectName ?? null;
  q.chapterId   = c.chapterId   ?? null;
  q.chapterName = c.chapterName ?? null;
  q.topicId     = c.topicId     ?? null;
  q.topicName   = c.topicName   ?? null;
  q.markId      = c.markId      ?? null;
  q.markName    = c.markName    ?? null;
  q.difficulty  = c.difficulty  ?? null;
  q.tagSlugs    = Array.isArray(c.tagSlugs) ? c.tagSlugs.slice() : [];
}

function questionByQid(qid) {
  const loc = state.qIndex.get(qid);
  if (!loc) return null;
  return state.papers[loc.paperIdx].questions[loc.qIdx];
}

// Reflect every loaded record onto its question object.
function applyAllRecords() {
  state.annotations.forEach((rec, qid) => applyRecordToQuestion(questionByQid(qid), rec));
}

// qid ↔ index helpers for the CURRENT paper.
function qidOf(index) {
  const q = state.questions[index];
  return q ? q._qid : null;
}
function indexOfQid(qid) {
  const loc = state.qIndex.get(qid);
  return (loc && loc.paperIdx === state.currentPaperIndex) ? loc.qIdx : -1;
}

/* ── Load annotations + hidden list ─────────────── */
async function loadRemoteState() {
  if (!state.useSupabase) { restoreFromLocalStorage(); return; }

  setSyncStatus('online', 'Syncing…');
  try {
    const [aRes, hRes] = await Promise.all([
      state.sb.from('annotations').select('*'),
      state.sb.from('hidden_questions').select('question_id')
    ]);
    if (aRes.error) throw aRes.error;
    if (hRes.error) throw hRes.error;

    state.annotations = new Map();
    (aRes.data || []).forEach(row => state.annotations.set(row.question_id, rowToRecord(row)));
    state.hiddenQids = new Set((hRes.data || []).map(h => h.question_id));

    setSyncStatus('online', 'Live');
    if (state.annotations.size) {
      showToast(`Loaded ${state.annotations.size} annotations from the team`, 'success');
    }
  } catch (e) {
    console.warn('Supabase load failed — falling back to local:', e);
    state.useSupabase = false;
    setSyncStatus('error', 'Offline (local)');
    restoreFromLocalStorage();
  }
}

// Write one annotation to the shared DB (last write wins). Always caches locally.
async function upsertAnnotation(payload) {
  persistToLocalStorage();
  if (!state.useSupabase) return;
  try {
    const { error } = await state.sb
      .from('annotations')
      .upsert(payload, { onConflict: 'question_id' });
    if (error) throw error;
    setSyncStatus('online', 'Live');
  } catch (e) {
    console.warn('Save to Supabase failed:', e);
    setSyncStatus('error', 'Sync failed');
    showToast('Cloud sync failed — saved locally', 'warning');
  }
}

/* ── Realtime (live team updates) ───────────────── */
function subscribeRealtime() {
  if (!state.useSupabase) return;
  state.sb
    .channel('neet-realtime')
    // Annotations (save / skip)
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'annotations' },
        payload => {
          const isDelete = payload.eventType === 'DELETE';
          const row = isDelete ? payload.old : payload.new;
          const qid = row.question_id;

          if (isDelete) {
            state.annotations.delete(qid);
            restoreQuestionDefault(questionByQid(qid));   // teammate unsaved it
          } else {
            const rec = rowToRecord(row);
            state.annotations.set(qid, rec);
            applyRecordToQuestion(questionByQid(qid), rec);
          }
          onRemoteChange(qid);

          if (!isDelete && row.edited_by && row.edited_by !== state.userName) {
            const loc = state.qIndex.get(qid);
            if (loc) showToast(`${row.edited_by} updated a question`, '');
          }
        })
    // Soft-delete (hide) / un-hide of any question
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'hidden_questions' },
        payload => { hideQidLocally(payload.new.question_id); })
    .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'hidden_questions' },
        payload => { unhideQidLocally(payload.old.question_id); })
    .subscribe(status => {
      if (status === 'SUBSCRIBED') setSyncStatus('online', 'Live');
    });
}

// A remote annotation change landed for `qid` — refresh whichever view is showing.
function onRemoteChange(qid) {
  const loc = state.qIndex.get(qid);
  if (state.currentPaperIndex === null) {
    renderPaperGrid();
    return;
  }
  if (loc && loc.paperIdx === state.currentPaperIndex) {
    rebuildPaperSets();
    applyFilters();
    updateStats();
    if (loc.qIdx === state.currentIndex) renderEditor(loc.qIdx);
  }
}

function hideQidLocally(qid) {
  if (!qid || state.hiddenQids.has(qid)) return;
  state.hiddenQids.add(qid);
  afterHiddenChange(qid);
}
function unhideQidLocally(qid) {
  if (!state.hiddenQids.has(qid)) return;
  state.hiddenQids.delete(qid);
  afterHiddenChange(qid);
}
function afterHiddenChange(qid) {
  const loc = state.qIndex.get(qid);
  if (state.currentPaperIndex === null) { renderPaperGrid(); return; }
  if (loc && loc.paperIdx === state.currentPaperIndex) {
    rebuildPaperSets();
    applyFilters();
    updateStats();
    if (loc.qIdx === state.currentIndex) navigateToVisible();
  }
}

function setSyncStatus(kind, text) {
  const el = $('sync-status');
  if (!el) return;
  const dot = kind === 'online' ? '● ' : kind === 'error' ? '▲ ' : '○ ';
  el.className   = 'sync-status ' + (kind || '');
  el.textContent = dot + (text || '');
}

/* ── Event Listeners ────────────────────────────── */
function attachEvents() {
  $('user-chip').addEventListener('click', changeUserName);
  $('btn-back').addEventListener('click', closePaper);

  $('btn-save').addEventListener('click', saveQuestion);
  $('btn-prev').addEventListener('click', navigatePrev);
  $('btn-skip').addEventListener('click', skipQuestion);
  $('btn-unsave').addEventListener('click', unsaveQuestion);
  $('btn-delete').addEventListener('click', deleteCurrentQuestion);

  $('btn-export').addEventListener('click', () => exportJSON(false));
  $('btn-export-today').addEventListener('click', () => exportJSON(true));
  $('btn-export-all').addEventListener('click', () => exportJSON(false, true));  // TEMPORARY

  $('sel-subject').addEventListener('change', onSubjectChange);
  $('sel-chapter').addEventListener('change', onChapterChange);

  // Keep the Save button's enabled/disabled state in sync with the form.
  $('sel-subject').addEventListener('change', updateSaveButtonState);
  $('sel-chapter').addEventListener('change', updateSaveButtonState);
  $('sel-topic').addEventListener('change', updateSaveButtonState);

  $('filter-subject').addEventListener('change', onFilterChange);
  $('filter-status').addEventListener('change', onFilterChange);

  let searchTimer;
  $('filter-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(onFilterChange, 220);
  });

  $('pg-prev').addEventListener('click', () => changePage(-1));
  $('pg-next').addEventListener('click', () => changePage(1));
}

/* ── Paper progress + picker view ───────────────── */
function paperStats(paper) {
  let total = 0, saved = 0;
  (paper.questions || []).forEach(q => {
    if (state.hiddenQids.has(q._qid)) return;
    total++;
    const rec = state.annotations.get(q._qid);
    if (rec && rec.status === 'saved') saved++;
  });
  return { saved, total, complete: total > 0 && saved === total };
}

function showPaperView() {
  state.currentPaperIndex = null;
  $('paper-view').classList.remove('hidden');
  $('layout').classList.add('hidden');
  $('btn-back').classList.add('hidden');
  $('app-title-text').textContent = 'NEET Annotator';
  renderPaperGrid();
}

function renderPaperGrid() {
  const grid = $('paper-grid');
  grid.innerHTML = '';
  let completedCount = 0;

  const frag = document.createDocumentFragment();
  state.papers.forEach((paper, i) => {
    const { saved, total, complete } = paperStats(paper);
    if (complete) completedCount++;
    const pct = total > 0 ? Math.round((saved / total) * 100) : 0;

    const card = document.createElement('div');
    card.className = 'paper-card' + (complete ? ' completed' : '');
    card.innerHTML = `
      <div class="paper-card-top">
        <div>
          <div class="paper-card-name">${escapeHtml(paper.paperName)}</div>
          <div class="paper-card-meta">${total} question${total !== 1 ? 's' : ''}</div>
        </div>
        ${complete ? '<span class="badge saved">✓ Completed</span>' : ''}
      </div>
      <div class="paper-card-bar"><i style="width:${pct}%"></i></div>
      <div class="paper-card-progress-num">${saved} / ${total} annotated</div>
    `;
    card.addEventListener('click', () => openPaper(i));
    frag.appendChild(card);
  });
  grid.appendChild(frag);

  $('papers-progress').textContent =
    `${completedCount} / ${state.papers.length} papers completed`;
}

/* ── Open / close a paper ───────────────────────── */
function openPaper(i) {
  state.currentPaperIndex = i;
  const paper = state.papers[i];
  state.questions = paper.questions || [];

  // Reset filters + paging for the newly opened paper.
  state.filters = { subject: '', status: 'all', search: '' };
  $('filter-subject').value = '';
  $('filter-status').value  = 'all';
  $('filter-search').value  = '';
  state.currentPage = 1;

  rebuildPaperSets();

  $('paper-view').classList.add('hidden');
  $('layout').classList.remove('hidden');
  $('btn-back').classList.remove('hidden');
  $('app-title-text').textContent  = paper.paperName;
  $('editor-paper-name').textContent = paper.paperName;

  applyFilters();
  // Land on the first item of the sorted list (the first unmodified question).
  state.currentIndex = state.filteredIndices.length ? state.filteredIndices[0] : firstVisibleIndex();
  renderEditor(state.currentIndex);
  updateStats();
}

function closePaper() {
  showPaperView();
}

// Derive the saved / skipped / hidden index sets for the current paper from
// the global annotation store.
function rebuildPaperSets() {
  state.savedIndexSet   = new Set();
  state.partialIndexSet = new Set();
  state.skippedSet      = new Set();
  state.hiddenIndexSet  = new Set();
  state.editedBy        = {};
  state.questions.forEach((q, idx) => {
    if (state.hiddenQids.has(q._qid)) state.hiddenIndexSet.add(idx);
    const rec = state.annotations.get(q._qid);
    if (!rec) return;
    state.editedBy[idx] = { name: rec.editedBy || '?', at: rec.at };
    if (rec.status === 'skipped') {
      state.skippedSet.add(idx);
    } else {
      state.savedIndexSet.add(idx);
      if (isPartialAnnotation(rec)) state.partialIndexSet.add(idx);
    }
  });
}

function firstVisibleIndex() {
  for (let i = 0; i < state.questions.length; i++) {
    if (!state.hiddenIndexSet.has(i)) return i;
  }
  return 0;
}

/* ── Subject Dropdowns ──────────────────────────── */
function populateSubjectDropdowns() {
  const subjects = state.topicData.subjects || [];
  const editorSel = $('sel-subject');

  // Editor (assignment) dropdown keeps the full, grade-specific topic list.
  subjects.forEach(s => editorSel.appendChild(makeOption(s.id, s.name)));

  // Filter dropdown matches the source data, which only distinguishes the base
  // subject (Physics / Chemistry / Biology) and carries no subjectId. Build the
  // options from the base names actually present so the filter can match both
  // unannotated (subjectName: "Physics") and annotated ("Physics 11th") rows.
  const filterSel = $('filter-subject');
  const bases = new Set();
  state.papers.forEach(p => (p.questions || []).forEach(q => {
    const base = baseSubjectName(q.subjectName);
    if (base) bases.add(base);
  }));
  // Fall back to the topic list (stripped of grade) if the data had no names.
  if (!bases.size) subjects.forEach(s => bases.add(baseSubjectName(s.name)));

  [...bases].sort().forEach(base => filterSel.appendChild(makeOption(base, base)));
}

// Reduce a subject label to its base name, dropping any grade suffix.
// "Physics 11th" → "Physics", "Biology 12th" → "Biology", "Physics" → "Physics".
function baseSubjectName(name) {
  if (!name) return '';
  return String(name).replace(/\s+\d+(st|nd|rd|th)\b.*$/i, '').trim();
}

/* ── Tag Pills (multi-select) ───────────────────── */
function populateTagDropdown() {
  const container = $('tag-pills');
  container.innerHTML = '';

  let tags;
  if (state.tagList.length) {
    tags = state.tagList.map(t => ({ slug: t.slug, name: t.name }));
  } else {
    const set = new Set();
    state.qIndex.forEach((_, qid) => {
      const q = questionByQid(qid);
      (q && q.tagSlugs || []).forEach(t => set.add(t));
    });
    tags = [...set].sort().map(slug => ({ slug, name: prettifyTag(slug) }));
  }

  tags.forEach(t => {
    const pill = document.createElement('button');
    pill.type        = 'button';
    pill.className    = 'tag-pill';
    pill.dataset.slug = t.slug;
    pill.textContent  = t.name;
    pill.setAttribute('aria-pressed', 'false');
    pill.addEventListener('click', () => {
      const on = pill.classList.toggle('selected');
      pill.setAttribute('aria-pressed', on ? 'true' : 'false');
      updateSaveButtonState();
    });
    container.appendChild(pill);
  });
}

function getSelectedTags() {
  return [...document.querySelectorAll('#tag-pills .tag-pill.selected')]
    .map(p => p.dataset.slug);
}

function setSelectedTags(slugs) {
  const wanted = new Set(slugs || []);
  document.querySelectorAll('#tag-pills .tag-pill').forEach(p => {
    const on = wanted.has(p.dataset.slug);
    p.classList.toggle('selected', on);
    p.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function prettifyTag(slug) {
  return slug.split('-').map(part => (/^\d+$/.test(part) ? part : part.toUpperCase())).join(' ');
}

function makeOption(value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

/* ── Cascading Dropdowns ────────────────────────── */
function onSubjectChange() {
  const subjectId = $('sel-subject').value;
  const chapterSel = $('sel-chapter');
  const topicSel   = $('sel-topic');

  chapterSel.innerHTML = '<option value="">— Select Chapter —</option>';
  chapterSel.disabled = true;
  topicSel.innerHTML = '<option value="">— Select Topic —</option>';
  topicSel.disabled = true;

  const marks = subjectId ? state.topicData.marks?.[subjectId] : null;
  $('marks-display').textContent = marks ? marks.name : '–';

  if (!subjectId) return;

  const chapters = state.topicData.chapters?.[subjectId] || [];
  chapters.forEach(c => chapterSel.appendChild(makeOption(c.id, c.name)));
  if (chapters.length) chapterSel.disabled = false;
}

function onChapterChange() {
  const subjectId  = $('sel-subject').value;
  const chapterId  = $('sel-chapter').value;
  const topicSel   = $('sel-topic');

  topicSel.innerHTML = '<option value="">— Select Topic —</option>';
  topicSel.disabled = true;

  if (!subjectId || !chapterId) return;

  const chapters = state.topicData.chapters?.[subjectId] || [];
  const chapter  = chapters.find(c => c.id === chapterId);
  if (!chapter) return;

  const topics = chapter.topics || [];
  topics.forEach(t => topicSel.appendChild(makeOption(t.id, t.name)));
  if (topics.length) topicSel.disabled = false;
}

/* ── Editor Rendering ───────────────────────────── */
function renderEditor(index) {
  if (index < 0 || index >= state.questions.length) return;
  state.currentIndex = index;

  const q = state.questions[index];

  $('q-num').textContent   = index + 1;
  $('q-total').textContent = state.questions.length;

  // Status badge
  const badgeEl = $('badge-status');
  if (state.partialIndexSet.has(index)) {
    badgeEl.className = 'badge partial'; badgeEl.textContent = '⚠ Partial';
  } else if (state.savedIndexSet.has(index)) {
    badgeEl.className = 'badge saved'; badgeEl.textContent = '✓ Saved';
  } else if (state.skippedSet.has(index)) {
    badgeEl.className = 'badge skipped'; badgeEl.textContent = '⊘ Skipped';
  } else {
    badgeEl.className = 'badge unsaved'; badgeEl.textContent = '○ Unsaved';
  }

  const eb = state.editedBy[index];
  $('edited-by').textContent = eb && eb.name ? `edited by ${eb.name}` : '';

  // Unsave is always visible while a paper is open, but only enabled for an
  // already-annotated (saved/skipped) question.
  const annotated = state.savedIndexSet.has(index) || state.skippedSet.has(index);
  $('btn-unsave').disabled = !annotated;

  // Question HTML
  $('question-body').innerHTML = q.questionHtml || '<em>No question text</em>';
  renderKaTeX('question-body');

  // Options
  renderOptions(q);

  // Explanation
  $('explanation-body').innerHTML = q.explanationHtml || '<em>No explanation</em>';
  $('explanation-toggle').removeAttribute('open');
  $('explanation-toggle').addEventListener('toggle', function onToggle() {
    if ($('explanation-toggle').open) {
      renderKaTeX('explanation-body');
      $('explanation-toggle').removeEventListener('toggle', onToggle);
    }
  }, { once: true });

  // Read-only source context
  renderContext(q);

  // Pre-fill form
  prefillForm(index);

  highlightActiveCard(index);
}

// New-format options: { id, text }; correct answer via q.correctOptionId.
function renderOptions(q) {
  const options = q.options || [];
  const list = $('options-list');
  list.innerHTML = '';
  const labels = ['A', 'B', 'C', 'D', 'E'];
  options.forEach((opt, i) => {
    const li = document.createElement('li');
    if (opt.id === q.correctOptionId) li.classList.add('correct');
    li.innerHTML = `<span class="opt-label">${labels[i] || opt.id}</span><span>${opt.text ?? ''}</span>`;
    list.appendChild(li);
  });
  renderKaTeX('options-list');
}

// Original source suggestion (helps the expert decide). Read from the snapshot
// taken at load, so it stays visible even after the fields are overwritten.
function renderContext(q) {
  const ctx = q._ctx || q;
  const items = [
    ['Source Subject', ctx.subjectName],
    ['Chapter',        ctx.chapterName],
    ['Topic',          ctx.topicName],
    ['Marks',          ctx.marks != null ? String(ctx.marks) : null]
  ].filter(([, v]) => v);

  $('q-context').innerHTML = items.length
    ? items.map(([label, val]) =>
        `<span class="ctx-item"><span class="ctx-label">${label}</span><span class="ctx-value">${escapeHtml(val)}</span></span>`
      ).join('<span class="ctx-sep">·</span>')
    : '';
}

/* ── KaTeX ──────────────────────────────────────── */
function renderKaTeX(containerId) {
  if (typeof renderMathInElement !== 'function') return;
  const el = document.getElementById(containerId);
  if (!el) return;
  renderMathInElement(el, {
    delimiters: [
      { left: '$$', right: '$$', display: true  },
      { left: '$',  right: '$',  display: false },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true  }
    ],
    throwOnError: false
  });
}

/* ── Pre-fill Form ──────────────────────────────── */
function prefillForm(index) {
  const q   = state.questions[index];
  const rec = state.annotations.get(q._qid);

  const subjectId  = (rec && rec.subjectId)  || q.subjectId  || '';
  const chapterId  = (rec && rec.chapterId)  || q.chapterId  || '';
  const topicId    = (rec && rec.topicId)    || q.topicId    || '';
  const difficulty = (rec && rec.difficulty) || q.difficulty || 'Medium';
  const tagSlugs   = (rec && rec.tagSlugs)   || q.tagSlugs   || [];

  $('sel-subject').value = subjectId;
  onSubjectChange();

  if (chapterId) {
    $('sel-chapter').value = chapterId;
    onChapterChange();
    if (topicId) $('sel-topic').value = topicId;
  }

  $('sel-difficulty').value = difficulty || 'Medium';
  setSelectedTags(tagSlugs);

  updateSaveButtonState();
}

/* ── Required-field validation ──────────────────────
   Subject, Chapter, Topic and at least one Tag are mandatory. Difficulty always
   carries a value (defaults to Medium) and Marks auto-derives from Subject. */
function missingRequiredFields() {
  const missing = [];
  if (!$('sel-subject').value) missing.push('Subject');
  if (!$('sel-chapter').value) missing.push('Chapter');
  if (!$('sel-topic').value)   missing.push('Topic');
  if (getSelectedTags().length === 0) missing.push('at least one Tag');
  return missing;
}

// A saved annotation counts as "partial" if any mandatory field is empty. These
// are typically rows saved before the all-fields-required rule was introduced.
function isPartialAnnotation(rec) {
  if (!rec || rec.status !== 'saved') return false;
  return !rec.subjectId || !rec.chapterId || !rec.topicId
    || !Array.isArray(rec.tagSlugs) || rec.tagSlugs.length === 0;
}

// Enable Save only when every required field is filled; otherwise disable it and
// explain what's missing via the tooltip.
function updateSaveButtonState() {
  const btn = $('btn-save');
  if (!btn) return;
  const missing = missingRequiredFields();
  btn.disabled = missing.length > 0;
  btn.title = missing.length ? `Select ${missing.join(', ')} to save` : 'Save & Next';
}

/* ── Save ───────────────────────────────────────── */
function saveQuestion() {
  // All fields are mandatory — refuse to save an incomplete annotation.
  const missing = missingRequiredFields();
  if (missing.length) {
    showToast(`Select ${missing.join(', ')} before saving`, 'warning');
    updateSaveButtonState();
    return;
  }

  const index      = state.currentIndex;
  const q          = state.questions[index];
  const paper      = state.papers[state.currentPaperIndex];
  const subjectId  = $('sel-subject').value  || null;
  const chapterId  = $('sel-chapter').value  || null;
  const topicId    = $('sel-topic').value    || null;
  const difficulty = $('sel-difficulty').value;
  const tags       = getSelectedTags();
  const mark       = subjectId ? state.topicData.marks?.[subjectId] : null;
  const markId     = mark ? mark.id : null;
  const markName   = mark ? mark.name : null;

  // Names of the chosen options (from topic.txt, via the dropdown text).
  const subjectName = selectedText('sel-subject');
  const chapterName = selectedText('sel-chapter');
  const topicName   = selectedText('sel-topic');

  const rec = {
    subjectId,
    subjectKey: subjectId,
    subjectName,
    chapterId,
    chapterName,
    topicId,
    topicName,
    markId,
    markName,
    difficulty,
    tagSlugs: tags,
    status:   'saved',
    editedBy: state.userName,
    at:       new Date().toISOString()
  };

  state.annotations.set(q._qid, rec);
  applyRecordToQuestion(q, rec);

  state.savedIndexSet.add(index);
  state.partialIndexSet.delete(index);   // save enforces all fields → never partial
  state.skippedSet.delete(index);
  state.editedBy[index] = { name: state.userName, at: rec.at };

  upsertAnnotation({
    question_id:  q._qid,
    paper_id:     paper.paperId,
    subject_id:   subjectId,
    subject_key:  subjectId,
    subject_name: subjectName,
    chapter_id:   chapterId,
    chapter_name: chapterName,
    topic_id:     topicId,
    topic_name:   topicName,
    mark_id:      markId,
    mark_name:    markName,
    difficulty,
    tag_slugs:    tags,
    status:       'saved',
    edited_by:    state.userName
  });

  updateStats();
  showToast('Saved!', 'success');
  renderQuestionList();
  navigateNext();
}

/* ── Skip ───────────────────────────────────────── */
function skipQuestion() {
  const index = state.currentIndex;
  const q     = state.questions[index];
  const paper = state.papers[state.currentPaperIndex];

  if (!state.savedIndexSet.has(index)) {
    const at = new Date().toISOString();
    state.annotations.set(q._qid, {
      status: 'skipped', editedBy: state.userName, at, tagSlugs: []
    });
    state.skippedSet.add(index);
    state.editedBy[index] = { name: state.userName, at };
    upsertAnnotation({
      question_id: q._qid,
      paper_id:    paper.paperId,
      status:      'skipped',
      edited_by:   state.userName
    });
  } else {
    persistToLocalStorage();
  }
  renderQuestionList();
  updateStats();
  navigateNext();
}

/* ── Unsave (reset a question to its original state) ─ */
async function unsaveQuestion() {
  const index = state.currentIndex;
  const q = state.questions[index];
  if (!q) return;
  const qid = q._qid;

  if (!state.annotations.has(qid)) {
    showToast('Nothing to unsave', '');
    return;
  }
  const ok = confirm('Reset this question to its original, unmodified state? '
    + 'This removes its saved annotation' + (state.useSupabase ? ' for everyone.' : '.'));
  if (!ok) return;

  // Clear locally: drop the record, restore original field values, update sets.
  state.annotations.delete(qid);
  restoreQuestionDefault(q);
  state.savedIndexSet.delete(index);
  state.partialIndexSet.delete(index);
  state.skippedSet.delete(index);
  delete state.editedBy[index];
  persistToLocalStorage();

  // Remove the row from the shared DB (if connected).
  if (state.useSupabase) {
    try {
      const { error } = await state.sb.from('annotations').delete().eq('question_id', qid);
      if (error) throw error;
      setSyncStatus('online', 'Live');
    } catch (e) {
      console.warn('Unsave sync failed:', e);
      setSyncStatus('error', 'Sync failed');
      showToast('Unsave failed to sync', 'warning');
    }
  }

  applyFilters();        // re-sorts → moves back up into the unmodified group
  renderEditor(index);
  updateStats();
  showToast('Reset to unmodified', 'success');
}

/* ── Delete / hide a question ───────────────────── */
function requireSupabase() {
  if (!state.useSupabase) {
    showToast('Connect Supabase to delete questions', 'warning');
    return false;
  }
  return true;
}

async function deleteCurrentQuestion() {
  if (!requireSupabase()) return;
  const index = state.currentIndex;
  const q = state.questions[index];
  if (!q) return;
  const qid = q._qid;

  const ok = confirm('Hide this question for everyone? The source data file is untouched; it can be restored from Supabase.');
  if (!ok) return;

  state.hiddenQids.add(qid);
  rebuildPaperSets();
  applyFilters();
  updateStats();
  navigateToVisible();

  try {
    await state.sb.from('hidden_questions')
      .upsert({ question_id: qid, hidden_by: state.userName }, { onConflict: 'question_id' });
    showToast('Question hidden', 'success');
  } catch (e) {
    console.warn('Delete failed:', e);
    showToast('Delete failed to sync', 'warning');
  }
}

/* ── Navigation ─────────────────────────────────── */
function navigateNext() {
  const fi = state.filteredIndices;
  const pos = fi.indexOf(state.currentIndex);
  if (pos !== -1 && pos < fi.length - 1) {
    renderEditor(fi[pos + 1]);
    scrollActiveCardIntoView(fi[pos + 1]);
    return;
  }
  if (state.currentIndex + 1 < state.questions.length) {
    renderEditor(state.currentIndex + 1);
  }
}

function navigatePrev() {
  const fi = state.filteredIndices;
  const pos = fi.indexOf(state.currentIndex);
  if (pos > 0) {
    renderEditor(fi[pos - 1]);
    scrollActiveCardIntoView(fi[pos - 1]);
    return;
  }
  if (state.currentIndex > 0) {
    renderEditor(state.currentIndex - 1);
  }
}

function navigateToVisible() {
  const fi = state.filteredIndices;
  if (!fi.length) return;
  const next = fi.find(i => i > state.currentIndex);
  renderEditor(next != null ? next : fi[fi.length - 1]);
}

/* ── Filters ────────────────────────────────────── */
function onFilterChange() {
  state.filters.subject = $('filter-subject').value;
  state.filters.status  = $('filter-status').value;
  state.filters.search  = $('filter-search').value.trim();
  state.currentPage     = 1;
  applyFilters();
}

function applyFilters() {
  const { subject, status, search } = state.filters;
  const searchLower = search.toLowerCase();

  state.filteredIndices = state.questions.reduce((acc, q, i) => {
    if (state.hiddenIndexSet.has(i)) return acc;
    // Match on base subject name: source rows have subjectId:null and only a
    // broad subjectName ("Physics"); annotated rows carry "Physics 11th" etc.
    if (subject && baseSubjectName(q.subjectName) !== subject) return acc;

    if (status === 'saved'   && !state.savedIndexSet.has(i))   return acc;
    if (status === 'partial' && !state.partialIndexSet.has(i)) return acc;
    if (status === 'skipped' && !state.skippedSet.has(i))      return acc;
    if (status === 'unsaved' && (state.savedIndexSet.has(i) || state.skippedSet.has(i))) return acc;

    if (search) {
      const text = stripHtml(q.questionHtml).toLowerCase();
      if (!text.includes(searchLower)) return acc;
    }

    acc.push(i);
    return acc;
  }, []);

  // Unmodified (unsaved) questions on top, already-saved ones at the bottom.
  // Array.sort is stable, so each group keeps its natural ascending order.
  state.filteredIndices.sort((a, b) =>
    (state.savedIndexSet.has(a) ? 1 : 0) - (state.savedIndexSet.has(b) ? 1 : 0));

  renderQuestionList();
}

/* ── Question List ──────────────────────────────── */
function renderQuestionList() {
  const list  = $('question-list');
  const total = state.filteredIndices.length;
  const pages = Math.max(1, Math.ceil(total / state.PAGE_SIZE));

  if (state.currentPage > pages) state.currentPage = pages;

  const start = (state.currentPage - 1) * state.PAGE_SIZE;
  const slice = state.filteredIndices.slice(start, start + state.PAGE_SIZE);

  if (slice.length === 0) {
    list.innerHTML = `<div class="state-message">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <span>No questions match the current filters</span>
    </div>`;
  } else {
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    slice.forEach(qi => frag.appendChild(makeQuestionCard(qi)));
    list.appendChild(frag);
  }

  $('pg-info').textContent = `Page ${state.currentPage} of ${pages}  (${total} questions)`;
  $('pg-prev').disabled = state.currentPage <= 1;
  $('pg-next').disabled = state.currentPage >= pages;
}

function makeQuestionCard(index) {
  const q    = state.questions[index];
  const card = document.createElement('div');
  card.className = 'q-card' + (index === state.currentIndex ? ' active' : '');
  card.dataset.index = index;

  const isPartial = state.partialIndexSet.has(index);
  const isSaved   = state.savedIndexSet.has(index);
  const isSkipped = state.skippedSet.has(index);
  let badgeHtml;
  if (isPartial)      badgeHtml = `<span class="badge partial">⚠ Partial</span>`;
  else if (isSaved)   badgeHtml = `<span class="badge saved">✓ Saved</span>`;
  else if (isSkipped) badgeHtml = `<span class="badge skipped">⊘ Skipped</span>`;
  else                badgeHtml = `<span class="badge unsaved">○ Unsaved</span>`;

  const subjectName = getSubjectName(q.subjectId) || q.subjectName || '';
  const eb          = state.editedBy[index];
  const byText      = eb && eb.name ? `👤 ${eb.name}` : '';
  const metaParts   = [subjectName, q.difficulty, byText].filter(Boolean);
  const metaText    = metaParts.join(' · ');

  card.innerHTML = `
    <div class="q-card-left">
      <span class="q-num">${index + 1}</span>
      ${badgeHtml}
    </div>
    <div class="q-card-body">
      <div class="q-snippet">${stripHtml(q.questionHtml).slice(0, 140)}</div>
      ${metaText ? `<div class="q-meta">${metaText}</div>` : ''}
    </div>
  `;

  card.addEventListener('click', () => {
    renderEditor(index);
    ensureCardVisible(index);
  });

  return card;
}

function highlightActiveCard(index) {
  const old = document.querySelector('.q-card.active');
  if (old) old.classList.remove('active');

  const start = (state.currentPage - 1) * state.PAGE_SIZE;
  const sliceIndices = state.filteredIndices.slice(start, start + state.PAGE_SIZE);
  if (!sliceIndices.includes(index)) {
    ensureCardVisible(index);
    return;
  }

  const card = document.querySelector(`.q-card[data-index="${index}"]`);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function ensureCardVisible(index) {
  const pos = state.filteredIndices.indexOf(index);
  if (pos === -1) return;
  state.currentPage = Math.floor(pos / state.PAGE_SIZE) + 1;
  renderQuestionList();
  const card = document.querySelector(`.q-card[data-index="${index}"]`);
  if (card) card.classList.add('active');
}

function scrollActiveCardIntoView(index) {
  highlightActiveCard(index);
}

function changePage(dir) {
  const total = state.filteredIndices.length;
  const pages = Math.max(1, Math.ceil(total / state.PAGE_SIZE));
  state.currentPage = Math.min(pages, Math.max(1, state.currentPage + dir));
  renderQuestionList();
}

/* ── Stats ──────────────────────────────────────── */
function visibleCount() {
  return state.questions.length - state.hiddenIndexSet.size;
}

function updateStats() {
  const total   = visibleCount();
  const saved   = state.savedIndexSet.size;
  const skipped = state.skippedSet.size;

  $('stat-saved').textContent   = saved;
  $('stat-skipped').textContent = skipped;
  $('stat-total').textContent   = total;
  $('save-count').textContent   = `${saved} saved · ${skipped} skipped`;

  const pct = total > 0 ? (saved / total) * 100 : 0;
  $('stat-progress-bar').style.width = pct + '%';

  const paper = state.papers[state.currentPaperIndex];
  setGlobalStatus(paper ? `${paper.paperName}: ${saved} / ${total} saved` : '');
}

/* ── Export ──────────────────────────────────────
   Default: whole file, completed papers only.
   includePartial=true (TEMPORARY debug button): dump every paper regardless of
   completion — unsaved questions simply keep their original null ids/names. */
function exportJSON(todayOnly = false, includePartial = false) {
  const today = new Date().toDateString();
  const out = [];

  const isSaved = q => {
    const r = state.annotations.get(q._qid);
    return r && r.status === 'saved';
  };

  state.papers.forEach(paper => {
    const visible = (paper.questions || []).filter(q => !state.hiddenQids.has(q._qid));
    if (!visible.length) return;

    let included;
    if (includePartial) {
      // Partial dump: keep ONLY the questions that have been annotated (saved).
      included = visible.filter(isSaved);
      if (!included.length) return;              // nothing annotated in this paper
    } else {
      // Completed-only: every visible question must be saved.
      if (!visible.every(isSaved)) return;
      included = visible;
    }

    if (todayOnly) {
      const touchedToday = included.some(q => {
        const r = state.annotations.get(q._qid);
        return r && r.at && new Date(r.at).toDateString() === today;
      });
      if (!touchedToday) return;
    }

    const questions = included.map(q => {
      const { _qid, _ctx, ...rest } = q;   // strip internals; ids/names/tags already applied
      rest.id = uuidFromId(_qid || rest.id);   // emit a stable UUID (keeps its key position)
      return rest;
    });
    out.push({ ...paper, questions, questionCount: questions.length });
  });

  if (out.length === 0) {
    const msg = includePartial ? 'No papers to export'
      : todayOnly ? 'No completed papers touched today' : 'No completed papers to export';
    showToast(msg, 'warning');
    return;
  }

  const payload = { success: true, data: out };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = includePartial ? `annotated_papers_ALL_partial_${date}.json`
    : todayOnly ? `annotated_papers_today_${date}.json` : `annotated_papers_${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const qCount = out.reduce((n, p) => n + p.questions.length, 0);
  showToast(`Exported ${out.length} paper${out.length > 1 ? 's' : ''} (${qCount} questions)${includePartial ? ' — incl. partial' : ''}`, 'success');
}

/* ── LocalStorage (fallback + cache) ────────────── */
const LS_ANN    = 'neet_ann';
const LS_HIDDEN = 'neet_hidden';

function persistToLocalStorage() {
  try {
    localStorage.setItem(LS_ANN,    JSON.stringify([...state.annotations.entries()]));
    localStorage.setItem(LS_HIDDEN, JSON.stringify([...state.hiddenQids]));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      showToast('Storage full — export your data now!', 'warning');
    }
  }
}

function restoreFromLocalStorage() {
  try {
    const rawAnn    = localStorage.getItem(LS_ANN);
    const rawHidden = localStorage.getItem(LS_HIDDEN);

    if (rawAnn) {
      const entries = JSON.parse(rawAnn);
      state.annotations = new Map(entries);
    }
    if (rawHidden) {
      state.hiddenQids = new Set(JSON.parse(rawHidden));
    }

    if (state.annotations.size > 0) {
      showToast(`Restored ${state.annotations.size} saved annotations`, 'success');
    }
  } catch (e) {
    console.warn('LocalStorage restore failed:', e);
  }
}

/* ── Utilities ──────────────────────────────────── */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, '[math]')
    .replace(/\$[^$]*\$/g, '[math]')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getSubjectName(subjectId) {
  if (!subjectId || !state.topicData) return '';
  const s = (state.topicData.subjects || []).find(s => s.id === subjectId);
  return s ? s.name : '';
}

/* ── Stable UUID (deterministic from the source id) ──
   The exported `id` must be a UUID. We derive it from each question's original
   stable id so the SAME question always yields the SAME UUID — across every
   re-export and on every teammate's machine — avoiding duplicate rows on import.
   cyrb128 gives 128 well-mixed bits, formatted as an RFC-4122 (v5-style) UUID. */
function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

function uuidFromId(id) {
  const parts = cyrb128(String(id));
  const b = [];
  parts.forEach(n => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff));
  b[6] = (b[6] & 0x0f) | 0x50;   // version 5 (name-based / deterministic)
  b[8] = (b[8] & 0x3f) | 0x80;   // RFC-4122 variant
  const h = b.map(x => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

function setGlobalStatus(msg) {
  $('global-status').textContent = msg;
}

let toastTimer;
function showToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className   = 'toast' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast hidden'; }, 2200);
}

function showError(msg) {
  const html = `<div class="state-message"><strong style="color:var(--red)">Error</strong><span>${msg}</span></div>`;
  const grid = $('paper-grid');
  if (grid) grid.innerHTML = html;
  const body = $('question-body');
  if (body) body.innerHTML = html;
}
