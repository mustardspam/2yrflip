# 2yrflip — Section 121 Equity Calculator

A zero-backend web app for a builder/developer who rotates primary residences every ~2 years to
harvest equity tax-free under **IRC §121** ($250K single / $500K married-filing-jointly). Enter a
personal build's lot cost, construction cost, and local comps, and the tool projects net proceeds
and lets you compare multiple ZIP markets side-by-side to find the highest-gain play.

No accounts, no server, no build step — a single `index.html` plus static CSS/JS. Open it from
`file://` or deploy it to GitHub Pages with one push.

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
    utils.js          formatting + DOM helpers (window.Utils)
    zipDefaults.js    Houston ZIP → appreciation rate table (window.ZipDefaults)
    storage.js        localStorage persistence (window.Store)
    calculator.js     calc engine + results/meter + deal memo (window.Calculator)
    scenarios.js      saved scenario cards (window.Scenarios)
    compare.js        side-by-side comparison (window.Compare)
    app.js            tab router (registerTab pattern) + shell (window.App)
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

## Phase 2 (designed for, not built)

The tab bar and `App.registerTab(id, label, initFn)` pattern leave room for:

- **Lot Pipeline** — prospective lots by status, linked to scenarios, HCAD parcel lookup
- **Job Budget** — per-project trade line items, change orders, actuals vs. budget
- **Portfolio** — roll-up across active projects: aggregate equity, exposure, projected net

Each will load as its own module behind a reserved tab; no changes to existing modules required.
