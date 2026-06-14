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
    ["AO", "AO — high risk (SFHA)"],
    ["VE", "VE — coastal high risk"],
    ["D", "D — undetermined"],
    ["UNKNOWN", "Unknown"]
  ];

  var DEF = window.Calculator ? window.Calculator.DEFAULTS : {};
  var ASSUMPTION_DEFAULTS = {
    plannedSqft: DEF.sqft || 3000,
    costPerSqft: DEF.costPerSqft || 165,
    appreciationRate: DEF.appreciationRate || 0.035,
    holdMonths: DEF.holdMonths || 24,
    filingStatus: DEF.filingStatus || "mfj",
    sellClosingPct: DEF.closingCostPct || 0.07,
    acqClosingPct: 0.015,
    demoCost: 0,
    targetMode: "pct",   // "pct" of ARV or "usd" fixed
    targetValue: 15      // 15% (pct mode) or dollars (usd mode)
  };

  var listing = {            // editable listing facts (from API/mock or manual)
    url: "", address: "", askingPrice: 0, compPsf: 0,
    compCount: 0, lowPsf: 0, highPsf: 0, asOf: null,
    floodZone: "X", lat: null, lng: null
  };
  var assumptions = Object.assign({}, ASSUMPTION_DEFAULTS);

  var els = {};              // input element refs
  var resultHost = null, savedHost = null, statusHost = null;

  function pctInput(dec) { return Math.round(U.parseNum(dec) * 100 * 1e4) / 1e4; }

  // ---- compute -------------------------------------------------------
  function computeDeal() {
    var a = assumptions, L = listing;
    var compPsf = U.parseNum(L.compPsf);
    var factor = Math.pow(1 + U.parseNum(a.appreciationRate), U.parseNum(a.holdMonths) / 12);
    var arv = U.parseNum(a.plannedSqft) * compPsf * factor;
    var buildCost = U.parseNum(a.plannedSqft) * U.parseNum(a.costPerSqft);
    var sellClosing = arv * U.parseNum(a.sellClosingPct);
    var targetProfit = a.targetMode === "usd"
      ? U.parseNum(a.targetValue)
      : arv * (U.parseNum(a.targetValue) / 100);

    // MAO solves: price + acq% * price = arv - build - demo - sellClose - profit
    var numerator = arv - buildCost - U.parseNum(a.demoCost) - sellClosing - targetProfit;
    var mao = numerator / (1 + U.parseNum(a.acqClosingPct));
    var asking = U.parseNum(L.askingPrice);
    var gap = mao - asking;
    var acqClosing = asking * U.parseNum(a.acqClosingPct);

    // §121 reuse — buy at asking, build, sell
    var d121 = window.Calculator.compute({
      lotCost: asking, sqft: a.plannedSqft, costPerSqft: a.costPerSqft,
      arvPerSqft: compPsf, appreciationRate: a.appreciationRate,
      holdMonths: a.holdMonths, filingStatus: a.filingStatus, closingCostPct: a.sellClosingPct
    });

    // ----- scoring -----
    var parts = {};
    // margin (50)
    parts.margin = (mao > 0 && gap > 0) ? Math.min(50, 50 * (gap / mao) / 0.15) : 0;
    // ARV confidence (15)
    var count = U.parseNum(L.compCount);
    if (count <= 0 || compPsf <= 0) {
      parts.arv = 0;
    } else {
      var countScore = U.clamp(count / 5, 0, 1);
      var disp = (L.highPsf && L.lowPsf && compPsf)
        ? (U.parseNum(L.highPsf) - U.parseNum(L.lowPsf)) / compPsf : 0.25;
      var tight = U.clamp(1 - disp / 0.4, 0, 1);
      parts.arv = 15 * (0.6 * countScore + 0.4 * tight);
    }
    // §121 fit (15)
    if (d121.grossEquity <= 0) parts.s121 = 0;
    else if (d121.grossEquity <= d121.limit) parts.s121 = 15;
    else parts.s121 = 15 * U.clamp(d121.limit / d121.grossEquity, 0, 1);
    // flood (20)
    parts.flood = floodScore(L.floodZone);

    var score = Math.round(parts.margin + parts.arv + parts.s121 + parts.flood);
    var verdict = (score >= 75 && gap > 0) ? "go" : (score >= 50 ? "caution" : "pass");

    return {
      compPsf: compPsf, arv: arv, buildCost: buildCost, sellClosing: sellClosing,
      targetProfit: targetProfit, mao: mao, asking: asking, gap: gap,
      acqClosing: acqClosing, d121: d121, parts: parts, score: score, verdict: verdict
    };
  }

  function floodScore(zone) {
    var z = String(zone || "").toUpperCase();
    if (z === "X" || z === "X500") return 20;
    if (z[0] === "V") return 0;
    if (z[0] === "A") return 8;
    return 10; // D / UNKNOWN — neutral
  }
  function floodTone(zone) {
    var s = floodScore(zone);
    return s >= 20 ? "ok" : (s <= 8 ? "bad" : "warn");
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
    var asking = 300000 + (seed % 9) * 35000; // 300k–580k
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
    syncListingInputs();
    recalc();
  }

  function status(msg, kind) {
    if (!statusHost) return;
    statusHost.textContent = msg || "";
    statusHost.className = "bb-status" + (kind ? " bb-status--" + kind : "");
  }

  function analyze() {
    listing.url = els.url.value.trim();
    var cfg = window.BUYBOX_CONFIG || {};
    if (!listing.url && !els.address.value.trim()) {
      status("Paste a Zillow URL or type an address below, then Analyze.", "warn");
      return;
    }
    status("Analyzing…", "loading");

    if (cfg.USE_MOCK || !cfg.FUNCTION_URL) {
      // mock path (pre-deploy / demo)
      var d = mockData({ url: listing.url, address: els.address.value.trim() });
      applyData(d);
      status("Sample data (mock mode). Deploy the Edge Function for live data.", "info");
      return;
    }

    fetch(cfg.FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + (cfg.SUPABASE_ANON_KEY || ""),
        "apikey": cfg.SUPABASE_ANON_KEY || ""
      },
      body: JSON.stringify({ url: listing.url, address: els.address.value.trim() || undefined })
    }).then(function (res) {
      return res.json().then(function (j) { return { ok: res.ok, j: j }; });
    }).then(function (r) {
      if (!r.ok) { status(r.j.error || "Lookup failed. Enter details manually below.", "error"); return; }
      applyData(r.j);
      status("Live data loaded for " + (r.j.address || "listing") + ".", "ok");
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
    els.floodZone.value = FLOOD_ZONES.some(function (z) { return z[0] === listing.floodZone; })
      ? listing.floodZone : "UNKNOWN";
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
    assumptions.demoCost = U.parseNum(els.demoCost.value);
    assumptions.targetMode = els.targetMode.value;
    assumptions.targetValue = U.parseNum(els.targetValue.value);
  }

  function recalc() { readInputs(); renderResult(); updateTargetSuffix(); }

  function updateTargetSuffix() {
    var n = document.getElementById("bb_target_suffix");
    if (n) n.textContent = assumptions.targetMode === "usd" ? "$ (fixed)" : "% of ARV";
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

  function metaMeter(d) {
    var total = Math.max(d.mao, d.asking, 1);
    var navy = Math.min(d.asking, d.mao);
    var room = Math.max(0, d.mao - d.asking);
    var over = Math.max(0, d.asking - d.mao);
    var segs = [
      U.el("div", { class: "meter__seg meter__seg--basis", style: "width:" + (navy / total * 100) + "%", title: "Within MAO" }),
      U.el("div", { class: "meter__seg meter__seg--gain", style: "width:" + (room / total * 100) + "%", title: "Buy room" }),
      U.el("div", { class: "meter__seg meter__seg--over", style: "width:" + (over / total * 100) + "%", title: "Over MAO" })
    ];
    return U.el("div", { class: "meter__bar" }, segs);
  }

  function row(label, value, opts) {
    opts = opts || {};
    return U.el("div", { class: "bb-row" + (opts.strong ? " bb-row--strong" : "") }, [
      U.el("span", { class: "bb-row__k", text: label }),
      U.el("span", { class: "bb-row__v" + (opts.neg ? " is-neg" : ""), text: value })
    ]);
  }

  function renderResult() {
    if (!resultHost) return;
    var d = computeDeal();
    resultHost.innerHTML = "";

    var vlabel = d.verdict === "go" ? "Pursue" : (d.verdict === "caution" ? "Maybe" : "Pass");
    var head = U.el("div", { class: "bb-verdict bb-verdict--" + d.verdict }, [
      dial(d.score, d.verdict),
      U.el("div", { class: "bb-verdict__txt" }, [
        U.el("div", { class: "bb-verdict__badge", text: vlabel }),
        U.el("div", { class: "bb-verdict__sub", text: d.gap >= 0
          ? "Room of " + U.fmtUSD(d.gap) + " under your max offer"
          : U.fmtUSD(-d.gap) + " over your max offer" })
      ])
    ]);

    // MAO vs asking
    var mao = U.el("div", { class: "bb-mao" }, [
      U.el("div", { class: "bb-mao__heads" }, [
        U.el("div", {}, [U.el("div", { class: "label-cap", text: "Max allowable offer" }),
          U.el("div", { class: "bb-mao__big", text: U.fmtUSD(d.mao) })]),
        U.el("div", { class: "bb-mao__ask" }, [U.el("div", { class: "label-cap", text: "Asking" }),
          U.el("div", { class: "bb-mao__askv", text: U.fmtUSD(d.asking) })])
      ]),
      metaMeter(d),
      U.el("div", { class: "meter__legend" }, [
        U.el("span", {}, [U.el("i", { class: "swatch swatch--basis" }), "Within MAO"]),
        d.gap > 0 ? U.el("span", {}, [U.el("i", { class: "swatch swatch--gain" }), "Buy room " + U.fmtUSDshort(d.gap)]) : null,
        d.gap < 0 ? U.el("span", {}, [U.el("i", { class: "swatch swatch--over" }), "Over " + U.fmtUSDshort(-d.gap)]) : null
      ])
    ]);

    // breakdown
    var rows = U.el("div", { class: "bb-rows" }, [
      row("ARV at sale (" + U.fmtUSD(d.compPsf) + "/sqft × " + U.fmtSqft(assumptions.plannedSqft) + ")", U.fmtUSD(d.arv), { strong: true }),
      row("− Build cost", "-" + U.fmtUSD(d.buildCost)),
      assumptions.demoCost > 0 ? row("− Demolition", "-" + U.fmtUSD(assumptions.demoCost)) : null,
      row("− Sell-side closing", "-" + U.fmtUSD(d.sellClosing)),
      row("− Target profit", "-" + U.fmtUSD(d.targetProfit)),
      row("− Acquisition closing", "-" + U.fmtUSD(d.acqClosing)),
      row("= Max allowable offer", U.fmtUSD(d.mao), { strong: true })
    ]);

    // §121 + flood chips
    var over121 = d.d121.overLimit;
    var chips = U.el("div", { class: "bb-chips" }, [
      U.el("div", { class: "bb-chip bb-chip--" + floodTone(listing.floodZone) }, [
        U.el("span", { class: "label-cap", text: "FEMA flood" }),
        U.el("strong", { text: "Zone " + listing.floodZone })
      ]),
      U.el("div", { class: "bb-chip bb-chip--" + (over121 ? "bad" : (d.d121.grossEquity <= 0 ? "warn" : "ok")) }, [
        U.el("span", { class: "label-cap", text: "§121" }),
        U.el("strong", { text: d.d121.grossEquity <= 0
          ? "No gain yet"
          : (over121 ? "Over by " + U.fmtUSDshort(-d.d121.headroom) : U.fmtUSDshort(d.d121.headroom) + " left") })
      ]),
      U.el("div", { class: "bb-chip" }, [
        U.el("span", { class: "label-cap", text: "Comps" }),
        U.el("strong", { text: (listing.compCount || 0) + " @ " + U.fmtUSD(d.compPsf) + "/sf" })
      ])
    ]);

    var tax = over121 ? U.el("div", { class: "tax-note" }, []) : null;
    if (tax) tax.innerHTML = "Projected gain exceeds the §121 exclusion — est. tax on excess <strong>" +
      U.fmtUSD(d.d121.taxOnExcess) + "</strong> (15% LT cap-gains). Drags your real net.";

    var actions = U.el("div", { class: "input-actions" }, [
      U.el("button", { class: "btn btn--primary", type: "button", onclick: save }, ["＋ Save analysis"]),
      U.el("button", { class: "btn", type: "button", onclick: sendToCalc }, ["Send to Calculator"]),
      U.el("span", { id: "bb_flash", class: "flash" })
    ]);

    resultHost.appendChild(head);
    resultHost.appendChild(mao);
    resultHost.appendChild(chips);
    resultHost.appendChild(rows);
    if (tax) resultHost.appendChild(tax);
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
      derived: { arv: d.arv, mao: d.mao, gap: d.gap, score: d.score, verdict: d.verdict,
        grossEquity: d.d121.grossEquity, taxOnExcess: d.d121.taxOnExcess }
    };
    var arr = loadSaved(); arr.push(rec); writeSaved(arr);
    drawSaved(); flash("Saved");
  }

  function sendToCalc() {
    if (!window.Calculator || !window.Calculator.loadScenario) return;
    window.Calculator.loadScenario({
      zip: listing.floodZone ? "" : "", label: listing.address || "From Buy Box",
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
    return U.el("div", { class: "card" }, [
      U.el("div", { class: "card__top" }, [
        U.el("div", {}, [
          U.el("div", { class: "card__zip", text: U.fmtUSD(v.mao || 0) }),
          U.el("div", { class: "card__label", text: r.address || r.sourceUrl || "—" })
        ]),
        U.el("span", { class: "card__flag " + (v.verdict === "go" ? "card__flag--ok" : v.verdict === "pass" ? "card__flag--over" : ""),
          text: "Score " + (v.score != null ? v.score : "–") })
      ]),
      U.el("div", { class: "card__rows" }, [
        crow("Asking", U.fmtUSD(r.askingPrice || 0)),
        crow("Max offer", U.fmtUSD(v.mao || 0)),
        crow("Gap", U.fmtUSD(v.gap || 0)),
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
    els.demoCost.value = assumptions.demoCost;
    els.targetMode.value = assumptions.targetMode;
    els.targetValue.value = assumptions.targetValue;
  }

  // ---- init ----------------------------------------------------------
  function init(panel) {
    // URL intake row
    els.url = U.el("input", { id: "bb_url", type: "text", placeholder: "Paste a Zillow listing URL…" });
    var analyzeBtn = U.el("button", { class: "btn btn--primary", type: "button", onclick: analyze }, ["Analyze"]);
    var urlRow = U.el("div", { class: "bb-urlrow" }, [els.url, analyzeBtn]);
    statusHost = U.el("div", { class: "bb-status", id: "bb_status" });

    // listing facts (editable — doubles as manual entry)
    var listingGrid = U.el("div", { class: "field-grid" }, [
      field("address", "Address", { text: true, full: true, placeholder: "123 Main St, Houston, TX 77007" }),
      field("askingPrice", "Asking price", { money: true }),
      field("compPsf", "Comp median $/sqft", { money: true }),
      field("compCount", "# comps", {}),
      field("floodZone", "FEMA flood zone", { type: "select", options: FLOOD_ZONES })
    ]);

    // build assumptions
    var assumpGrid = U.el("div", { class: "field-grid" }, [
      field("plannedSqft", "Planned build size", { post: "sqft" }),
      field("costPerSqft", "Cost / sqft", { money: true }),
      field("appreciationRate", "Appreciation / yr", { pct: true }),
      field("holdMonths", "Hold period", { post: "mo" }),
      field("filingStatus", "Filing status", { type: "select", options: [["mfj", "Married — joint"], ["single", "Single"]] }),
      field("sellClosingPct", "Sell-side closing", { pct: true }),
      field("acqClosingPct", "Acquisition closing", { pct: true }),
      field("demoCost", "Demolition cost", { money: true }),
      field("targetMode", "Target profit basis", { type: "select", options: [["pct", "% of ARV"], ["usd", "$ fixed"]] }),
      field("targetValue", "Target profit", { note: "% of ARV" })
    ]);
    // give the target value note an id we update
    var tnote = assumpGrid.querySelector("#bb_targetValue_note");
    if (tnote) tnote.id = "bb_target_suffix";

    var inputPanel = U.el("section", { class: "panel" }, [
      U.el("div", { class: "panel-head" }, [
        U.el("h2", { text: "Listing" }),
        U.el("p", { text: "Drop a Zillow URL and Analyze, or fill the fields by hand." })
      ]),
      urlRow, statusHost, listingGrid,
      U.el("div", { class: "bb-subhead" }, [U.el("h3", { text: "Build assumptions" })]),
      assumpGrid
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
