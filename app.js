/* ── State ──────────────────────────────────────── */
const state = {
  questions:      [],
  topicData:      null,
  tagList:        [],
  currentIndex:   0,
  savedQuestions: [],
  savedIndexSet:  new Set(),
  skippedSet:     new Set(),
  filters:        { subject: '', status: 'all', search: '' },
  currentPage:    1,
  PAGE_SIZE:      15,
  filteredIndices: [],
  // ── Collaboration ──
  userName:       '',            // who is annotating (from name prompt)
  editedBy:       {},            // array index → { name, at }
  sb:             null,          // Supabase client
  useSupabase:    false,         // false → local-only fallback
  // ── Question identity (stable across users) ──
  qidToIndex:     new Map(),     // stable question id → current array index
  hiddenQids:     new Set(),     // ids soft-deleted for everyone
  hiddenIndexSet: new Set()      // array indices currently hidden
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
  populateSubjectDropdowns();
  populateTagDropdown();

  initSupabase();                  // connect shared storage (or fall back)
  await loadRemoteQuestions();     // pull team-added questions + hidden list
  await loadAnnotations();         // pull team progress from Supabase / local

  applyFilters();
  renderEditor(state.currentIndex);
  updateStats();

  attachEvents();
  subscribeRealtime();             // live updates from other users
  setGlobalStatus(`${state.questions.length} questions loaded`);
}

