// Supabase connection for the production app's live drafts, autosave, and
// the "Today" board. Not a secret file — the anon key is meant to be public
// (Supabase's Row Level Security, or lack of it — see supabase/schema.sql —
// is what actually gates access, the same way the anon key in any Supabase
// browser app is public by design).
//
// Fill these in after creating the project (Project Settings → API):
//   SUPABASE_URL       "Project URL", e.g. https://abcdefgh.supabase.co
//   SUPABASE_ANON_KEY   "anon" "public" key (NOT the service_role key —
//                        that one must never appear in a browser file)
//
// Left blank, the app runs in "no drafts" mode: forms submit in one shot
// like before instead of autosaving, and the dashboard reads the static
// data/production/*.json files instead of live Supabase data. That keeps
// the site working before you've created a Supabase project, and keeps
// local preview working with zero setup.

const SUPABASE_URL = 'https://ugtxmyciyuelxxzqmrdx.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_vQOGvetjSzPx1UaaCS8FUQ_kZGgywo5';
