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

### 2. Create the table
1. In the project, open **SQL Editor** → **New query**.
2. Open [`supabase_schema.sql`](supabase_schema.sql) from this repo, copy everything, paste it in.
3. Click **Run**. You should see "Success". This creates the `annotations` table,
   the realtime broadcast, and access policies.

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
2. Annotate as usual. Every **Save** / **Skip** writes to the shared database.
3. When a teammate saves a question, your list updates automatically and a small toast
   shows e.g. *"Priya updated Q42"*. Each question shows **who last edited it**.

## Conflict behaviour
**Last write wins.** If two people save the same question, the most recent save is kept,
and the question shows who did it. For a small team splitting the work this is usually
fine. If you later want per-question locking, that can be added.

## Notes
- The original question bank (`data/questions_data.json`) stays static and read-only.
  Team-**added** questions live in Supabase and are keyed by a stable id, so everyone
  stays in sync even as questions are added or hidden.
- **Export JSON** still works and now exports the combined team annotations.
- No backend server to run — the browser talks to Supabase directly.

---

## Add / delete questions (migration v2)

A later update added the ability to **add new questions** and **delete/hide existing
ones**, shared across the team. This needs one extra SQL migration:

1. Open **SQL Editor → New query** in Supabase.
2. Paste all of [`supabase_migration_v2.sql`](supabase_migration_v2.sql) and **Run**.

> ⚠️ This recreates the `annotations` table to key off a stable question **id**
> instead of array position. Run it **before** using the updated app, otherwise
> saving fails. It's safe when the table is empty (as it is right after first setup).

After migrating:
- **＋ Add** (top-right of the question list) opens a form: question text, up to 4
  options with a correct-answer marker, and an optional explanation. `$LaTeX$` works.
  New questions appear for everyone and can be annotated like any other.
- **🗑** (in the editor toolbar) deletes the current question. Deleting a question you
  **added** removes it; deleting an **original** question hides it for everyone (the
  data file is untouched — it can be un-hidden by deleting the row from the
  `hidden_questions` table in Supabase).