/* ── Data Loading ───────────────────────────────── */
async function loadData() {
  const [qRes, tRes, tagRes] = await Promise.all([
    fetch('./data/questions_data.json'),
    fetch('./data/topic.txt'),
    fetch('./data/tags.json').catch(() => null)   // optional
  ]);
  if (!qRes.ok) throw new Error('questions_data.json not found');
  if (!tRes.ok) throw new Error('topic.txt not found');
  state.questions = await qRes.json();
  state.topicData = await tRes.json();

  // Give every original question a stable id ('st-<position>') so annotations
  // key off identity, not array position — survives added/deleted questions.
  state.questions.forEach((q, i) => { q._qid = 'st-' + i; q._added = false; });

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

/* ── Question identity helpers ──────────────────── */
function buildQidIndex() {
  state.qidToIndex = new Map();
  state.questions.forEach((q, i) => state.qidToIndex.set(q._qid, i));
}

function indexOfQid(qid) {
  return state.qidToIndex.has(qid) ? state.qidToIndex.get(qid) : -1;
}

function qidOf(index) {
  const q = state.questions[index];
  return q ? q._qid : null;
}

function recomputeHidden() {
  state.hiddenIndexSet = new Set();
  state.questions.forEach((q, i) => {
    if (state.hiddenQids.has(q._qid)) state.hiddenIndexSet.add(i);
  });
}

function visibleCount() {
  return state.questions.length - state.hiddenIndexSet.size;
}

// Turn a `questions` table row into an in-memory question and append it.
function appendAddedQuestion(row) {
  if (state.qidToIndex.has(row.id)) return;   // already present
  state.questions.push({
    subjectId:       null,
    chapterId:       null,
    topicId:         null,
    markId:          null,
    difficulty:      'Medium',
    questionHtml:    row.question_html,
    explanationHtml: row.explanation_html || '',
    options:         Array.isArray(row.options) ? row.options : [],
    tagSlugs:        [],
    _qid:            row.id,
    _added:          true,
    _createdBy:      row.created_by
  });
}

/* ── Load team-added questions + hidden list ────── */
async function loadRemoteQuestions() {
  if (!state.useSupabase) { buildQidIndex(); recomputeHidden(); return; }
  try {
    const [qRes, hRes] = await Promise.all([
      state.sb.from('questions').select('*').order('created_at', { ascending: true }),
      state.sb.from('hidden_questions').select('question_id')
    ]);
    if (qRes.error) throw qRes.error;
    if (hRes.error) throw hRes.error;

    (qRes.data || []).forEach(row => appendAddedQuestion(row));
    state.hiddenQids = new Set((hRes.data || []).map(h => h.question_id));
    buildQidIndex();
    recomputeHidden();

    const added = (qRes.data || []).length;
    if (added) showToast(`Loaded ${added} team-added question${added > 1 ? 's' : ''}`, 'success');
  } catch (e) {
    console.warn('Loading remote questions failed:', e);
    buildQidIndex();
    recomputeHidden();
  }
}

async function loadAnnotations() {
  if (!state.useSupabase) { restoreFromLocalStorage(); return; }

  setSyncStatus('online', 'Syncing…');
  try {
    const { data, error } = await state.sb.from('annotations').select('*');
    if (error) throw error;

    state.savedQuestions = [];
    state.savedIndexSet  = new Set();
    state.skippedSet     = new Set();
    state.editedBy       = {};
    (data || []).forEach(row => applyRow(row));

    restoreCurrentIndex();
    setSyncStatus('online', 'Live');
    if (state.savedQuestions.length) {
      showToast(`Loaded ${state.savedQuestions.length} annotations from the team`, 'success');
    }
  } catch (e) {
    console.warn('Supabase load failed — falling back to local:', e);
    state.useSupabase = false;
    setSyncStatus('error', 'Offline (local)');
    restoreFromLocalStorage();
  }
}

// Apply one DB row into local state (used by initial load AND realtime).
function applyRow(row) {
  const idx = indexOfQid(row.question_id);
  if (idx < 0) return;

  state.editedBy[idx] = { name: row.edited_by || '?', at: row.updated_at };
  const pos = state.savedQuestions.findIndex(s => s._originalIndex === idx);

  if (row.status === 'skipped') {
    state.skippedSet.add(idx);
    state.savedIndexSet.delete(idx);
    if (pos !== -1) state.savedQuestions.splice(pos, 1);
    return;
  }

  const q = state.questions[idx] || {};
  const annotated = {
    subjectId:       row.subject_id,
    chapterId:       row.chapter_id,
    topicId:         row.topic_id,
    markId:          row.mark_id,
    difficulty:      row.difficulty || 'Medium',
    questionHtml:    q.questionHtml,
    explanationHtml: q.explanationHtml,
    options:         q.options,
    tagSlugs:        Array.isArray(row.tag_slugs) ? row.tag_slugs : [],
    _originalIndex:  idx,
    _savedAt:        row.updated_at
  };
  if (pos !== -1) state.savedQuestions[pos] = annotated;
  else            state.savedQuestions.push(annotated);
  state.savedIndexSet.add(idx);
  state.skippedSet.delete(idx);
}

function removeRow(qid) {
  const idx = indexOfQid(qid);
  if (idx < 0) return;
  state.savedIndexSet.delete(idx);
  state.skippedSet.delete(idx);
  delete state.editedBy[idx];
  const pos = state.savedQuestions.findIndex(s => s._originalIndex === idx);
  if (pos !== -1) state.savedQuestions.splice(pos, 1);
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

// Live updates: another user's save/skip/add/delete lands here.
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
          const idx = isDelete ? removeRowReturnIndex(row.question_id) : applyRowReturnIndex(row);

          applyFilters();
          if (idx === state.currentIndex) renderEditor(idx);
          updateStats();

          if (!isDelete && idx >= 0 && row.edited_by && row.edited_by !== state.userName) {
            showToast(`${row.edited_by} updated Q${idx + 1}`, '');
          }
        })
    // New questions added by teammates
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'questions' },
        payload => {
          appendAddedQuestion(payload.new);
          buildQidIndex();
          recomputeHidden();
          applyFilters();
          updateStats();
          if (payload.new.created_by && payload.new.created_by !== state.userName) {
            showToast(`${payload.new.created_by} added a question`, '');
          }
        })
    // A teammate hard-deleted a question they had added
    .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'questions' },
        payload => { hideQidLocally(payload.old.id); })
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

// Realtime helpers that also report the affected array index.
function applyRowReturnIndex(row) { applyRow(row); return indexOfQid(row.question_id); }
function removeRowReturnIndex(qid) { const i = indexOfQid(qid); removeRow(qid); return i; }

