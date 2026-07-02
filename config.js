/* ─────────────────────────────────────────────────────────────
   Supabase configuration
   ─────────────────────────────────────────────────────────────
   1. Create a free project at https://supabase.com
   2. In the dashboard: Project Settings → API
   3. Copy "Project URL" and the "anon / public" key below.

   The anon key is SAFE to commit / ship in the browser — it only
   grants what your Row-Level-Security policies allow (see
   supabase_migration_v3.sql). Do NOT put the "service_role" key here.

   If you leave these as the placeholder values, the app falls back
   to local-only mode (localStorage) so it still works offline.
   ───────────────────────────────────────────────────────────── */
window.SUPABASE_CONFIG = {
  url:     'https://fgvulzrdylicsmoogsas.supabase.co',       // e.g. https://abcdefgh.supabase.co
  anonKey: 'sb_publishable_q08IrytkRbskMk6ma_twVQ__P3oW_mj'   // the long "anon public" JWT
};
