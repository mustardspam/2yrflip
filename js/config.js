/* ============================================================
   config.js — Buy Box backend wiring (public-safe values only)
   ------------------------------------------------------------
   FUNCTION_URL + SUPABASE_ANON_KEY are safe to expose in client
   code (the anon key is designed for the browser). The RentCast
   key is NEVER here — it lives only as a Supabase function secret.

   Until you deploy the Edge Function, leave USE_MOCK = true and
   the Buy Box runs on built-in sample data so you can try it.
   ============================================================ */
window.BUYBOX_CONFIG = {
  // Supabase Edge Function endpoint (project ref: wdotsvctjpqxtvcetxdo)
  FUNCTION_URL: "https://wdotsvctjpqxtvcetxdo.supabase.co/functions/v1/buybox",

  // Project Settings → API → "anon public" key (public-safe)
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indkb3RzdmN0anBxeHR2Y2V0eGRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NzE3ODgsImV4cCI6MjA5NzA0Nzc4OH0.mfYeTYzViosD2L_qDuarm3AdIDpkcn47cjYdl29A4k8",

  // true  = use built-in sample data (no API calls) — great for demos / pre-deploy
  // false = call the live Edge Function
  // Flip to false AFTER the buybox function is deployed (Phase C).
  USE_MOCK: true
};