// Hide a question locally (from a remote hide/delete) without shifting indices.
function hideQidLocally(qid) {
  if (!qid || state.hiddenQids.has(qid)) return;
  state.hiddenQids.add(qid);
  recomputeHidden();
  applyFilters();
  updateStats();
  if (indexOfQid(qid) === state.currentIndex) navigateToVisible();
}

function unhideQidLocally(qid) {
  if (!state.hiddenQids.has(qid)) return;
  state.hiddenQids.delete(qid);
  recomputeHidden();
  applyFilters();
  updateStats();
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
  $('btn-save').addEventListener('click', saveQuestion);
  $('btn-prev').addEventListener('click', navigatePrev);
  $('btn-skip').addEventListener('click', skipQuestion);
  $('btn-export').addEventListener('click', () => exportJSON(false));
  $('btn-export-today').addEventListener('click', () => exportJSON(true));

  $('btn-add-question').addEventListener('click', openAddQuestion);
  $('btn-delete').addEventListener('click', deleteCurrentQuestion);
  $('addq-submit').addEventListener('click', submitAddQuestion);
  $('addq-cancel').addEventListener('click', closeAddQuestion);

  $('sel-subject').addEventListener('change', onSubjectChange);
  $('sel-chapter').addEventListener('change', onChapterChange);

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

/* ── Subject Dropdowns ──────────────────────────── */
function populateSubjectDropdowns() {
  const subjects = state.topicData.subjects;
  const editorSel = $('sel-subject');
  const filterSel = $('filter-subject');

  subjects.forEach(s => {
    editorSel.appendChild(makeOption(s.id, s.name));
    filterSel.appendChild(makeOption(s.id, s.name));
  });
}

/* ── Tag Pills (multi-select) ───────────────────── */
function populateTagDropdown() {
  const container = $('tag-pills');
  container.innerHTML = '';

  // Build the list of { slug, name } to show as pills.
  let tags;
  if (state.tagList.length) {
    // Preferred source: canonical tag list from data/tags.json.
    tags = state.tagList.map(t => ({ slug: t.slug, name: t.name }));
  } else {
    // Fallback: derive the unique set of tag slugs from the loaded questions.
    const set = new Set();
    state.questions.forEach(q => (q.tagSlugs || []).forEach(t => set.add(t)));
    const sorted = [...set].sort((a, b) => {
      const ay = parseInt((a.match(/\d+/) || [])[0], 10);
      const by = parseInt((b.match(/\d+/) || [])[0], 10);
      if (!isNaN(ay) && !isNaN(by)) return by - ay;
      return a.localeCompare(b);
    });
    tags = sorted.map(slug => ({ slug, name: prettifyTag(slug) }));
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
    });
    container.appendChild(pill);
  });
}

// Read the currently selected tag slugs from the pills.
function getSelectedTags() {
  return [...document.querySelectorAll('#tag-pills .tag-pill.selected')]
    .map(p => p.dataset.slug);
}

