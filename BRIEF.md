# Project Brief: Lot Finder (2yrflip module)

## Goal
A new tab in the existing 2yrflip app that flips the Buy Box workflow: instead of pasting one lot URL and getting one analysis, you drop a pin on a map of the Greater Houston area, set a search radius, and define your build/equity parameters once. The system pulls raw-land listings in that area, estimates each one's ARV from nearby finished-home comps, runs the exact same equity-capture math as Buy Box, and returns a ranked list of lots that actually clear your target — so instead of analyzing one candidate at a time, you discover candidates.

## Tech Stack
- Same as the rest of 2yrflip: vanilla HTML/CSS/JS, no build step, no framework
- Map: **Leaflet.js + OpenStreetMap tiles** (free, no API key, no Google Maps billing surface to manage)
- Data: RentCast (land listings + AVM comps, same provider as Buy Box) + FEMA NFHL (reused as-is)
- Backend: new Supabase Edge Function `lotfinder`, sibling to the existing `buybox` function, same project (`wdotsvctjpqxtvcetxdo`)
- Deployment: GitHub Pages (same site, new tab) + Supabase Edge Functions

## Core Features (MVP)

1. **Map + area picker**: Leaflet map centered on Greater Houston. Click to drop a center pin (or type an address to geocode/center on it). A radius slider (0.5–10 miles, default 3) draws a circle overlay showing the search area.
2. **Parameter panel**: reuses the existing Buy Box "Build assumptions" and "Permanent financing" fields verbatim (planned sqft, cost/sqft, appreciation, hold months, filing status, sell/acq closing %, carry %, demo cost, LTCG rate, mortgage rate/term, property tax/insurance/PMI rates) — same defaults, same inputs, so results are apples-to-apples with manual Buy Box lookups. Adds two new filter-only fields on top: **target after-tax equity (min $)** and **max lot price (optional)**.
3. **"Search this area" button**: shows a confirmation ("This may use up to N RentCast calls against your monthly cap") before firing, then calls the `lotfinder` Edge Function with `{lat, lng, radiusMiles, maxLotPrice}`.
4. **Edge Function behavior** (cost-bounded by design):
   - One RentCast `/listings/sale?propertyType=Land&latitude&longitude&radius` call returns all raw-land listings in the circle (address, price, lot size, lat/lng) — this is the cheap bulk pull, regardless of how many listings exist.
   - Listings are pre-ranked by a comp-free heuristic (ascending price, optionally filtered by `maxLotPrice`) and capped to the top **K=10** candidates (constant, tunable).
   - Only those K candidates get a real AVM comp lookup (`getComps()`, reused as-is from `buybox/index.ts`) — this is the expensive part, and it's hard-capped at K regardless of search radius or listing count.
   - All calls (1 bulk pull + up to K AVM calls) are reserved atomically against the **same existing monthly cap** (`try_reserve`/`release_usage`) used by Buy Box — no separate budget, no way to bypass the lockdown that's already in place.
   - Returns `{candidates: [{listing, comps}, ...]}` — raw data only, no scoring math server-side.
