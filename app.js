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
  filteredIndices: []
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

  restoreFromLocalStorage();
  populateSubjectDropdowns();
  populateTagDropdown();
  applyFilters();
  renderEditor(state.currentIndex);
  updateStats();

  attachEvents();
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

  // Tags file is optional — accept either the raw array or the API envelope.
  if (tagRes && tagRes.ok) {
    const tagJson = await tagRes.json();
    state.tagList = Array.isArray(tagJson) ? tagJson : (tagJson.data || []);
  }
}

/* ── Event Listeners ────────────────────────────── */
function attachEvents() {
  $('btn-save').addEventListener('click', saveQuestion);
  $('btn-prev').addEventListener('click', navigatePrev);
  $('btn-skip').addEventListener('click', skipQuestion);
  $('btn-export').addEventListener('click', () => exportJSON(false));
  $('btn-export-today').addEventListener('click', () => exportJSON(true));

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

/* ── Tag Dropdown ───────────────────────────────── */
function populateTagDropdown() {
  const tagSel = $('sel-tag');

  // Preferred source: the canonical tag list from data/tags.json ({ slug, name }).
  if (state.tagList.length) {
    state.tagList.forEach(t => tagSel.appendChild(makeOption(t.slug, t.name)));
    return;
  }

  // Fallback: derive the unique set of tag slugs from the loaded questions.
  const tags = new Set();
  state.questions.forEach(q => (q.tagSlugs || []).forEach(t => tags.add(t)));

  // Sort: newest PYQ year first, then any other slug alphabetically.
  const sorted = [...tags].sort((a, b) => {
    const ay = parseInt((a.match(/\d+/) || [])[0], 10);
    const by = parseInt((b.match(/\d+/) || [])[0], 10);
    if (!isNaN(ay) && !isNaN(by)) return by - ay;
    return a.localeCompare(b);
  });

  sorted.forEach(slug => tagSel.appendChild(makeOption(slug, prettifyTag(slug))));
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

  // Status badge
  const badgeEl = $('badge-status');
  if (state.savedIndexSet.has(index)) {
    badgeEl.className = 'badge saved'; badgeEl.textContent = '✓ Saved';
  } else if (state.skippedSet.has(index)) {
    badgeEl.className = 'badge skipped'; badgeEl.textContent = '⊘ Skipped';
  } else {
    badgeEl.className = 'badge unsaved'; badgeEl.textContent = '○ Unsaved';
  }

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
  let subjectId, chapterId, topicId, difficulty, tag;

  if (state.savedIndexSet.has(index)) {
    const savedQ = state.savedQuestions.find(q => q._originalIndex === index);
    if (savedQ) {
      subjectId  = savedQ.subjectId  || '';
      chapterId  = savedQ.chapterId  || '';
      topicId    = savedQ.topicId    || '';
      difficulty = savedQ.difficulty || 'Medium';
      tag        = (savedQ.tagSlugs || [])[0] || '';
    }
  } else {
    const q = state.questions[index];
    subjectId  = q.subjectId  || '';
    chapterId  = q.chapterId  || '';
    topicId    = q.topicId    || '';
    difficulty = q.difficulty || 'Medium';
    tag        = (q.tagSlugs || [])[0] || '';
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
  $('sel-tag').value = tag || '';
}

/* ── Save ───────────────────────────────────────── */
function saveQuestion() {
  const index      = state.currentIndex;
  const q          = state.questions[index];
  const subjectId  = $('sel-subject').value  || null;
  const chapterId  = $('sel-chapter').value  || null;
  const topicId    = $('sel-topic').value    || null;
  const difficulty = $('sel-difficulty').value;
  const tag        = $('sel-tag').value || '';
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
    tagSlugs:        tag ? [tag] : [],
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

  persistToLocalStorage();
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
  }
  persistToLocalStorage();
  renderQuestionList();
  updateStats();
  navigateNext();
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
  const metaText    = subjectName ? `${subjectName}${q.difficulty ? ' · ' + q.difficulty : ''}` : '';

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
  const total   = state.questions.length;
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