// Set which pills are selected (used when pre-filling a saved question).
function setSelectedTags(slugs) {
  const wanted = new Set(slugs || []);
  document.querySelectorAll('#tag-pills .tag-pill').forEach(p => {
    const on = wanted.has(p.dataset.slug);
    p.classList.toggle('selected', on);
    p.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function prettifyTag(slug) {
  // "pyq-2000" → "PYQ 2000"
  return slug
    .split('-')
    .map(part => (/^\d+$/.test(part) ? part : part.toUpperCase()))
    .join(' ');
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

  // Reset chapter
  chapterSel.innerHTML = '<option value="">— Select Chapter —</option>';
  chapterSel.disabled = true;

  // Reset topic
  topicSel.innerHTML = '<option value="">— Select Topic —</option>';
  topicSel.disabled = true;

  // Marks
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

  // Counter
  $('q-num').textContent   = index + 1;
  $('q-total').textContent = state.questions.length;

  // Show an "Added" tag for team-added questions, and enable delete accordingly.
  const addedTag = $('badge-added');
  if (addedTag) addedTag.style.display = q._added ? '' : 'none';

  // Status badge
  const badgeEl = $('badge-status');
  if (state.savedIndexSet.has(index)) {
    badgeEl.className = 'badge saved'; badgeEl.textContent = '✓ Saved';
  } else if (state.skippedSet.has(index)) {
    badgeEl.className = 'badge skipped'; badgeEl.textContent = '⊘ Skipped';
  } else {
    badgeEl.className = 'badge unsaved'; badgeEl.textContent = '○ Unsaved';
  }

  // Who last edited this question (from the shared DB)
  const eb = state.editedBy[index];
  $('edited-by').textContent = eb && eb.name ? `edited by ${eb.name}` : '';

  // Question HTML
  $('question-body').innerHTML = q.questionHtml || '<em>No question text</em>';
  renderKaTeX('question-body');

  // Options
  renderOptions(q.options || []);

  // Explanation
  $('explanation-body').innerHTML = q.explanationHtml || '<em>No explanation</em>';
  // KaTeX rendered lazily when explanation opens
  $('explanation-toggle').removeAttribute('open');
  $('explanation-toggle').addEventListener('toggle', function onToggle() {
    if ($('explanation-toggle').open) {
      renderKaTeX('explanation-body');
      $('explanation-toggle').removeEventListener('toggle', onToggle);
    }
  }, { once: true });

  // Pre-fill form
  prefillForm(index);

  // Highlight active card in list
  highlightActiveCard(index);
}

function renderOptions(options) {
  const list = $('options-list');
  list.innerHTML = '';
  const labels = ['A', 'B', 'C', 'D', 'E'];
  options.forEach((opt, i) => {
    const li = document.createElement('li');
    if (opt.answer) li.classList.add('correct');
    li.innerHTML = `<span class="opt-label">${labels[i] || i + 1}</span><span>${opt.name}</span>`;
    list.appendChild(li);
  });
  renderKaTeX('options-list');
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
  // Check if we have a saved version with overridden values
  let subjectId, chapterId, topicId, difficulty, tagSlugs = [];

  if (state.savedIndexSet.has(index)) {
    const savedQ = state.savedQuestions.find(q => q._originalIndex === index);
    if (savedQ) {
      subjectId  = savedQ.subjectId  || '';
      chapterId  = savedQ.chapterId  || '';
      topicId    = savedQ.topicId    || '';
      difficulty = savedQ.difficulty || 'Medium';
      tagSlugs   = savedQ.tagSlugs || [];
    }
  } else {
    const q = state.questions[index];
    subjectId  = q.subjectId  || '';
    chapterId  = q.chapterId  || '';
    topicId    = q.topicId    || '';
    difficulty = q.difficulty || 'Medium';
    tagSlugs   = q.tagSlugs || [];
  }

  // Set subject and trigger cascade
  $('sel-subject').value = subjectId;
  onSubjectChange();

  if (chapterId) {
    $('sel-chapter').value = chapterId;
    onChapterChange();
    if (topicId) {
      $('sel-topic').value = topicId;
    }
  }

  $('sel-difficulty').value = difficulty || 'Medium';
  setSelectedTags(tagSlugs);
}

/* ── Save ───────────────────────────────────────── */
function saveQuestion() {
  const index      = state.currentIndex;
  const q          = state.questions[index];
  const subjectId  = $('sel-subject').value  || null;
  const chapterId  = $('sel-chapter').value  || null;
  const topicId    = $('sel-topic').value    || null;
  const difficulty = $('sel-difficulty').value;
  const tags       = getSelectedTags();
  const markId     = subjectId ? (state.topicData.marks?.[subjectId]?.id || null) : null;

  const annotated = {
    subjectId,
    chapterId,
    topicId,
    markId,
    difficulty,
    questionHtml:    q.questionHtml,
    explanationHtml: q.explanationHtml,
    options:         q.options,
    tagSlugs:        tags,
    _originalIndex:  index,                 // internal, stripped on export
    _savedAt:        new Date().toISOString() // internal, stripped on export
  };

  if (state.savedIndexSet.has(index)) {
    const pos = state.savedQuestions.findIndex(s => s._originalIndex === index);
    if (pos !== -1) state.savedQuestions[pos] = annotated;
  } else {
    state.savedQuestions.push(annotated);
    state.savedIndexSet.add(index);
  }

  // Remove from skipped if it was skipped
  state.skippedSet.delete(index);

  // Record & sync who edited this question.
  state.editedBy[index] = { name: state.userName, at: annotated._savedAt };
  upsertAnnotation({
    question_id:    qidOf(index),
    subject_id:     subjectId,
    chapter_id:     chapterId,
    topic_id:       topicId,
    mark_id:        markId,
    difficulty,
    tag_slugs:      tags,
    status:         'saved',
    edited_by:      state.userName
  });

  updateStats();
  showToast('Saved!', 'success');
  renderQuestionList();
  navigateNext();
}

/* ── Skip ───────────────────────────────────────── */
function skipQuestion() {
  const index = state.currentIndex;
  if (!state.savedIndexSet.has(index)) {
    state.skippedSet.add(index);
    state.editedBy[index] = { name: state.userName, at: new Date().toISOString() };
    upsertAnnotation({
      question_id: qidOf(index),
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

/* ── Add / Delete Questions ─────────────────────── */
function requireSupabase() {
  if (!state.useSupabase) {
    showToast('Connect Supabase to add or delete questions', 'warning');
    return false;
  }
  return true;
}

function openAddQuestion() {
  if (!requireSupabase()) return;
  $('addq-question').value    = '';
  $('addq-explanation').value = '';
  ['a', 'b', 'c', 'd'].forEach(k => { $('addq-opt-' + k).value = ''; });
  const first = document.querySelector('input[name="addq-correct"][value="0"]');
  if (first) first.checked = true;
  $('addq-modal').classList.remove('hidden');
  setTimeout(() => $('addq-question').focus(), 50);
}

function closeAddQuestion() {
  $('addq-modal').classList.add('hidden');
}

async function submitAddQuestion() {
  const qhtml = $('addq-question').value.trim();
  if (!qhtml) { showToast('Question text is required', 'warning'); return; }

  const keys = ['a', 'b', 'c', 'd'];
  const checked = document.querySelector('input[name="addq-correct"]:checked');
  const correctIdx = checked ? parseInt(checked.value, 10) : 0;

  const options = [];
  keys.forEach((k, i) => {
    const name = $('addq-opt-' + k).value.trim();
    if (name) options.push({ name, answer: i === correctIdx });
  });
  if (options.length < 2) { showToast('Add at least two options', 'warning'); return; }
  if (!options.some(o => o.answer)) options[0].answer = true;   // safety: ensure one correct

  const explanation = $('addq-explanation').value.trim();
  const btn = $('addq-submit');
  btn.disabled = true;
  try {
    const { data, error } = await state.sb.from('questions').insert({
      question_html:    qhtml,
      explanation_html: explanation,
      options,
      created_by:       state.userName
    }).select().single();
    if (error) throw error;

    appendAddedQuestion(data);
    buildQidIndex();
    recomputeHidden();
    closeAddQuestion();
    applyFilters();
    updateStats();
    showToast('Question added', 'success');
    const idx = indexOfQid(data.id);
    renderEditor(idx);
    ensureCardVisible(idx);
  } catch (e) {
    console.warn('Add question failed:', e);
    showToast('Failed to add question', 'warning');
  } finally {
    btn.disabled = false;
  }
}

async function deleteCurrentQuestion() {
  if (!requireSupabase()) return;
  const index = state.currentIndex;
  const q = state.questions[index];
  if (!q) return;
  const qid = q._qid;

  const ok = confirm(q._added
    ? 'Delete this added question for everyone? This cannot be undone from the app.'
    : 'Hide this question for everyone? The original data file is untouched; it can be restored from Supabase.');
  if (!ok) return;

  // Optimistically hide locally (no index shift), then sync.
  state.hiddenQids.add(qid);
  recomputeHidden();
  applyFilters();
  updateStats();
  navigateToVisible();

  try {
    if (q._added) {
      await state.sb.from('questions').delete().eq('id', qid);
      await state.sb.from('annotations').delete().eq('question_id', qid);
    } else {
      await state.sb.from('hidden_questions')
        .upsert({ question_id: qid, hidden_by: state.userName }, { onConflict: 'question_id' });
    }
    showToast('Question deleted', 'success');
  } catch (e) {
    console.warn('Delete failed:', e);
    showToast('Delete failed to sync', 'warning');
  }
}

/* ── Navigation ─────────────────────────────────── */
function navigateNext() {
  // Find next question in filtered list after current
  const fi = state.filteredIndices;
  const pos = fi.indexOf(state.currentIndex);
  if (pos !== -1 && pos < fi.length - 1) {
    renderEditor(fi[pos + 1]);
    scrollActiveCardIntoView(fi[pos + 1]);
    return;
  }
  // Fallback: linear next
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

// Move to the nearest visible question (used after the current one is hidden).
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
    // Hidden (soft-deleted) questions never appear
    if (state.hiddenIndexSet.has(i)) return acc;

    // Subject filter
    if (subject && q.subjectId !== subject) return acc;

    // Status filter
    if (status === 'saved'   && !state.savedIndexSet.has(i))  return acc;
    if (status === 'skipped' && !state.skippedSet.has(i))     return acc;
    if (status === 'unsaved' && (state.savedIndexSet.has(i) || state.skippedSet.has(i))) return acc;

    // Search filter
    if (search) {
      const text = stripHtml(q.questionHtml).toLowerCase();
      if (!text.includes(searchLower)) return acc;
    }

    acc.push(i);
    return acc;
  }, []);

  renderQuestionList();
}

/* ── Question List ──────────────────────────────── */
function renderQuestionList() {
  const list  = $('question-list');
  const total = state.filteredIndices.length;
  const pages = Math.max(1, Math.ceil(total / state.PAGE_SIZE));

  // Clamp page
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
    slice.forEach(qi => {
      frag.appendChild(makeQuestionCard(qi));
    });
    list.appendChild(frag);
  }

  // Pagination controls
  $('pg-info').textContent = `Page ${state.currentPage} of ${pages}  (${total} questions)`;
  $('pg-prev').disabled = state.currentPage <= 1;
  $('pg-next').disabled = state.currentPage >= pages;
}

function makeQuestionCard(index) {
  const q    = state.questions[index];
  const card = document.createElement('div');
  card.className = 'q-card' + (index === state.currentIndex ? ' active' : '');
  card.dataset.index = index;

  const isSaved   = state.savedIndexSet.has(index);
  const isSkipped = state.skippedSet.has(index);
  let badgeHtml;
  if (isSaved)        badgeHtml = `<span class="badge saved">✓ Saved</span>`;
  else if (isSkipped) badgeHtml = `<span class="badge skipped">⊘ Skipped</span>`;
  else                badgeHtml = `<span class="badge unsaved">○ Unsaved</span>`;

  const subjectName = getSubjectName(q.subjectId);
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
    // Ensure card page is correct
    ensureCardVisible(index);
  });

  return card;
}

function highlightActiveCard(index) {
  // Remove old active
  const old = document.querySelector('.q-card.active');
  if (old) old.classList.remove('active');

  // Check if current page shows this card
  const start = (state.currentPage - 1) * state.PAGE_SIZE;
  const sliceIndices = state.filteredIndices.slice(start, start + state.PAGE_SIZE);
  if (!sliceIndices.includes(index)) {
    // Navigate to the correct page
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
  // After re-render, highlight
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
function updateStats() {
  const total   = visibleCount();
  const saved   = state.savedQuestions.length;
  const skipped = state.skippedSet.size;

  $('stat-saved').textContent   = saved;
  $('stat-skipped').textContent = skipped;
  $('stat-total').textContent   = total;
  $('save-count').textContent   = `${saved} saved · ${skipped} skipped`;

  const pct = total > 0 ? (saved / total) * 100 : 0;
  $('stat-progress-bar').style.width = pct + '%';

  setGlobalStatus(`${saved} / ${total} saved`);
}

/* ── Export ─────────────────────────────────────── */
function exportJSON(todayOnly = false) {
  let source = state.savedQuestions;

  if (todayOnly) {
    const today = new Date().toDateString();
    source = source.filter(q => q._savedAt && new Date(q._savedAt).toDateString() === today);
    if (source.length === 0) {
      showToast('No questions changed today', 'warning');
      return;
    }
  } else if (source.length === 0) {
    showToast('No saved questions to export', 'warning');
    return;
  }

  // Strip internal fields before export
  const clean = source.map(q => {
    const { _originalIndex, _savedAt, ...rest } = q;
    return rest;
  });

  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = todayOnly
    ? `annotated_questions_today_${date}.json`
    : `annotated_questions_${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Exported ${clean.length} questions`, 'success');
}

/* ── LocalStorage ───────────────────────────────── */
const LS_SAVED   = 'neet_saved';
const LS_SKIPPED = 'neet_skipped';
const LS_INDEX   = 'neet_index';

function persistToLocalStorage() {
  try {
    localStorage.setItem(LS_SAVED,   JSON.stringify(state.savedQuestions));
    localStorage.setItem(LS_SKIPPED, JSON.stringify([...state.skippedSet]));
    localStorage.setItem(LS_INDEX,   JSON.stringify(state.currentIndex));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      showToast('Storage full — export your data now!', 'warning');
    }
  }
}

function restoreCurrentIndex() {
  try {
    const rawIndex = localStorage.getItem(LS_INDEX);
    if (rawIndex !== null) {
      const idx = JSON.parse(rawIndex);
      if (idx >= 0 && idx < state.questions.length) state.currentIndex = idx;
    }
  } catch (e) { /* ignore */ }
}

function restoreFromLocalStorage() {
  try {
    const rawSaved   = localStorage.getItem(LS_SAVED);
    const rawSkipped = localStorage.getItem(LS_SKIPPED);
    const rawIndex   = localStorage.getItem(LS_INDEX);

    if (rawSaved) {
      const savedArr = JSON.parse(rawSaved);
      // Build a map from questionHtml → original index for fast matching
      const htmlToIndex = new Map();
      state.questions.forEach((q, i) => htmlToIndex.set(q.questionHtml, i));

      state.savedQuestions = savedArr;
      state.savedIndexSet  = new Set();

      savedArr.forEach(sq => {
        // Prefer stored _originalIndex; fallback to HTML matching
        if (sq._originalIndex !== undefined) {
          state.savedIndexSet.add(sq._originalIndex);
        } else {
          const idx = htmlToIndex.get(sq.questionHtml);
          if (idx !== undefined) {
            sq._originalIndex = idx;
            state.savedIndexSet.add(idx);
          }
        }
      });
    }

    if (rawSkipped) {
      state.skippedSet = new Set(JSON.parse(rawSkipped));
    }

    if (rawIndex !== null) {
      const idx = JSON.parse(rawIndex);
      if (idx >= 0 && idx < state.questions.length) {
        state.currentIndex = idx;
      }
    }

    const restoredCount = state.savedQuestions.length;
    if (restoredCount > 0) {
      showToast(`Restored ${restoredCount} saved questions`, 'success');
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

function getSubjectName(subjectId) {
  if (!subjectId || !state.topicData) return '';
  const s = state.topicData.subjects.find(s => s.id === subjectId);
  return s ? s.name : '';
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
  $('question-body').innerHTML = `<div class="state-message"><strong style="color:var(--red)">Error</strong><span>${msg}</span></div>`;
}