5. **Client-side scoring**: the frontend runs each candidate through the **same `computeDeal()`** used by Buy Box (extracted into a shared module — see Constraints) using the user's entered assumptions, then filters to candidates meeting the target equity, and sorts by after-tax equity descending.
6. **Results list**: cards (reusing Buy Box's dial/badge visual language) showing address, lot price, projected after-tax equity, score, verdict. Below-target candidates are hidden by default with a "show N more below target" toggle.
7. **Map pins**: each result also gets a pin on the map, color-coded by verdict (go/caution/pass), clickable to highlight the matching list card.
8. **Click a result → loads it into Buy Box**: reuses the existing `loadInto()`-style flow from `buybox.js` to populate the Buy Box tab with that lot's listing + comp data, then switches tabs — giving the full waterfall, §121 checklist, and financing breakdown without rebuilding that UI.

## UI & Layout
Same visual system as the rest of the app (`.panel`, `.field-grid`, `.bb-*` component classes, gold/navy palette). Layout: left column = map + area controls stacked above the parameter panel (mirrors Buy Box's input-panel position); right column = results list (mirrors Buy Box's results-panel, sticky on scroll). Map height ~400px, full-width within its column. Result cards keep List view as the primary surface — the map is for spatial context, not the primary read.

## Data Model
- **Search params**: `{centerLat, centerLng, radiusMiles, maxLotPrice, targetEquity}` + the full Buy Box `assumptions` object (reused, not duplicated)
- **Land listing** (from bulk pull): `{address, askingPrice, lotSizeSqft, lat, lng, propertyType}`
- **Comp set** (from AVM, per candidate): same shape as Buy Box's `comps.compDetails` — `{medianPerSqft, count, lowPerSqft, highPerSqft, compDetails: [{address, price, sqft, psf, distance}]}`
- **Candidate result** (client-computed): `{listing, comps, deal: <computeDeal() output>}`

## File & Folder Structure
```
js/
  buybox.js
  lotfinder.js          (new — tab module, follows buybox.js's IIFE + window.X.tab pattern)
  dealMath.js            (new — computeDeal() extracted from buybox.js so both tabs share one
                           source of truth for the equity-capture model; buybox.js imports it instead
                           of defining it inline)
css/
  buybox.css
  lotfinder.css          (new — map container, area controls, result-card list, pin styling)
supabase/functions/
  buybox/index.ts
  lotfinder/index.ts      (new — bulk land-listing pull + capped comp shortlist, shares the same
                            usage_setup.sql cap/cache tables via the existing try_reserve/release_usage RPCs)
index.html               (add <script src="js/dealMath.js">, <script src="js/lotfinder.js">,
                           Leaflet CDN <link>/<script> tags, new tab entry)
```

## Constraints & Rules
- **No separate RentCast budget.** Lot Finder draws from the exact same monthly cap as Buy Box. A single area search must never be able to silently blow through the remaining monthly allowance — the K=10 comp-call cap is a hard ceiling regardless of how large the search radius or how many listings come back.
- **Center pin + radius only for v1** — no freeform polygon drawing. Keeps the map UI and backend filtering (RentCast's native lat/lng/radius search) simple; polygon drawing is an explicit non-goal for now.
- **`computeDeal()` must be shared, not duplicated.** Extract it from `buybox.js` into `dealMath.js` as a first task, before building Lot Finder, so Buy Box and Lot Finder can never drift into scoring two lots differently.
- **Leaflet/OSM only** — no Google Maps, no API key to manage or bill.
- **Same passcode gate** (`x-app-pass`) as the existing `buybox` function — Lot Finder is not a new attack surface for the billing concern that drove the original lockdown.
- **No server-side persistence in v1** — every search is live; nothing is cached or scheduled. (A nightly-snapshot cache was considered and explicitly deferred — see Out of Scope.)

## Out of Scope (for now)
- Freeform polygon boundary drawing
- Cached/scheduled background searches (nightly snapshot jobs)
- Saved searches or alerts ("notify me when a new lot matches")
- Any comp source beyond what RentCast's AVM already returns (no MLS/off-market scraping)
- Search areas outside Greater Houston (no nationwide geocoding UI)

## Task List
1. Extract `computeDeal()` (and its supporting constants: `EXCLUSION`, `ROI_TARGET`, `LOT_FLOOR`/`LOT_CEIL`, etc.) out of `buybox.js` into `js/dealMath.js` as `window.DealMath.computeDeal(listing, assumptions)`. Update `buybox.js` to call it instead of defining it inline. Verify Buy Box still produces identical output (regression check).
2. Add the Leaflet CDN tags to `index.html` and register the new "Lot Finder" tab (same `App.registerTab` pattern as the other tabs).
3. Build `lotfinder.js` skeleton: tab init, map render with a center pin (click-to-drop) and radius slider, parameter panel reusing the same `field()` builder helpers as `buybox.js` (import the Buy Box assumption defaults rather than re-declaring them).
4. Build `supabase/functions/lotfinder/index.ts`: bulk land-listing pull via RentCast `/listings/sale?propertyType=Land`, price-based pre-rank, cap to top K, run `getComps()` (copy/share from `buybox/index.ts`) on the capped shortlist, reserve/release against the existing cap tables.
5. Wire the frontend "Search this area" button: confirmation dialog showing worst-case call count, fetch to the new Edge Function, run each returned candidate through `DealMath.computeDeal()`, filter by target equity, sort by after-tax equity.
6. Build the results list UI (cards) and map pins (color-coded by verdict), reusing Buy Box's dial/badge/chip CSS classes where they fit.
7. Wire "click a result → load into Buy Box": adapt the existing `loadInto()` pattern from `buybox.js` to accept a Lot Finder candidate and switch tabs.
8. Manual test pass: a real Greater Houston radius search end-to-end, confirm RentCast call count matches the pre-search estimate exactly, confirm the monthly cap counter increments correctly and unused reservations release.
9. Commit, update README with the new Edge Function's setup/deploy steps (mirroring the existing `buybox` section).

## Notes
- The K=10 comp-call cap is a starting constant, not a hard product requirement — easy to tune up/down once you see real search costs against the monthly cap.
- The "cheap pre-rank without comps" heuristic (sort by ascending price) is a placeholder — there's no zip-level $/sqft data in `zipDefaults.js` today to do anything smarter without spending a comp call. If this misses good candidates in practice, a smarter heuristic (e.g. price per acre vs area norms) can be layered in later without touching the cost-control design.
- Reusing Buy Box's assumption fields verbatim means a Lot Finder search and a manual Buy Box lookup of the same address should always agree — that consistency is the reason `dealMath.js` extraction is task #1, not an afterthought.
- "Center pin + radius" was chosen explicitly over polygon drawing for build simplicity; if it turns out you regularly want irregular shapes (e.g. excluding a specific subdivision), that's the natural Phase 2 ask.
