-- ─────────────────────────────────────────────────────────────
-- MIGRATION v3 — paper-level annotator
-- Run once in Supabase: SQL Editor → New query → paste → Run.
--
-- What changed vs v2:
--   • Annotations are now keyed by the REAL question id from
--     data/converted_papers.json (globally unique text id) instead of
--     the old 'st-<n>' positional id.
--   • Adds paper_id / subject_key / subject_name / chapter_name /
--     topic_name / mark_name columns so the shared row carries everything
--     the export needs (the expert's chosen ids AND names).
--   • The "Add question" feature was dropped, so the public.questions
--     table is no longer used by the app (left in place, harmless).
--
-- ⚠️  Old rows key off the meaningless 'st-<n>' ids. Clear them first
--     (uncomment the TRUNCATE below) so progress starts clean.
-- ─────────────────────────────────────────────────────────────

-- Shared updated_at trigger (safe to re-create)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── Annotations (keyed by real question id) ──────────────────
create table if not exists public.annotations (
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

-- New columns added in v3 (safe to run repeatedly)
alter table public.annotations add column if not exists paper_id     text;
alter table public.annotations add column if not exists subject_key  text;
alter table public.annotations add column if not exists subject_name text;
alter table public.annotations add column if not exists chapter_name text;
alter table public.annotations add column if not exists topic_name   text;
alter table public.annotations add column if not exists mark_name    text;

drop trigger if exists trg_annotations_touch on public.annotations;
create trigger trg_annotations_touch
  before insert or update on public.annotations
  for each row execute function public.touch_updated_at();

-- ⚠️ Clear stale v1/v2 rows (old 'st-<n>' keys). Uncomment to wipe:
-- truncate table public.annotations;

-- ── Hidden questions (shared soft-delete, real id space) ─────
create table if not exists public.hidden_questions (
  question_id text        primary key,
  hidden_by   text,
  hidden_at   timestamptz not null default now()
);

-- ── Row Level Security + permissive anon policies (small team) ─
do $$
declare t text;
begin
  foreach t in array array['annotations','hidden_questions'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "anon all" on public.%I;', t);
    execute format(
      'create policy "anon all" on public.%I for all using (true) with check (true);', t);
  end loop;
end $$;

-- ── Realtime broadcast ───────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['annotations','hidden_questions'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I;', t);
    exception when duplicate_object then
      null;  -- already added
    end;
  end loop;
end $$;
