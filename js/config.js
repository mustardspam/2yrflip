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
  // After `supabase functions deploy buybox`, paste:
  //   https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/buybox
  FUNCTION_URL: "",

  // Project Settings → API → "anon public" key (public-safe)
  SUPABASE_ANON_KEY: "",

  // true  = use built-in sample data (no API calls) — great for demos / pre-deploy
  // false = call the live Edge Function
  USE_MOCK: true
};
