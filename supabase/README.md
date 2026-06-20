# 2yrflip — Buy Box backend (Supabase Edge Function)

The `buybox` Edge Function is the data proxy for the Buy Box tab. It parses the address
from a Zillow URL, pulls listing facts + comparable sales from **RentCast**, looks up the
**FEMA** flood zone, and returns one normalized JSON payload. Your RentCast key stays a
server-side secret; the browser only ever talks to this function.

> The frontend (GitHub Pages) works in **mock mode** without this deployed. Deploy when you
> want live data.

## One-time setup

1. **Install the Supabase CLI** (if you haven't): https://supabase.com/docs/guides/cli
2. **Get a free RentCast API key:** https://www.rentcast.io/api  (free tier ~50 req/mo)
3. From the repo root, link the function project to your Supabase project:
   ```bash
   supabase login
   supabase link --project-ref <YOUR_PROJECT_REF>
   ```
   (`<YOUR_PROJECT_REF>` is the subdomain in your project URL: `https://<ref>.supabase.co`.)

## Set secrets

```bash
supabase secrets set RENTCAST_KEY=your_rentcast_key_here
supabase secrets set APP_PASSCODE=choose-a-strong-passcode     # gates all access
supabase secrets set MONTHLY_CALL_CAP=48                       # hard cap (~22 lookups)
# Lock CORS to your Pages origin (recommended). Use * only for local testing.
supabase secrets set ALLOWED_ORIGIN=https://mustardspam.github.io
```

> Dashboard equivalent: **Edge Functions → Secrets → Add secret** for each of the above.

## Lockdown (cost + access control)

The function is protected by three layers (see `index.ts`):

1. **Passcode gate** — every request must send `x-app-pass` matching `APP_PASSCODE`. The app
   prompts you for it once and stores it in your browser. **Never commit the passcode.**
2. **Hard monthly cap** — `MONTHLY_CALL_CAP` RentCast calls/month, tracked in Postgres. The
   function refuses *before* calling RentCast once you hit it, so overage billing is impossible.
   Each lookup costs ~2 RentCast calls, so `48` ≈ ~22 lookups/month (safely under the free 50).
3. **Address cache** — repeat lookups of the same address that month are served from cache and
   don't re-bill.

**Required one-time DB setup** — run [`usage_setup.sql`](usage_setup.sql) in
**Supabase → SQL Editor** before/after deploying. It creates the usage counter + cache tables
(both RLS-locked; only the function's service role can touch them).

> Belt-and-suspenders: also set a hard usage/spend limit in your **RentCast** billing settings so
> the cap exists at the source too.

## Deploy

```bash
supabase functions deploy buybox --no-verify-jwt
```

> **`--no-verify-jwt` is required.** With JWT verification on, Supabase's gateway
> rejects the browser's CORS preflight (`OPTIONS` carries no `Authorization` header)
> with `UNAUTHORIZED_NO_AUTH_HEADER`, so the real request never fires. The function
> does its own auth via the `x-app-pass` passcode and the anon key is public anyway,
> so gateway JWT verification adds no security — it only breaks browser calls.
> `config.toml` already sets `verify_jwt = false`; the flag makes it explicit.
> **Dashboard deploys:** Edge Functions → buybox → Details → turn **Enforce JWT
> Verification** OFF.

After deploy your endpoint is:
```
https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/buybox
```

## Wire up the frontend

Edit `js/config.js` in the repo root and fill in:
```js
window.BUYBOX_CONFIG = {
  FUNCTION_URL: "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/buybox",
  SUPABASE_ANON_KEY: "<your-anon-public-key>",  // public-safe, find in Project Settings → API
  USE_MOCK: false
};
```
Set `USE_MOCK: true` any time you want to demo the tab without calling the API.

## Test the function directly

```bash
curl -X POST "https://<ref>.supabase.co/functions/v1/buybox" \
  -H "Authorization: Bearer <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.zillow.com/homedetails/123-Main-St-Houston-TX-77007/12345678_zpid/"}'
```

## Notes

- **ToS-safe:** the function only parses the address out of the Zillow URL slug — it does not
  fetch or scrape Zillow page content. All property data comes from licensed APIs (RentCast)
  and public government data (FEMA).
- **Swappable provider:** RentCast is isolated in `getListing()` / `getComps()`. To switch to
  ATTOM, Bridge/MLS, etc., change those two functions; the response shape stays the same.
- **Free tiers:** RentCast ~50 req/mo; Supabase Edge Functions 500K invocations/mo. The
  frontend caches lookups by address in `localStorage` to conserve quota.

## Lot Finder (`lotfinder` function)

The Lot Finder tab is an area search — drop a pin + radius, get back raw-land candidates
with comps already attached. It's a **sibling function in the same project**, not a separate
backend: it reads the exact same secrets (`RENTCAST_KEY`, `APP_PASSCODE`, `MONTHLY_CALL_CAP`,
`ALLOWED_ORIGIN`) and writes to the same `api_usage` / `buybox_cache` tables, so there's nothing
new to configure beyond deploying it.

**Cost control, by design:** one cheap bulk land-listing pull, then comps are fetched for at
most the top **10** candidates (by price) regardless of how many listings the radius contains.
All of that spend (1 + up to 10 calls) is reserved against the **same monthly cap** as Buy Box
via the existing `try_reserve`/`release_usage` RPCs — there is no separate budget to bypass the
lockdown already in place. Per-address comp lookups also write into `buybox_cache`, so a lot
already analyzed this month (via either tab) is served free on a repeat hit.

Deploy it the same way as `buybox`:
```bash
supabase functions deploy lotfinder --no-verify-jwt
```
(Dashboard equivalent: Edge Functions → lotfinder → Details → **Enforce JWT Verification** OFF.)

No additional SQL setup is needed — it uses the same `usage_setup.sql` tables `buybox` already
created.

Frontend wiring is in `js/config.js` under `window.LOTFINDER_CONFIG`, same shape as
`BUYBOX_CONFIG`. Set `USE_MOCK: true` to demo the map/search/results flow without calling
RentCast at all.
