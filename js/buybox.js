/* ============================================================
   buybox.js — "Buy Box" tab (window.BuyBox)
   URL/manual intake -> live MAO + 0-100 deal score + verdict.
   Reuses Calculator.compute() for the §121 check.
   ============================================================ */
(function () {
  "use strict";

  var U = window.Utils;
  var STORE_KEY = "s121_buybox";

  var FLOOD_ZONES = [
    ["X", "X — minimal risk"],
    ["X500", "X (shaded) — moderate"],
    ["A", "A — high risk (SFHA)"],
    ["AE", "AE — high risk (SFHA)"],
    ["AH", "AH — high risk (SFHA)"],
    ["AO", "AO — high risk (SFHA)"],
    ["A99", "A99 — high risk (SFHA)"],
    ["V", "V — coastal high risk"],
    ["VE", "VE — coastal high risk"],
    ["D", "D — undetermined"],
    ["UNKNOWN", "Unknown"]
  ];

  var DEF = window.Calculator ? window.Calculator.DEFAULTS : {};
  var EXCLUSION = (window.Calculator && window.Calculator.EXCLUSION) || { single: 250000, mfj: 500000 };

  // tunable scoring constants
  var ROI_TARGET = 0.20;          // annualized after-tax ROI for full marks
  var GO_ROI_MIN = 0.12;          // min annualized ROI to allow a GO verdict
  var LOT_FLOOR = 0.12;           // lot-to-ARV at/below = full "lot room" marks
  var LOT_CEIL = 0.30;            // lot-to-ARV at/above = zero "lot room"
  var DEFAULT_DISPERSION = 0.25;  // comp spread assumed when the API range is missing

  var ASSUMPTION_DEFAULTS = {
    plannedSqft: DEF.sqft || 3000,
    costPerSqft: DEF.costPerSqft || 165,
    appreciationRate: DEF.appreciationRate || 0.035,
    holdMonths: DEF.holdMonths || 24,
    filingStatus: DEF.filingStatus || "mfj",
    sellClosingPct: DEF.closingCostPct || 0.07,
    acqClosingPct: 0.015,
    carryPct: 0.03,      // annual carry: property tax + insurance + utilities (non-deductible, NOT in tax basis)
    demoCost: 0,
    ltcgRate: 0.15,      // assumed LT cap-gains rate on gain above the §121 cap
    // permanent financing (construction loan rolls into this at completion)
    mortgageRate: 0.065,
    mortgageTermYears: 30,
    propertyTaxRate: 0.018,   // annual, % of value at completion
    homeInsuranceRate: 0.0045,// annual, % of value at completion
    pmiRate: 0.006            // annual, % of loan — applied only when LTV > 80%
  };

  var ELIG_CHECKS = [
    "Will own the property 2+ years before selling",
    "Will occupy as primary residence 24+ months (use-test clock starts at move-in, not lot purchase)",
    "Haven't claimed §121 in the past 2 years",
    "No non-qualified use (e.g., rental period before move-in)"
  ];
  var eligChecked = [false, false, false, false];

  var listing = {            // editable listing facts (from API/mock or manual)
    url: "", address: "", askingPrice: 0, compPsf: 0,
    compCount: 0, lowPsf: 0, highPsf: 0, asOf: null,
    floodZone: "X", lat: null, lng: null, compDetails: []
  };
  var assumptions = Object.assign({}, ASSUMPTION_DEFAULTS);

  var els = {};              // input element refs
  var resultHost = null, savedHost = null, statusHost = null;

  function pctInput(dec) { return Math.round(U.parseNum(dec) * 100 * 1e4) / 1e4; }

  // ---- compute -------------------------------------------------------
  // Forward equity-capture projection for a RAW-LAND build:
  // buy lot (asking = cost) -> build -> hold ~2yr -> sell. Reports the real
  // equity captured and how much of it §121 shelters tax-free.
  // Economic track (carry INCLUDED) and tax track (carry EXCLUDED) are kept
  // separate — tax gain is structurally larger than real profit by the carry.
  function computeDeal() {
    var a = assumptions, L = listing;
    var lot = U.parseNum(L.askingPrice);          // lot price from URL = acquisition cost
    var compPsf = U.parseNum(L.compPsf);
    var sqft = U.parseNum(a.plannedSqft);
    var holdYears = U.parseNum(a.holdMonths) / 12; // single source of truth for appr + carry

    // --- cost stack (capitalized basis) ---
    var construction = sqft * U.parseNum(a.costPerSqft);
    var acqClosing = lot * U.parseNum(a.acqClosingPct);     // on the LOT, not ARV
    var demo = U.parseNum(a.demoCost);
    var allInBasis = lot + acqClosing + construction + demo; // = adjusted tax basis

    // --- value + sale ---
    var factor = Math.pow(1 + U.parseNum(a.appreciationRate), holdYears);
    var arv = sqft * compPsf * factor;             // appreciation hits finished value once
    var sellClosing = arv * U.parseNum(a.sellClosingPct);   // on ARV (sale price)
    var netSaleProceeds = arv - sellClosing;       // = amount realized

    // --- carry (economic only — NOT in tax basis, NOT deductible) ---
    var carry = allInBasis * U.parseNum(a.carryPct) * holdYears;

    // --- economic track ---
    var economicEquityPreTax = arv - allInBasis - carry - sellClosing;
    var cashInvested = allInBasis + carry;         // ROI denominator (unleveraged)

    // --- tax track (§121) ---
    var limit = EXCLUSION[a.filingStatus] || EXCLUSION.mfj;
    var ltcg = U.parseNum(a.ltcgRate);
    var taxGain = netSaleProceeds - allInBasis;    // carry excluded; selling exp netted once
    var excludedGain = Math.min(Math.max(0, taxGain), limit);
    var taxableExcess = Math.max(0, taxGain - limit);
    var taxOnExcess = taxableExcess * ltcg;
    var headroom = limit - Math.max(0, taxGain);   // §121 cap room left
    var overLimit = taxGain > limit;
    // worst case if the use/occupancy test fails: the ENTIRE gain is taxable
    var taxIfNoExclusion = Math.max(0, taxGain) * ltcg;

    var economicEquityAfterTax = economicEquityPreTax - taxOnExcess;

    // --- permanent financing -------------------------------------------
    // Construction-to-perm: lot bought cash (collateral for the construction
    // loan); at completion the loan rolls into a traditional mortgage sized
    // to just the construction cost — the cash-bought lot is the borrower's
    // equity, so it "takes a chunk out of the loan" rather than being financed.
    var valueAtCompletion = sqft * compPsf;              // appraised value when built, BEFORE the 2yr hold's appreciation
    var landEquity = lot + acqClosing;                    // cash already in; reduces what must be borrowed
    var loanAmount = Math.max(0, construction + demo);
    var ltvAtCompletion = valueAtCompletion > 0 ? loanAmount / valueAtCompletion : null;
    var pmiApplies = ltvAtCompletion != null && ltvAtCompletion > 0.80;

    var monthlyRate = U.parseNum(a.mortgageRate) / 12;
    var termMonths = U.parseNum(a.mortgageTermYears) * 12;
    var monthlyPI = termMonths > 0
      ? (monthlyRate > 0
          ? loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1)
          : loanAmount / termMonths)
      : 0;
    var monthlyTax = valueAtCompletion * U.parseNum(a.propertyTaxRate) / 12;
    var monthlyInsurance = valueAtCompletion * U.parseNum(a.homeInsuranceRate) / 12;
    var monthlyPMI = pmiApplies ? loanAmount * U.parseNum(a.pmiRate) / 12 : 0;
    var monthlyPITI = monthlyPI + monthlyTax + monthlyInsurance + monthlyPMI;

    // --- returns ---
    var roi = cashInvested > 0 ? economicEquityAfterTax / cashInvested : null;
    var annualizedRoi = (roi != null && (1 + roi) > 0 && holdYears > 0)
      ? Math.pow(1 + roi, 1 / holdYears) - 1 : null;

    // --- confidence / risk inputs (never enter the dollar waterfall) ---
    var compCount = U.parseNum(L.compCount);
    var lowPsf = U.parseNum(L.lowPsf), highPsf = U.parseNum(L.highPsf);
    // FIX: missing range (high<=low, incl. 0,0) must score conservatively, not as perfect tightness
    var dispersion = compPsf <= 0 ? 1 : (highPsf <= lowPsf ? DEFAULT_DISPERSION : (highPsf - lowPsf) / compPsf);
    var lotToArv = arv > 0 ? lot / arv : 1;
    var noComps = compCount <= 0 || compPsf <= 0;

    // downside ARV at the low comp $/sqft
    var arvLow = sqft * lowPsf * factor;
    var equityLow = arvLow - allInBasis - carry - (arvLow * U.parseNum(a.sellClosingPct));

    // "what can I afford to build" — breakeven build budget for this lot+comp
    var maxBuildBudget = arv > 0
      ? arv * (1 - U.parseNum(a.sellClosingPct)) / (1 + U.parseNum(a.carryPct) * holdYears) - (lot + acqClosing)
      : 0;
    var maxSqft = U.parseNum(a.costPerSqft) > 0 ? maxBuildBudget / U.parseNum(a.costPerSqft) : 0;

    // ----- scoring (100) -----
    var parts = {};
    parts.equity = economicEquityAfterTax <= 0 ? 0 : U.clamp(economicEquityAfterTax / limit, 0, 1) * 45;
    parts.roi = (annualizedRoi == null || annualizedRoi <= 0) ? 0 : U.clamp(annualizedRoi / ROI_TARGET, 0, 1) * 15;
    parts.arvConf = noComps ? 0 : (U.clamp(compCount / 8, 0, 1) * 8 + U.clamp(1 - dispersion / 0.5, 0, 1) * 7);
    parts.lotRoom = economicEquityAfterTax <= 0 ? 0
      : U.clamp(1 - (lotToArv - LOT_FLOOR) / (LOT_CEIL - LOT_FLOOR), 0, 1) * 10;
    parts.s121 = taxGain <= 0 ? 0 : (taxGain <= limit ? 8 : U.clamp(limit / taxGain, 0, 1) * 8);
    parts.flood = floodScore(L.floodZone);

    var score = Math.round(parts.equity + parts.roi + parts.arvConf + parts.lotRoom + parts.s121 + parts.flood);

    // ----- verdict (gated) -----
    var verdict;
    if (economicEquityAfterTax <= 0) {
      verdict = "pass";                              // hard veto: a money-loser is a money-loser
    } else if (noComps) {
      verdict = (score >= 50) ? "caution" : "pass";  // comp-data gate: phantom ARV never gets GO
    } else if (score >= 75 && annualizedRoi != null && annualizedRoi >= GO_ROI_MIN
               && floodScore(L.floodZone) > 0 && taxGain <= limit) {
      verdict = "go";
    } else if (score >= 50) {
      verdict = "caution";
    } else {
      verdict = "pass";
    }

    return {
      lot: lot, compPsf: compPsf, sqft: sqft, holdYears: holdYears,
      construction: construction, acqClosing: acqClosing, demo: demo, allInBasis: allInBasis,
      arv: arv, sellClosing: sellClosing, netSaleProceeds: netSaleProceeds, carry: carry,
      economicEquityPreTax: economicEquityPreTax, economicEquityAfterTax: economicEquityAfterTax,
      cashInvested: cashInvested, taxGain: taxGain, limit: limit, excludedGain: excludedGain,
      taxableExcess: taxableExcess, taxOnExcess: taxOnExcess, taxIfNoExclusion: taxIfNoExclusion,
      headroom: headroom, overLimit: overLimit, roi: roi, annualizedRoi: annualizedRoi,
      dispersion: dispersion, lotToArv: lotToArv, noComps: noComps,
      arvLow: arvLow, equityLow: equityLow, maxBuildBudget: maxBuildBudget, maxSqft: maxSqft,
      valueAtCompletion: valueAtCompletion, landEquity: landEquity, loanAmount: loanAmount,
      ltvAtCompletion: ltvAtCompletion, pmiApplies: pmiApplies,
      monthlyPI: monthlyPI, monthlyTax: monthlyTax, monthlyInsurance: monthlyInsurance,
      monthlyPMI: monthlyPMI, monthlyPITI: monthlyPITI,
      parts: parts, score: score, verdict: verdict
    };
  }

  // flood / site risk (0–7)
  function floodScore(zone) {
    var z = String(zone || "").toUpperCase();
    if (!z || z === "UNKNOWN" || z === "D") return 4;     // unknown scores conservatively (mid), never best-case
    if (z === "X" || z === "X500") return 7;
    if (z[0] === "V") return 0;                            // coastal high-risk
    if (z[0] === "A") return 2;                            // SFHA high-risk
    return 4;
  }
  function floodTone(zone) {
    var s = floodScore(zone);
    return s >= 7 ? "ok" : (s <= 2 ? "bad" : "warn");
  }

  // ---- data fetch / mock --------------------------------------------
  function strHash(s) {
    var h = 0; s = String(s);
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  function mockData(input) {
    var seed = strHash(input.url || input.address || "sample");
    var psf = 200 + (seed % 130);            // 200–329
    var asking = 80000 + (seed % 12) * 18000; // 80k–278k (raw-land lot price)
    var count = 4 + (seed % 5);              // 4–8
    var spread = 0.10 + ((seed >> 3) % 20) / 100; // 10–29%
    var zones = ["X", "X", "X500", "AE", "A", "X"];
    var addrFromUrl = (function () {
      try {
        var m = (input.url || "").match(/homedetails\/([^/]+)\//i);
        return m ? decodeURIComponent(m[1]).replace(/-/g, " ") : "";
      } catch (e) { return ""; }
    })();
    return {
      source: "mock",
      address: input.address || addrFromUrl || "123 Sample St Houston TX 77007",
      askingPrice: asking,
      compMedianPerSqft: psf,
      compCount: count,
      lowPerSqft: Math.round(psf * (1 - spread)),
      highPerSqft: Math.round(psf * (1 + spread)),
      asOf: null,
      floodZone: zones[seed % zones.length],
      lat: 29.78, lng: -95.41
    };
  }

  function applyData(d) {
    listing.address = d.address || listing.address;
    listing.askingPrice = d.askingPrice || 0;
    listing.compPsf = d.compMedianPerSqft || d.comps && d.comps.medianPerSqft || 0;
    var c = d.comps || d;
    listing.compCount = (d.compCount != null ? d.compCount : (c.count || 0));
    listing.lowPsf = (d.lowPerSqft != null ? d.lowPerSqft : (c.lowPerSqft || 0));
    listing.highPsf = (d.highPerSqft != null ? d.highPerSqft : (c.highPerSqft || 0));
    listing.asOf = d.asOf || (c && c.asOf) || null;
    listing.floodZone = d.floodZone || "X";
    listing.lat = d.lat != null ? d.lat : null;
    listing.lng = d.lng != null ? d.lng : null;
    listing.compDetails = (d.comps && Array.isArray(d.comps.compDetails)) ? d.comps.compDetails : [];
    syncListingInputs();
    recalc();
  }

  function status(msg, kind) {
    if (!statusHost) return;
    statusHost.textContent = msg || "";
    statusHost.className = "bb-status" + (kind ? " bb-status--" + kind : "");
  }

  function getPass() {
    var p = localStorage.getItem("bb_passcode");
    if (!p) {
      p = (window.prompt("Enter the Buy Box access passcode:") || "").trim();
      if (p) localStorage.setItem("bb_passcode", p);
    }
    return p;
  }

  function analyze() {
    listing.url = els.url.value.trim();
    var cfg = window.BUYBOX_CONFIG || {};
    if (!listing.url && !els.address.value.trim()) {
      status("Paste a Zillow URL or type an address below, then Analyze.", "warn");
      return;
    }

    if (cfg.USE_MOCK || !cfg.FUNCTION_URL) {
      // mock path (pre-deploy / demo)
      status("Analyzing…", "loading");
      var d = mockData({ url: listing.url, address: els.address.value.trim() });
      applyData(d);
      status("Sample data (mock mode). Deploy the Edge Function for live data.", "info");
      return;
    }

    var pass = getPass();
    if (!pass) { status("Passcode required for live lookups.", "warn"); return; }
    status("Analyzing…", "loading");

    fetch(cfg.FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + (cfg.SUPABASE_ANON_KEY || ""),
        "apikey": cfg.SUPABASE_ANON_KEY || "",
        "x-app-pass": pass
      },
      body: JSON.stringify(listing.url
        ? { url: listing.url }
        : { address: els.address.value.trim() })
    }).then(function (res) {
      return res.json().then(function (j) { return { status: res.status, ok: res.ok, j: j }; });
    }).then(function (r) {
      if (r.status === 401) {
        localStorage.removeItem("bb_passcode");
        status("Passcode rejected. Click Analyze to re-enter it.", "error");
        return;
      }
      if (r.status === 429) {
        status(r.j.error || "Monthly lookup limit reached. Enter details manually.", "error");
        return;
      }
      if (!r.ok) { status(r.j.error || "Lookup failed. Enter details manually below.", "error"); return; }
      applyData(r.j);
      var u = r.j.usage;
      var quota = u ? "  ·  " + u.used + "/" + u.cap + " lookups used this month" : "";
      status("Live data loaded for " + (r.j.address || "listing") + (r.j.cached ? " (cached)" : "") + "." + quota, "ok");
    }).catch(function () {
      status("Network error. Enter details manually below.", "error");
    });
  }

  // ---- input plumbing ------------------------------------------------
  function syncListingInputs() {
    els.address.value = listing.address || "";
    els.askingPrice.value = listing.askingPrice || "";
    els.compPsf.value = listing.compPsf || "";
    els.compCount.value = listing.compCount || "";
    // Preserve any FEMA-reported zone even if it's not a preset option,
    // so scoring uses the real zone instead of collapsing to UNKNOWN.
    var fz = els.floodZone, zone = listing.floodZone || "X";
    var known = Array.prototype.some.call(fz.options, function (o) { return o.value === zone; });
    if (!known) fz.appendChild(U.el("option", { value: zone, text: zone + " — (reported)" }));
    fz.value = zone;
  }

  function readInputs() {
    listing.address = els.address.value.trim();
    listing.askingPrice = U.parseNum(els.askingPrice.value);
    listing.compPsf = U.parseNum(els.compPsf.value);
    listing.compCount = U.parseNum(els.compCount.value);
    listing.floodZone = els.floodZone.value;
    assumptions.plannedSqft = U.parseNum(els.plannedSqft.value);
    assumptions.costPerSqft = U.parseNum(els.costPerSqft.value);
    assumptions.appreciationRate = U.parseNum(els.appreciationRate.value) / 100;
    assumptions.holdMonths = U.parseNum(els.holdMonths.value);
    assumptions.filingStatus = els.filingStatus.value;
    assumptions.sellClosingPct = U.parseNum(els.sellClosingPct.value) / 100;
    assumptions.acqClosingPct = U.parseNum(els.acqClosingPct.value) / 100;
    assumptions.carryPct = U.parseNum(els.carryPct.value) / 100;
    assumptions.demoCost = U.parseNum(els.demoCost.value);
    assumptions.ltcgRate = U.parseNum(els.ltcgRate.value) / 100;
    assumptions.mortgageRate = U.parseNum(els.mortgageRate.value) / 100;
    assumptions.mortgageTermYears = U.parseNum(els.mortgageTermYears.value);
    assumptions.propertyTaxRate = U.parseNum(els.propertyTaxRate.value) / 100;
    assumptions.homeInsuranceRate = U.parseNum(els.homeInsuranceRate.value) / 100;
    assumptions.pmiRate = U.parseNum(els.pmiRate.value) / 100;
  }

  function recalc() { readInputs(); renderResult(); }

  function reset() {
    listing.url = ""; listing.address = ""; listing.askingPrice = 0;
    listing.compPsf = 0; listing.compCount = 0; listing.lowPsf = 0;
    listing.highPsf = 0; listing.asOf = null; listing.floodZone = "X";
    listing.lat = null; listing.lng = null; listing.compDetails = [];
    assumptions = Object.assign({}, ASSUMPTION_DEFAULTS);
    eligChecked = [false, false, false, false];
    els.url.value = "";
    status("", "");
    syncListingInputs();
    setAssumptionInputs();
    recalc();
  }


  // ---- field builders ------------------------------------------------
  function field(key, label, opts) {
    opts = opts || {};
    var id = "bb_" + key;
    var control;
    if (opts.type === "select") {
      control = U.el("select", { id: id }, opts.options.map(function (o) {
        return U.el("option", { value: o[0], text: o[1] });
      }));
    } else {
      var attrs = { id: id, type: opts.text ? "text" : "number" };
      if (opts.placeholder) attrs.placeholder = opts.placeholder;
      if (!opts.text) { attrs.step = "any"; attrs.min = "0"; }
      control = U.el("input", attrs);
    }
    els[key] = control;

    var cls = "input-wrap", pre = null, post = null;
    if (opts.money) { cls += " has-pre"; pre = U.el("span", { class: "affix affix--pre", text: "$" }); }
    if (opts.pct) { cls += " has-post"; post = U.el("span", { class: "affix affix--post", text: "%" }); }
    if (opts.post) { cls += " has-post"; post = U.el("span", { class: "affix affix--post", text: opts.post }); }

    return U.el("div", { class: "field" + (opts.full ? " field--full" : "") }, [
      U.el("label", { for: id, text: label }),
      U.el("div", { class: cls }, [pre, control, post]),
      opts.note ? U.el("div", { class: "field__note", id: id + "_note", text: opts.note }) : null
    ]);
  }

  // ---- result card ---------------------------------------------------
  function dial(score, verdict) {
    var r = 52, C = 2 * Math.PI * r;
    var off = C * (1 - U.clamp(score, 0, 100) / 100);
    var color = verdict === "go" ? "var(--green)" : (verdict === "caution" ? "var(--gold)" : "var(--red)");
    var svg =
      '<svg viewBox="0 0 128 128" class="bb-dial__svg" aria-hidden="true">' +
      '<circle cx="64" cy="64" r="' + r + '" class="bb-dial__track"/>' +
      '<circle cx="64" cy="64" r="' + r + '" class="bb-dial__val" ' +
      'stroke="' + color + '" stroke-dasharray="' + C.toFixed(1) + '" ' +
      'stroke-dashoffset="' + off.toFixed(1) + '"/></svg>';
    var wrap = U.el("div", { class: "bb-dial" });
    wrap.innerHTML = svg;
    wrap.appendChild(U.el("div", { class: "bb-dial__num" }, [
      U.el("div", { class: "bb-dial__score", text: String(score) }),
      U.el("div", { class: "bb-dial__of", text: "/ 100" })
    ]));
    return wrap;
  }

  // Value-vs-cost meter. Profitable: [costs navy][equity green]. Losing:
  // [covered-by-sale navy][shortfall red]. All widths clamped to [0,100].
  function valueMeter(d) {
    var cost = d.allInBasis + d.carry + d.sellClosing; // total project cost
    var total = Math.max(d.arv, cost, 1);
    var profitable = d.economicEquityPreTax > 0;
    var segs;
    if (profitable) {
      var costW = U.clamp(cost / total * 100, 0, 100);
      var eqW = U.clamp(d.economicEquityPreTax / total * 100, 0, 100);
      segs = [
        U.el("div", { class: "meter__seg meter__seg--basis", style: "width:" + costW + "%", title: "All-in cost " + U.fmtUSD(cost) }),
        U.el("div", { class: "meter__seg meter__seg--gain", style: "width:" + eqW + "%", title: "Equity " + U.fmtUSD(d.economicEquityPreTax) })
      ];
    } else {
      var coveredW = U.clamp(d.arv / total * 100, 0, 100);
      var shortW = U.clamp((cost - d.arv) / total * 100, 0, 100);
      segs = [
        U.el("div", { class: "meter__seg meter__seg--basis", style: "width:" + coveredW + "%", title: "Sale covers " + U.fmtUSD(d.arv) }),
        U.el("div", { class: "meter__seg meter__seg--over", style: "width:" + shortW + "%", title: "Short by " + U.fmtUSD(cost - d.arv) })
      ];
    }
    return U.el("div", { class: "meter__bar" }, segs);
  }

  function row(label, value, opts) {
    opts = opts || {};
    var cls = "bb-row" + (opts.strong ? " bb-row--strong" : "") + (opts.sub ? " bb-row--sub" : "");
    return U.el("div", { class: cls }, [
      U.el("span", { class: "bb-row__k", text: label }),
      U.el("span", { class: "bb-row__v" + (opts.neg ? " is-neg" : ""), text: value })
    ]);
  }

  function renderResult() {
    if (!resultHost) return;
    var d = computeDeal();
    resultHost.innerHTML = "";

    var gainExists = d.taxGain > 0;
    var allEligChecked = !gainExists || eligChecked.every(Boolean);
    var profitable = d.economicEquityAfterTax > 0;

    var vlabel = d.verdict === "go" ? "Pursue" : (d.verdict === "caution" ? "Maybe" : "Pass");
    var roiTxt = d.annualizedRoi != null ? U.fmtPct(d.annualizedRoi) + "/yr" : "—";
    var subTxt = profitable
      ? "Captures " + U.fmtUSD(d.economicEquityAfterTax) + " after-tax equity · " + roiTxt
      : "Loses " + U.fmtUSD(-d.economicEquityAfterTax) + " — doesn't pencil";
    var head = U.el("div", { class: "bb-verdict bb-verdict--" + d.verdict }, [
      dial(d.score, d.verdict),
      U.el("div", { class: "bb-verdict__txt" }, [
        U.el("div", { class: "bb-verdict__badge", text: vlabel }),
        U.el("div", { class: "bb-verdict__sub", text: subTxt })
      ])
    ]);

    // headline: after-tax equity captured + lot price
    var equityBlock = U.el("div", { class: "bb-mao" }, [
      U.el("div", { class: "bb-mao__heads" }, [
        U.el("div", {}, [
          U.el("div", { class: "label-cap", text: "Tax-free equity captured (after-tax, after-carry, ~" + (Math.round(d.holdYears * 10) / 10) + "yr)" }),
          U.el("div", { class: "bb-mao__big" + (profitable ? "" : " is-neg"), text: U.fmtUSD(d.economicEquityAfterTax) }),
          U.el("div", { class: "bb-mao__roi", text: d.roi != null
            ? U.fmtPct(d.roi) + " cash-on-cash · " + roiTxt + " · " + U.fmtUSD(d.cashInvested) + " all-in cash" : "" })
        ]),
        U.el("div", { class: "bb-mao__ask" }, [U.el("div", { class: "label-cap", text: "Lot price" }),
          U.el("div", { class: "bb-mao__askv", text: U.fmtUSD(d.lot) })])
      ]),
      valueMeter(d),
      U.el("div", { class: "meter__legend" }, [
        U.el("span", {}, [U.el("i", { class: "swatch swatch--basis" }), "All-in cost " + U.fmtUSDshort(d.allInBasis + d.carry + d.sellClosing)]),
        profitable ? U.el("span", {}, [U.el("i", { class: "swatch swatch--gain" }), "Equity " + U.fmtUSDshort(d.economicEquityPreTax)]) : null,
        !profitable ? U.el("span", {}, [U.el("i", { class: "swatch swatch--over" }), "Short " + U.fmtUSDshort((d.allInBasis + d.carry + d.sellClosing) - d.arv)]) : null,
        U.el("span", {}, ["ARV " + U.fmtUSDshort(d.arv)])
      ])
    ]);

    // permanent financing: construction loan rolls into a traditional mortgage at
    // completion, sized to construction cost — the cash-bought lot is the equity.
    var ltvTone = d.pmiApplies ? " is-warn" : "";
    var finRows = U.el("div", { class: "bb-rows" }, [
      row("Principal & interest", U.fmtUSD(d.monthlyPI)),
      row("Property tax (" + U.fmtPct(U.parseNum(assumptions.propertyTaxRate)) + "/yr of value)", U.fmtUSD(d.monthlyTax)),
      row("Homeowners insurance (" + U.fmtPct(U.parseNum(assumptions.homeInsuranceRate)) + "/yr of value)", U.fmtUSD(d.monthlyInsurance)),
      d.pmiApplies ? row("PMI (LTV " + U.fmtPct(d.ltvAtCompletion, 0) + " > 80%)", U.fmtUSD(d.monthlyPMI)) : null,
      row("= Est. monthly note (PITI" + (d.pmiApplies ? "+PMI" : "") + ")", U.fmtUSD(d.monthlyPITI), { strong: true })
    ]);
    var financingBlock = U.el("div", { class: "bb-fin" }, [
      U.el("div", { class: "bb-fin__heads" }, [
        U.el("div", {}, [
          U.el("div", { class: "label-cap", text: "Est. monthly note once the construction loan rolls to perm" }),
          U.el("div", { class: "bb-fin__big", text: U.fmtUSD(d.monthlyPITI) + "/mo" })
        ]),
        U.el("div", { class: "bb-fin__loan" }, [
          U.el("div", { class: "label-cap", text: "Loan amount" }),
          U.el("div", { class: "bb-fin__loanv", text: U.fmtUSD(d.loanAmount) }),
          U.el("div", { class: "bb-fin__ltv" + ltvTone, text: d.ltvAtCompletion != null
            ? U.fmtPct(d.ltvAtCompletion, 0) + " LTV at completion" : "LTV unverified (no comps)" })
        ])
      ]),
      finRows,
      U.el("p", { class: "bb-fin__note", text: "Lot (" + U.fmtUSD(d.landEquity) + ", paid cash) is the equity at conversion — " +
        "the loan finances construction only (" + U.fmtUSD(d.loanAmount) + " at " +
        U.fmtPct(U.parseNum(assumptions.mortgageRate)) + ", " + assumptions.mortgageTermYears + "yr fixed). " +
        "Value at completion uses today's comp $/sqft, before the hold period's appreciation." })
    ]);

    // footing waterfall — single running balance from ARV down to after-tax equity
    var rows = U.el("div", { class: "bb-rows" }, [
      row("ARV at sale (" + U.fmtUSD(d.compPsf) + "/sqft × " + U.fmtSqft(d.sqft) + ", +appr)", U.fmtUSD(d.arv), { strong: true }),
      row("− Sell-side closing (" + U.fmtPct(U.parseNum(assumptions.sellClosingPct)) + " of ARV)", "-" + U.fmtUSD(d.sellClosing)),
      row("= Net sale proceeds", U.fmtUSD(d.netSaleProceeds), { sub: true }),
      row("− Lot acquisition (from listing)", "-" + U.fmtUSD(d.lot)),
      row("− Acquisition closing (" + U.fmtPct(U.parseNum(assumptions.acqClosingPct)) + " of lot)", "-" + U.fmtUSD(d.acqClosing)),
      row("− Construction (" + U.fmtSqft(d.sqft) + " × " + U.fmtUSD(assumptions.costPerSqft) + ")", "-" + U.fmtUSD(d.construction)),
      d.demo > 0 ? row("− Demolition / site prep", "-" + U.fmtUSD(d.demo)) : null,
      row("= Taxable gain (§121)", U.fmtUSD(d.taxGain), { sub: true, neg: d.taxGain < 0 }),
      row("− Carrying costs (not in basis, not deductible)", "-" + U.fmtUSD(d.carry)),
      row("= Economic equity, pre-tax", U.fmtUSD(d.economicEquityPreTax), { sub: true, neg: d.economicEquityPreTax < 0 }),
      d.taxOnExcess > 0 ? row("− §121 tax on excess (" + U.fmtPct(U.parseNum(assumptions.ltcgRate)) + " LTCG)", "-" + U.fmtUSD(d.taxOnExcess)) : null,
      row("= After-tax equity captured", U.fmtUSD(d.economicEquityAfterTax), { strong: true, neg: d.economicEquityAfterTax < 0 })
    ]);

    // §121 eligibility checklist (advisory — only when there's gain to exclude)
    var checklistEl = null;
    if (gainExists) {
      checklistEl = U.el("div", { class: "bb-elig-checklist" });
      checklistEl.appendChild(U.el("div", { class: "bb-elig-head", text: "§121 eligibility checklist" }));
      ELIG_CHECKS.forEach(function (label, i) {
        var cb = U.el("input", { type: "checkbox", id: "elig_" + i });
        cb.checked = eligChecked[i];
        cb.addEventListener("change", function () { eligChecked[i] = cb.checked; recalc(); });
        var item = U.el("label", { for: "elig_" + i, class: "bb-elig-item" }, [cb, document.createTextNode(" " + label)]);
        checklistEl.appendChild(item);
      });
      if (!allEligChecked) {
        checklistEl.appendChild(U.el("p", { class: "bb-elig-note",
          text: "Confirm all four or the gain may be taxable — if you don't occupy 24 months, the entire " +
            U.fmtUSD(d.taxGain) + " gain is taxable (≈ " + U.fmtUSD(d.taxIfNoExclusion) + " at " +
            U.fmtPct(U.parseNum(assumptions.ltcgRate)) + ")." }));
      }
    }

    // chips
    var s121Tone = d.overLimit ? "bad" : (!gainExists ? "warn" : (allEligChecked ? "ok" : "warn"));
    var lotTone = d.lotToArv <= LOT_FLOOR ? "ok" : (d.lotToArv >= LOT_CEIL ? "bad" : "warn");
    var chips = U.el("div", { class: "bb-chips" }, [
      U.el("div", { class: "bb-chip bb-chip--" + floodTone(listing.floodZone) }, [
        U.el("span", { class: "label-cap", text: "FEMA flood" }),
        U.el("strong", { text: "Zone " + listing.floodZone })
      ]),
      U.el("div", { class: "bb-chip bb-chip--" + s121Tone }, [
        U.el("span", { class: "label-cap", text: "§121" }),
        U.el("strong", { text: !gainExists
          ? "No gain yet"
          : (d.overLimit ? "Over cap by " + U.fmtUSDshort(d.taxGain - d.limit) : U.fmtUSDshort(d.headroom) + " left") }),
        (!allEligChecked && gainExists)
          ? U.el("span", { class: "bb-elig-cav", text: "⚠ Verify eligibility" })
          : null
      ]),
      U.el("div", { class: "bb-chip bb-chip--" + lotTone }, [
        U.el("span", { class: "label-cap", text: "Lot vs ARV" }),
        U.el("strong", { text: U.fmtPct(d.lotToArv, 0) + " of ARV" })
      ]),
      U.el("div", { class: "bb-chip" }, [
        U.el("span", { class: "label-cap", text: "Return" }),
        U.el("strong", { text: roiTxt })
      ]),
      U.el("div", { class: "bb-chip" + (d.noComps ? " bb-chip--bad" : "") }, [
        U.el("span", { class: "label-cap", text: "Comps" }),
        U.el("strong", { text: d.noComps ? "ARV unverified" : (listing.compCount || 0) + " @ " + U.fmtUSD(d.compPsf) + "/sf" })
      ]),
      U.el("div", { class: "bb-chip" }, [
        U.el("span", { class: "label-cap", text: "Max build for breakeven" }),
        U.el("strong", { text: d.maxBuildBudget > 0
          ? U.fmtUSDshort(d.maxBuildBudget) + " (~" + U.fmtSqft(d.maxSqft) + ")" : "—" })
      ])
    ]);

    // notes: tax-vs-cash wedge, over-cap tax, comp gate, downside, tax caveat
    var notes = [];
    if (gainExists && profitable && Math.round(d.taxGain) !== Math.round(d.economicEquityAfterTax)) {
      notes.push("Taxable gain (" + U.fmtUSD(d.taxGain) + ") is larger than your real after-tax profit (" +
        U.fmtUSD(d.economicEquityAfterTax) + ") — carrying costs reduce cash but not the §121 gain.");
    }
    if (d.overLimit) {
      notes.push("Gain exceeds the " + U.fmtUSD(d.limit) + " §121 cap — est. tax on excess " +
        U.fmtUSD(d.taxOnExcess) + " (" + U.fmtPct(U.parseNum(assumptions.ltcgRate)) + " LTCG, before NIIT/state).");
    }
    if (d.noComps) {
      notes.push("No/low comp data — ARV is unverified, so the verdict is capped at Maybe. Enter a comp $/sqft to refine.");
    } else if (d.equityLow < 0 && profitable) {
      notes.push("Downside: at the low comp ($" + Math.round(U.parseNum(listing.lowPsf)) + "/sf) this deal loses " +
        U.fmtUSD(-d.equityLow) + ". Thin margin.");
    }
    notes.push("15% LTCG is a floor — NIIT (3.8%), state tax, and any depreciation recapture aren't modeled. Estimates only, not tax advice.");
    var tax = U.el("div", { class: "tax-note" }, [notes.join("  ")]);

    var actions = U.el("div", { class: "input-actions" }, [
      U.el("button", { class: "btn btn--primary", type: "button", onclick: save }, ["＋ Save analysis"]),
      U.el("button", { class: "btn", type: "button", onclick: sendToCalc }, ["Send to Calculator"]),
      U.el("span", { id: "bb_flash", class: "flash" })
    ]);

    resultHost.appendChild(head);
    resultHost.appendChild(equityBlock);
    resultHost.appendChild(financingBlock);
    resultHost.appendChild(chips);
    if (checklistEl) resultHost.appendChild(checklistEl);
    resultHost.appendChild(rows);
    if (tax) resultHost.appendChild(tax);

    // comp address list (only when we have detail from the API)
    if (listing.compDetails && listing.compDetails.length) {
      var compList = U.el("div", { class: "bb-comps" });
      compList.appendChild(U.el("div", { class: "bb-comps__head", text: "Comps used (" + listing.compDetails.length + ")" }));
      listing.compDetails.forEach(function (c) {
        var dist = c.distance != null ? " · " + (+c.distance).toFixed(1) + " mi" : "";
        var meta = [
          c.price ? U.fmtUSD(c.price) : null,
          c.sqft ? U.fmtSqft(c.sqft) + " sqft" : null,
          c.psf ? U.fmtUSD(c.psf) + "/sf" : null
        ].filter(Boolean).join(" · ");
        compList.appendChild(U.el("div", { class: "bb-comp-row" }, [
          U.el("span", { class: "bb-comp-addr", text: c.address || "Address unavailable" }),
          U.el("span", { class: "bb-comp-meta", text: meta + dist })
        ]));
      });
      resultHost.appendChild(compList);
    }

    resultHost.appendChild(actions);
  }

  // ---- save / send ---------------------------------------------------
  function save() {
    var d = computeDeal();
    var rec = {
      id: U.uuid(), createdAt: new Date().toISOString(),
      sourceUrl: listing.url, address: listing.address, zip: "",
      askingPrice: listing.askingPrice, floodZone: listing.floodZone,
      compPsf: listing.compPsf, compCount: listing.compCount,
      assumptions: Object.assign({}, assumptions),
      derived: { arv: d.arv, allInBasis: d.allInBasis, equityAfterTax: d.economicEquityAfterTax,
        roi: d.roi, annualizedRoi: d.annualizedRoi, taxGain: d.taxGain, taxOnExcess: d.taxOnExcess,
        score: d.score, verdict: d.verdict, monthlyPITI: d.monthlyPITI, loanAmount: d.loanAmount }
    };
    var arr = loadSaved(); arr.push(rec); writeSaved(arr);
    drawSaved(); flash("Saved");
  }

  function sendToCalc() {
    if (!window.Calculator || !window.Calculator.loadScenario) return;
    window.Calculator.loadScenario({
      zip: "", label: listing.address || "From Buy Box",
      lotCost: listing.askingPrice, sqft: assumptions.plannedSqft,
      costPerSqft: assumptions.costPerSqft, arvPerSqft: listing.compPsf,
      appreciationRate: assumptions.appreciationRate, holdMonths: assumptions.holdMonths,
      filingStatus: assumptions.filingStatus, closingCostPct: assumptions.sellClosingPct
    });
    if (window.App) window.App.activate("calculator");
  }

  var flashTimer = null;
  function flash(msg) {
    var n = document.getElementById("bb_flash"); if (!n) return;
    n.textContent = msg; n.classList.add("is-on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { n.classList.remove("is-on"); n.textContent = ""; }, 1600);
  }

  // ---- saved analyses ------------------------------------------------
  function loadSaved() {
    try { var a = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function writeSaved(a) { try { localStorage.setItem(STORE_KEY, JSON.stringify(a)); } catch (e) {} }
  function delSaved(id) { writeSaved(loadSaved().filter(function (r) { return r.id !== id; })); drawSaved(); }

  function drawSaved() {
    if (!savedHost) return;
    savedHost.innerHTML = "";
    var arr = loadSaved().slice().sort(function (a, b) { return (b.createdAt || "").localeCompare(a.createdAt || ""); });
    savedHost.appendChild(U.el("div", { class: "section-title" }, [
      U.el("h2", { text: "Saved analyses" }),
      U.el("span", { class: "label-cap", text: arr.length + (arr.length === 1 ? " deal" : " deals") })
    ]));
    if (!arr.length) {
      savedHost.appendChild(U.el("div", { class: "empty", text: "Analyze a listing and hit “Save analysis” to keep it here." }));
      return;
    }
    savedHost.appendChild(U.el("div", { class: "cards" }, arr.map(savedCard)));
  }

  function savedCard(r) {
    var v = r.derived || {};
    // equityAfterTax (new) or fall back to legacy mao field for old records
    var equity = v.equityAfterTax != null ? v.equityAfterTax : (v.mao != null ? v.mao : 0);
    var roiTxt = v.annualizedRoi != null ? U.fmtPct(v.annualizedRoi) + "/yr" : "—";
    return U.el("div", { class: "card" }, [
      U.el("div", { class: "card__top" }, [
        U.el("div", {}, [
          U.el("div", { class: "card__zip" + (equity < 0 ? " is-neg" : ""), text: U.fmtUSD(equity) }),
          U.el("div", { class: "card__label", text: r.address || r.sourceUrl || "—" })
        ]),
        U.el("span", { class: "card__flag " + (v.verdict === "go" ? "card__flag--ok" : v.verdict === "pass" ? "card__flag--over" : ""),
          text: "Score " + (v.score != null ? v.score : "–") })
      ]),
      U.el("div", { class: "card__rows" }, [
        crow("Lot price", U.fmtUSD(r.askingPrice || 0)),
        crow("After-tax equity", U.fmtUSD(equity)),
        crow("Return", roiTxt),
        crow("Monthly note", v.monthlyPITI != null ? U.fmtUSD(v.monthlyPITI) + "/mo" : "—"),
        crow("Flood", "Zone " + (r.floodZone || "—"))
      ]),
      U.el("div", { class: "card__actions" }, [
        U.el("button", { class: "btn", type: "button", onclick: function () { loadInto(r); } }, ["Load"]),
        U.el("button", { class: "btn btn--danger", type: "button", onclick: function () { delSaved(r.id); } }, ["✕"])
      ])
    ]);
  }
  function crow(k, val) {
    return U.el("div", { class: "card__row" }, [
      U.el("span", { class: "k", text: k }), U.el("span", { class: "v", text: val })
    ]);
  }

  function loadInto(r) {
    listing.url = r.sourceUrl || ""; listing.address = r.address || "";
    listing.askingPrice = r.askingPrice || 0; listing.compPsf = r.compPsf || 0;
    listing.compCount = r.compCount || 0; listing.floodZone = r.floodZone || "X";
    assumptions = Object.assign({}, ASSUMPTION_DEFAULTS, r.assumptions || {});
    els.url.value = listing.url;
    syncListingInputs();
    setAssumptionInputs();
    recalc();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setAssumptionInputs() {
    els.plannedSqft.value = assumptions.plannedSqft;
    els.costPerSqft.value = assumptions.costPerSqft;
    els.appreciationRate.value = pctInput(assumptions.appreciationRate);
    els.holdMonths.value = assumptions.holdMonths;
    els.filingStatus.value = assumptions.filingStatus;
    els.sellClosingPct.value = pctInput(assumptions.sellClosingPct);
    els.acqClosingPct.value = pctInput(assumptions.acqClosingPct);
    els.carryPct.value = pctInput(assumptions.carryPct);
    els.demoCost.value = assumptions.demoCost;
    els.ltcgRate.value = pctInput(assumptions.ltcgRate);
    els.mortgageRate.value = pctInput(assumptions.mortgageRate);
    els.mortgageTermYears.value = assumptions.mortgageTermYears;
    els.propertyTaxRate.value = pctInput(assumptions.propertyTaxRate);
    els.homeInsuranceRate.value = pctInput(assumptions.homeInsuranceRate);
    els.pmiRate.value = pctInput(assumptions.pmiRate);
  }

  // ---- init ----------------------------------------------------------
  function init(panel) {
    // URL intake row
    els.url = U.el("input", { id: "bb_url", type: "text", placeholder: "Paste a Zillow listing URL…" });
    var analyzeBtn = U.el("button", { class: "btn btn--primary", type: "button", onclick: analyze }, ["Analyze"]);
    var resetBtn = U.el("button", { class: "btn btn--ghost", type: "button", onclick: reset, title: "Clear all fields and start fresh" }, ["Reset"]);
    var urlRow = U.el("div", { class: "bb-urlrow" }, [els.url, analyzeBtn, resetBtn]);
    statusHost = U.el("div", { class: "bb-status", id: "bb_status" });

    // listing facts (editable — doubles as manual entry)
    var listingGrid = U.el("div", { class: "field-grid" }, [
      field("address", "Address", { text: true, full: true, placeholder: "123 Main St, Houston, TX 77007" }),
      field("askingPrice", "Lot price (raw land)", { money: true, note: "Acquisition cost — from the listing or typed in" }),
      field("compPsf", "Comp median $/sqft", { money: true, note: "Nearby finished homes → drives ARV" }),
      field("compCount", "# comps", {}),
      field("floodZone", "FEMA flood zone", { type: "select", options: FLOOD_ZONES })
    ]);

    // build assumptions
    var assumpGrid = U.el("div", { class: "field-grid" }, [
      field("plannedSqft", "Planned build size", { post: "sqft" }),
      field("costPerSqft", "Build cost / sqft", { money: true }),
      field("appreciationRate", "Appreciation / yr", { pct: true }),
      field("holdMonths", "Hold period", { post: "mo" }),
      field("filingStatus", "Filing status", { type: "select", options: [["mfj", "Married — joint"], ["single", "Single"]] }),
      field("sellClosingPct", "Sell-side closing", { pct: true }),
      field("acqClosingPct", "Acquisition closing", { pct: true }),
      field("carryPct", "Annual carry cost", { pct: true, note: "Tax + insurance + utilities" }),
      field("demoCost", "Demolition cost", { money: true }),
      field("ltcgRate", "LT cap-gains rate", { pct: true, note: "On gain above the §121 cap" })
    ]);

    // permanent financing: construction loan rolls into this at completion,
    // sized to construction cost only — the cash-bought lot is the equity.
    var financeGrid = U.el("div", { class: "field-grid" }, [
      field("mortgageRate", "Mortgage rate", { pct: true }),
      field("mortgageTermYears", "Mortgage term", { post: "yrs" }),
      field("propertyTaxRate", "Property tax rate", { pct: true, note: "% of value / yr" }),
      field("homeInsuranceRate", "Homeowners insurance", { pct: true, note: "% of value / yr" }),
      field("pmiRate", "PMI rate", { pct: true, note: "Applied only if LTV > 80%" })
    ]);

    var inputPanel = U.el("section", { class: "panel" }, [
      U.el("div", { class: "panel-head" }, [
        U.el("h2", { text: "Listing" }),
        U.el("p", { text: "Drop a raw-land URL and Analyze, or fill the fields by hand." })
      ]),
      urlRow, statusHost, listingGrid,
      U.el("div", { class: "bb-subhead" }, [U.el("h3", { text: "Build assumptions" })]),
      assumpGrid,
      U.el("div", { class: "bb-subhead" }, [U.el("h3", { text: "Permanent financing" })]),
      financeGrid
    ]);

    resultHost = U.el("div", { class: "bb-result" });
    var resultPanel = U.el("section", { class: "panel results-panel" }, [
      U.el("div", { class: "results-head" }, [U.el("h2", { text: "Buy verdict" })]),
      resultHost
    ]);

    var grid = U.el("div", { class: "calc-grid" }, [inputPanel, resultPanel]);
    savedHost = U.el("div", { id: "bb_saved" });

    panel.appendChild(grid);
    panel.appendChild(savedHost);

    // defaults into inputs
    setAssumptionInputs();
    syncListingInputs();

    // wire live recalc
    Object.keys(els).forEach(function (k) {
      if (k === "url") return;
      els[k].addEventListener("input", recalc);
      if (els[k].tagName === "SELECT") els[k].addEventListener("change", recalc);
    });
    els.url.addEventListener("keydown", function (e) { if (e.key === "Enter") analyze(); });

    recalc();
    drawSaved();
  }

  window.BuyBox = {
    refresh: drawSaved,
    tab: { id: "buybox", label: "Buy Box", init: init }
  };
})();
