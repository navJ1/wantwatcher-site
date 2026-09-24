/* WantWatcher Supabase config.
 *
 * Fill these in on deploy (or via Netlify snippet injection) with the values
 * from your free Supabase project dashboard: Project Settings → API.
 * Both values are PUBLIC-SAFE (the anon key is designed for client-side use;
 * row-level security in supabase/schema.sql is what protects user data).
 * The service-role key must NEVER be placed here or in any client code.
 *
 * Until real values are supplied, dashboard.html shows a friendly
 * "coming soon" panel instead of breaking.
 */
window.WANTWATCHER_SUPABASE = {
  url: "https://YOUR-PROJECT-REF.supabase.co",
  anonKey: "YOUR-SUPABASE-ANON-KEY"
};
