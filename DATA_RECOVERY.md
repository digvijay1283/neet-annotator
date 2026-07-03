# Data & recovery guide — how annotations are stored and how to rebuild the export

> Read this if the Export button ever isn't usable, or you just need to remember
> how the pieces fit together. Nothing here can be lost as long as you have the
> Git repo + the Supabase project.

## The big idea (two halves make the whole)

The final paper-level JSON is **not** stored anywhere as one file. It's rebuilt on
demand by merging two independent sources:

```
  question content            expert's edits               final export
  (static, in the repo)   +   (in Supabase)            =   { success, data:[papers] }
  data/converted_papers.json  annotations table            (exact project format)
                              − hidden_questions table
```

- **Question content** — `data/converted_papers.json` (29 papers / 5211 questions:
  `questionHtml`, `options`, `correctOptionId`, `explanationHtml`, source
  `subjectName`, etc.). Read-only, lives in Git.
- **Expert's edits** — the Supabase `annotations` table. Only the fields the expert
  changed are stored here, keyed by each question's real `id`.
- **Hidden questions** — the Supabase `hidden_questions` table (just the `id`s that
  were hidden). Excluded from progress, completion, and export.

So: **Supabase alone can't give you the full JSON** (it has no question text). You
always merge it with `converted_papers.json`.

## What one Save writes to Supabase

One row per annotated question in `public.annotations` (upsert on `question_id`,
last-write-wins — saving again overwrites, never duplicates):

| column | meaning | example |
|---|---|---|
| `question_id` 🔑 | the question's real id | `0lkBv46IHZn6OXTW7XdU9` |
| `paper_id` | which paper | `neet-2013` |
| `subject_id` / `subject_key` | chosen subject id (key = id) | `69110d3d…2436` |
| `subject_name` | chosen subject name | `Physics 12th` |
| `chapter_id` / `chapter_name` | chosen chapter | `…2437` / `Electric Charges & Fields` |
| `topic_id` / `topic_name` | chosen topic | `…2440` / `Introduction` |
| `mark_id` / `mark_name` | auto from subject | `…24d1` / `4` |
| `difficulty` | Easy / Medium / Hard | `Hard` |
| `tag_slugs` | selected tags (jsonb) | `["pyq","conceptual"]` |
| `status` | `saved` or `skipped` | `saved` |
| `edited_by` | annotator's name | `Digvijay` |
| `updated_at` | auto (trigger) | `2026-07-02T…Z` |

Schema lives in [`supabase_migration_v3.sql`](supabase_migration_v3.sql).

## How the export is rebuilt (the merge)

For every question: take the source question, and if a `saved` annotation row exists
for its `id`, overwrite `subjectId/subjectKey/subjectName`, `chapterId/chapterName`,
`topicId/topicName`, `markId/markName`, `difficulty`, and `tagSlugs`. Leave everything
else (`questionHtml`, `options`, `correctOptionId`, `explanationHtml`,
`selectedOptionId`, `markedForReview`) untouched. Drop hidden questions.

- **Completed-only** export: keep a paper only if *every* visible question is saved.
- **Partial** export: keep only the saved questions, drop unsaved ones.

## Three ways to get the JSON (easiest → most bulletproof)

### 1. In-app Export button (normal use)
Paper picker → **Export completed papers** / **Export today's** / **⚠ Export all (partial)**.
(The export buttons are admin-gated — see [COLLAB_SETUP.md](COLLAB_SETUP.md).)

### 2. Standalone script — no app, no button
From the project folder, in a terminal (needs Node 18+, no `npm install`):
```
node export_from_supabase.js            # completed papers only
node export_from_supabase.js --partial  # every saved question so far
node export_from_supabase.js --today    # completed papers touched today
```
It reads the Supabase url + anon key from `config.js`, pages through all annotation
rows, merges with `data/converted_papers.json`, and writes `annotated_papers_<date>.json`.
Script: [`export_from_supabase.js`](export_from_supabase.js).

### 3. Raw data straight from Supabase (last resort)
Even with no app and no script, your edits are safe in the database. In the Supabase
dashboard → **SQL Editor**:
```sql
select jsonb_agg(a) from public.annotations a;      -- all edits as one JSON blob
select jsonb_agg(h) from public.hidden_questions h; -- hidden ids
```
Or Table Editor → `annotations` → **Export → CSV**. Then merge onto
`converted_papers.json` using the logic above.

## Backup habit (recommended)
Every so often run `node export_from_supabase.js --partial` and keep the output file,
or dump the `annotations` table to CSV/JSON. That's a full point-in-time backup you
hold yourself — independent of Supabase and Netlify.

## Gotchas to remember
- **Stale rows:** old `st-<n>` test rows don't match the paper-level ids and merge to
  nothing. Clear them once by uncommenting the `truncate` line in
  `supabase_migration_v3.sql`.
- **Config is the single source of truth** for the Supabase url/key — both the app and
  the script read `config.js`.
- **Names vs ids:** on Save, both the id *and* the name are written for
  subject/chapter/topic, so the exported name always matches the chosen id.
