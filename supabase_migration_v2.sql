-- ─────────────────────────────────────────────────────────────
-- MIGRATION v2 — add/delete questions + stable question ids
-- Run once in Supabase: SQL Editor → New query → paste → Run.
--
-- ⚠️  This DROPS and recreates the `annotations` table so it can be keyed by a
--     stable text id instead of array position. Safe if the table is empty
--     (it is, right after first setup). If you already have annotations you
--     care about, export them first.
-- ─────────────────────────────────────────────────────────────

-- Shared updated_at trigger (safe to re-create)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── 1. Annotations, now keyed by stable question_id ──────────
-- question_id is 'st-<n>' for original questions (position n in
-- data/questions_data.json) or the questions.id uuid for added ones.
drop table if exists public.annotations cascade;
create table public.annotations (
  question_id text primary key,
  subject_id  text,
  chapter_id  text,
  topic_id    text,
  mark_id     text,
  difficulty  text,
  tag_slugs   jsonb       not null default '[]'::jsonb,
  status      text        not null default 'saved',   -- 'saved' | 'skipped'
  edited_by   text,
  updated_at  timestamptz not null default now()
);
create trigger trg_annotations_touch
  before insert or update on public.annotations
  for each row execute function public.touch_updated_at();

-- ── 2. Team-added questions (shared question bank) ───────────
create table if not exists public.questions (
  id               uuid        primary key default gen_random_uuid(),
  question_html    text        not null,
  explanation_html text        default '',
  options          jsonb       not null default '[]'::jsonb,  -- [{ "name": "...", "answer": true|false }]
  created_by       text,
  created_at       timestamptz not null default now()
);

-- ── 3. Hidden questions (shared soft-delete of any question) ─
create table if not exists public.hidden_questions (
  question_id text        primary key,   -- same id space as annotations.question_id
  hidden_by   text,
  hidden_at   timestamptz not null default now()
);

-- ── Row Level Security + permissive anon policies (small team) ─
do $$
declare t text;
begin
  foreach t in array array['annotations','questions','hidden_questions'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "anon all" on public.%I;', t);
    execute format(
      'create policy "anon all" on public.%I for all using (true) with check (true);', t);
  end loop;
end $$;

-- ── Realtime broadcast for all three tables ──────────────────
do $$
declare t text;
begin
  foreach t in array array['annotations','questions','hidden_questions'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I;', t);
    exception when duplicate_object then
      null;  -- already added
    end;
  end loop;
end $$;
