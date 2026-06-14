# 2yrflip — Section 121 Equity Calculator

A zero-backend web app for a builder/developer who rotates primary residences every ~2 years to
harvest equity tax-free under **IRC §121** ($250K single / $500K married-filing-jointly). Enter a
personal build's lot cost, construction cost, and local comps, and the tool projects net proceeds
and lets you compare multiple ZIP markets side-by-side to find the highest-gain play.

The core calculator is no accounts, no server, no build step — a single `index.html` plus static
CSS/JS. Open it from `file://` or deploy it to GitHub Pages with one push. The optional **Buy Box**
tab adds a single free serverless function (Supabase Edge Function) for live listing data; it runs
in mock mode until you deploy that.

> ⚠️ **Estimates only — not tax advice.** Confirm §121 eligibility (2-of-5-year use/ownership test,
> once-every-2-years limit) and tax treatment with a CPA before acting.

---

## Features (MVP)

- **Live deal calculator** — every keystroke recomputes basis, ARV, gross equity, closing costs,
  and net proceeds.
- **Equity meter** — the centerpiece: a horizontal bar showing basis (navy) vs. tax-free gain
  (gold) with a red striped **over-§121** zone and a limit marker.
- **§121 logic** — flags when gross equity exceeds the exclusion and estimates LT cap-gains tax
  (15%) on the overage.
