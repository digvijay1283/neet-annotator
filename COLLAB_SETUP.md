# Team collaboration setup (Supabase)

This app now supports **3–4 people annotating at once**, with everyone's saves/skips
reflected to the others **live**. Shared data lives in a free Supabase database.

Until you configure Supabase, the app runs in **local-only mode** (the old behaviour —
data stays in your browser). The status chip in the top bar shows which mode you're in:

- `○ Local only` — not connected; data is per-browser
- `● Live` — connected; changes sync to everyone
- `▲ Sync failed / Offline` — connection problem, saving locally as a backup

---

## One-time setup (do this once for the whole team)

### 1. Create a Supabase project
1. Go to <https://supabase.com> and sign up (free).
2. **New project** → give it a name, set a database password, pick a region → **Create**.
3. Wait ~1 minute for it to provision.

### 2. Create the tables
1. In the project, open **SQL Editor** → **New query**.
2. Open [`supabase_migration_v3.sql`](supabase_migration_v3.sql) from this repo, copy
   everything, paste it in.
3. Click **Run**. You should see "Success". This creates the `annotations` and
   `hidden_questions` tables, the realtime broadcast, and access policies.

> `supabase_migration_v3.sql` is the current (and only) schema for the **paper-level**
> app. If you ran an earlier version, clear old rows first — see the note about
> `truncate` inside the v3 file (old `st-<n>` keys no longer map to any question).

### 3. Get your keys
1. **Project Settings** (gear icon) → **API**.
2. Copy the **Project URL** and the **`anon` `public`** key.

### 4. Put the keys in the app
Open [`config.js`](config.js) and replace the placeholders:

```js
window.SUPABASE_CONFIG = {
  url:     'https://YOUR-PROJECT.supabase.co',
  anonKey: 'eyJhbGciOi...your anon key...'
};
```

> The `anon` key is **safe to commit and ship in the browser** — it can only do what the
> table's Row-Level-Security policies allow (read/write the `annotations` table, nothing
> else). Never put the `service_role` key here.

### 5. Deploy
Commit and push — Netlify redeploys automatically. Share the URL with your teammates.

---

## How each person uses it
1. Open the site. On first load, enter your **name** (stored on your device; click the
   name chip in the top bar to change it).
2. The landing page shows a **card per paper** (NEET 2013, AIPMT 2012, …) with a live
   `saved / total` progress bar. Pick a paper to annotate its questions; use **← Papers**
   in the top bar to go back.
3. Annotate each question — pick Subject → Chapter → Topic (marks fill in automatically
   from the subject). Every **Save** / **Skip** writes to the shared database.
4. When a teammate saves a question, your list and the paper cards update automatically.
   Each question shows **who last edited it**.

## Conflict behaviour
**Last write wins.** If two people save the same question, the most recent save is kept,
and the question shows who did it. For a small team splitting the work this is usually
fine. If you later want per-question locking, that can be added.

## Export
- **Export completed papers** (top-right of the paper picker) downloads a single file in
  the paper-level format `{ "success": true, "data": [ …papers… ] }` — containing **only
  papers whose every question has been saved**. Each question carries the expert-filled
  `subjectId / subjectKey / chapterId / topicId / markId / markName` (plus your `tagSlugs`);
  the read-only context (`subjectName`, etc.) and runtime fields (`selectedOptionId`,
  `markedForReview`) are left untouched.
- **Export today's** limits it to completed papers touched today.

> 📦 **Losing access to the button, or need to rebuild the JSON another way?**
> See [`DATA_RECOVERY.md`](DATA_RECOVERY.md) — it explains exactly how data is stored
> in Supabase and three independent ways to regenerate the exact export (including the
> standalone `export_from_supabase.js` script, no app needed).

## Notes
- The source papers (`data/converted_papers.json`) stay static and read-only. Progress,
  and hidden questions live in Supabase keyed by each question's **real id**.
- No backend server to run — the browser talks to Supabase directly.

## Delete / hide a question
- **🗑** (in the editor toolbar) hides the current question for everyone. The source data
  file is untouched; a hidden question is excluded from its paper's progress, completion
  check, and export. Un-hide by deleting the row from the `hidden_questions` table in
  Supabase. (Adding brand-new questions was removed — the papers are fixed PYQ sets.)
