-- ─────────────────────────────────────────────────────────────
-- NEET Annotator — shared annotations schema
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run
-- ─────────────────────────────────────────────────────────────

-- One row per annotated question. `question_index` is the position of the
-- question in data/questions_data.json — the same for every user, since
-- everyone loads the identical static file. That makes it a stable shared key.
create table if not exists public.annotations (
  question_index integer primary key,
  subject_id     text,
  chapter_id     text,
  topic_id       text,
  mark_id        text,
  difficulty     text,
  tag_slugs      jsonb       not null default '[]'::jsonb,
  status         text        not null default 'saved',  -- 'saved' | 'skipped'
  edited_by      text,                                   -- the name the user typed
  updated_at     timestamptz not null default now()
);

-- Keep updated_at fresh on every upsert.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_annotations_touch on public.annotations;
create trigger trg_annotations_touch
  before insert or update on public.annotations
  for each row execute function public.touch_updated_at();

-- ── Row Level Security ───────────────────────────────────────
-- We use "name prompt only" (no real accounts), so the browser talks to
-- Supabase with the anon key. These policies let anon read + write the
-- annotations table (and nothing else). Fine for a small trusted team.
-- Tighten later if you switch to real auth.
alter table public.annotations enable row level security;

drop policy if exists "anon read"   on public.annotations;
drop policy if exists "anon insert" on public.annotations;
drop policy if exists "anon update" on public.annotations;
drop policy if exists "anon delete" on public.annotations;

create policy "anon read"   on public.annotations for select using (true);
create policy "anon insert" on public.annotations for insert with check (true);
create policy "anon update" on public.annotations for update using (true) with check (true);
create policy "anon delete" on public.annotations for delete using (true);

-- ── Realtime ─────────────────────────────────────────────────
-- Broadcast INSERT/UPDATE/DELETE so other users' apps update live.
alter publication supabase_realtime add table public.annotations;