- **Saved scenarios** — persisted in `localStorage`; each ZIP/deal becomes a card.
- **Side-by-side comparison** — pick up to 4 scenarios; highest value per row is highlighted.
- **ZIP appreciation defaults** — Houston-area lookup table; unknown ZIPs fall back to 3.5%.
- **Copy summary** — plain-text deal memo to clipboard; clean print/PDF stylesheet.
- **Buy Box** — drop a Zillow URL (or enter manually); get a **Maximum Allowable Offer**, a
  0–100 deal **score**, and a green/yellow/red verdict from comps, build cost, closing costs,
  §121 fit, and FEMA flood zone. See [Buy Box](#buy-box) below.

---

## Run locally

It's fully static. Easiest: just double-click `index.html` (works over `file://`).

For a local server (optional), use anything that serves static files from the repo root, e.g.:

```bash
# Python
python -m http.server 8080
# Node
npx serve .
```

Then open `http://localhost:8080`.

---

## Deploy to GitHub Pages

This repo is already structured for Pages (entry point `index.html` at the root).

1. Push to GitHub (e.g. via **GitHub Desktop** → Commit → Push, or `git push`).
2. On github.com, open the repo → **Settings** → **Pages**.
3. Under **Build and deployment**, set **Source = Deploy from a branch**.
4. Choose **Branch: `main`**, **Folder: `/ (root)`**, then **Save**.
5. Wait ~1 minute. Your site goes live at:
   `https://<your-username>.github.io/2yrflip/`

Every later `git push` to `main` auto-redeploys.

---

## Project structure

```
/
  index.html          entry point + tab shell
  css/
    main.css          design tokens, reset, header/tabs, layout, toast
    calculator.css    input panel, results grid, equity meter, cards
    compare.css       comparison table
    print.css         print / print-to-PDF stylesheet
  js/
    config.js         Buy Box backend wiring (public-safe; mock toggle)
    utils.js          formatting + DOM helpers (window.Utils)
    zipDefaults.js    Houston ZIP → appreciation rate table (window.ZipDefaults)
    storage.js        localStorage persistence (window.Store)
    calculator.js     calc engine + results/meter + deal memo (window.Calculator)
    scenarios.js      saved scenario cards (window.Scenarios)
    compare.js        side-by-side comparison (window.Compare)
    buybox.js         Buy Box tab: intake, MAO, scoring, verdict (window.BuyBox)
    app.js            tab router (registerTab pattern) + shell (window.App)
  supabase/
    functions/buybox/index.ts   Edge Function: URL→address, RentCast + FEMA proxy
    README.md                   backend deploy + secrets guide
  README.md
```

---

## Calculations

```
construction   = sqft × cost/sqft
basis          = lotCost + construction
ARV at listing = sqft × ARV/sqft × (1 + appreciationRate)^(holdMonths / 12)
grossEquity    = ARV − basis
closingCosts   = ARV × closingCostPct        (default 7%, editable)
netProceeds    = ARV − basis − closingCosts
§121 limit     = 500,000 (MFJ) | 250,000 (Single)
headroom       = limit − grossEquity         (red if negative)
taxOnExcess    = max(0, grossEquity − limit) × 15%
estNetInPocket = netProceeds − taxOnExcess
```

Net proceeds assume tax-free treatment up to the exclusion; any gain above the limit is shown as a
secondary "estimated tax on excess" line at the 15% long-term capital-gains rate.

---

## Data notes

- **ZIP appreciation rates** (`js/zipDefaults.js`) are blended FHFA MSA + HAR neighborhood
  averages, **source year 2025**. They're planning defaults, not guarantees — update annually and
  override per-deal as needed.
- **Closing costs** default to 7% (~3% buyer agent + title + misc). Post-NAR-settlement this may be
  negotiable; the field is editable so you can model 5–6%.
- **localStorage key:** `s121_scenarios` (JSON array of scenario objects).

---

## Buy Box

The **Buy Box** tab evaluates a prospective purchase (a lot or teardown you'd build on):

1. Paste a **Zillow URL** and hit **Analyze** — or type the address/price/comps by hand.
2. It pulls listing facts + comparable sales (RentCast) and the **FEMA flood zone**, then
   computes a **Maximum Allowable Offer (MAO)** — the most you can pay and still hit your target
   profit while staying §121-friendly — plus a **0–100 score** and a **Pursue / Maybe / Pass**
   verdict.
3. **Save** analyses (localStorage key `s121_buybox`) or **Send to Calculator** to model deeper.

**MAO formula** (acquisition closing is a % of the price, hence the divisor):
```
ARV          = plannedSqft × compMedian$/sqft × (1+appr)^(hold/12)
MAO          = (ARV − buildCost − demo − sellClosing − targetProfit) / (1 + acqClosing%)
gap          = MAO − askingPrice          (positive = room to buy)
score (100)  = margin(50) + ARV-confidence(15) + §121-fit(15) + flood(20)
verdict      = score ≥ 75 & gap > 0 → Pursue · ≥ 50 → Maybe · else Pass
```

### Backend (required for live data)

Live data flows through a **Supabase Edge Function** (`supabase/functions/buybox`) so your
RentCast API key stays server-side and CORS is handled. The frontend ships in **mock mode**
(`js/config.js` → `USE_MOCK: true`) so the tab is fully usable before you deploy.

To go live: deploy the function and fill in `js/config.js`. Full steps in
[`supabase/README.md`](supabase/README.md). Quick version:
```bash
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
supabase secrets set RENTCAST_KEY=...   ALLOWED_ORIGIN=https://mustardspam.github.io
supabase functions deploy buybox
# then set FUNCTION_URL + SUPABASE_ANON_KEY and USE_MOCK:false in js/config.js
```

> **ToS note:** the function only parses the address out of the Zillow URL slug — it does **not**
> scrape Zillow page content. All property data comes from licensed APIs (RentCast) and public
> government data (FEMA NFHL).

## Phase 2 (designed for, not built)

The tab bar and `App.registerTab(id, label, initFn)` pattern leave room for:

- **Lot Pipeline** — prospective lots by status, linked to scenarios, HCAD parcel lookup
- **Job Budget** — per-project trade line items, change orders, actuals vs. budget
- **Portfolio** — roll-up across active projects: aggregate equity, exposure, projected net

Each will load as its own module behind a reserved tab; no changes to existing modules required.
