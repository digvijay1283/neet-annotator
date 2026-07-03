#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────
   Standalone exporter — rebuild the paper-level JSON WITHOUT the app.
   A safety net for if the Export button ever isn't usable.

   It does exactly what the in-app export does:
     source questions (data/converted_papers.json)
       +  expert edits (Supabase `annotations` table)
       −  hidden questions (Supabase `hidden_questions` table)
       =  { success: true, data: [ ...papers... ] }

   Usage (from the project folder):
     node export_from_supabase.js            # completed papers only (all questions saved)
     node export_from_supabase.js --partial  # every SAVED question, unsaved ones omitted
     node export_from_supabase.js --today     # completed papers touched today

   Requirements: Node 18+ (built-in fetch). No `npm install` needed.
   It reads your Supabase url + anon key straight from config.js.
   ───────────────────────────────────────────────────────────── */
const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC  = path.join(ROOT, 'data', 'converted_papers.json');

// Pull the Supabase url + anon key out of config.js (single source of truth).
function readConfig() {
  const txt = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  const url = (txt.match(/url:\s*'([^']+)'/)     || [])[1];
  const key = (txt.match(/anonKey:\s*'([^']+)'/) || [])[1];
  if (!url || !key) throw new Error('Could not read url/anonKey from config.js');
  return { url: url.replace(/\/+$/, ''), key };
}

// Fetch an entire table, paging past PostgREST's 1000-row default.
async function fetchAll(base, key, table) {
  const rows = [], pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(
      `${base}/rest/v1/${table}?select=*&limit=${pageSize}&offset=${offset}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) throw new Error(`${table} fetch failed: ${res.status} ${await res.text()}`);
    const chunk = await res.json();
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
  }
  return rows;
}

// Overlay a saved annotation row onto a source question (ids + names + tags).
function merge(q, r) {
  const out = { ...q };
  if (r && r.status === 'saved') {
    out.subjectId   = r.subject_id;
    out.subjectKey  = r.subject_key || r.subject_id;
    out.subjectName = r.subject_name;
    out.chapterId   = r.chapter_id;
    out.chapterName = r.chapter_name;
    out.topicId     = r.topic_id;
    out.topicName   = r.topic_name;
    out.markId      = r.mark_id;
    out.markName    = r.mark_name;
    out.difficulty  = r.difficulty;
    out.tagSlugs    = Array.isArray(r.tag_slugs) ? r.tag_slugs : [];
  }
  return out;
}

(async () => {
  const args      = process.argv.slice(2);
  const partial   = args.includes('--partial');
  const todayOnly = args.includes('--today');

  const { url, key } = readConfig();
  const file   = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const papers = Array.isArray(file) ? file : (file.data || []);

  console.log('Fetching annotations from Supabase…');
  const [annRows, hiddenRows] = await Promise.all([
    fetchAll(url, key, 'annotations'),
    fetchAll(url, key, 'hidden_questions')
  ]);
  const ann    = new Map(annRows.map(r => [r.question_id, r]));
  const hidden = new Set(hiddenRows.map(h => h.question_id));
  console.log(`  ${ann.size} annotation rows, ${hidden.size} hidden.`);

  const today   = new Date().toDateString();
  const isSaved = q => { const r = ann.get(q.id); return r && r.status === 'saved'; };
  const out     = [];

  for (const paper of papers) {
    const visible = (paper.questions || []).filter(q => !hidden.has(q.id));
    if (!visible.length) continue;

    let included;
    if (partial) {
      included = visible.filter(isSaved);
      if (!included.length) continue;                 // nothing annotated in this paper
    } else {
      if (!visible.every(isSaved)) continue;          // completed-only
      included = visible;
    }

    if (todayOnly) {
      const touched = included.some(q => {
        const r = ann.get(q.id);
        return r && r.updated_at && new Date(r.updated_at).toDateString() === today;
      });
      if (!touched) continue;
    }

    const questions = included.map(q => merge(q, ann.get(q.id)));
    out.push({ ...paper, questions, questionCount: questions.length });
  }

  if (!out.length) {
    console.error('No papers matched the criteria — nothing written.');
    process.exitCode = 1;
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const name = partial   ? `annotated_papers_ALL_partial_${date}.json`
             : todayOnly ? `annotated_papers_today_${date}.json`
             :             `annotated_papers_${date}.json`;
  fs.writeFileSync(path.join(ROOT, name), JSON.stringify({ success: true, data: out }, null, 2));

  const qn = out.reduce((n, p) => n + p.questions.length, 0);
  console.log(`✔ Wrote ${name} — ${out.length} paper(s), ${qn} question(s).`);
})().catch(e => { console.error('ERROR:', e.message); process.exitCode = 1; });
