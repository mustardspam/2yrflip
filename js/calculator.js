/* ============================================================
   calculator.js — input panel, live calc engine, results + meter
   Exposes: window.Calculator
     .compute(scenario) -> derived metrics (pure, reused by cards/compare)
     .buildMemo(scenario) -> plain-text deal memo
     .tab -> { id, label, init(panelEl) }
   ============================================================ */
(function () {
  "use strict";

  var U = window.Utils;

  var EXCLUSION = { single: 250000, mfj: 500000 };
  var LTCG_RATE = 0.15;

  var DEFAULTS = {
    label: "",
    zip: "",
    lotCost: 150000,
    sqft: 3000,
    costPerSqft: 165,
    arvPerSqft: 240,
    appreciationRate: 0.035, // decimal
    holdMonths: 24,
    filingStatus: "mfj",
    closingCostPct: 0.07     // decimal
  };

  // ---- pure calculation -------------------------------------------------
  function compute(s) {
    var sqft = U.parseNum(s.sqft);
    var construction = sqft * U.parseNum(s.costPerSqft);
    var basis = U.parseNum(s.lotCost) + construction;
    var years = U.parseNum(s.holdMonths) / 12;
    var rate = U.parseNum(s.appreciationRate);
    var factor = Math.pow(1 + rate, years);
    var arvToday = sqft * U.parseNum(s.arvPerSqft);
    var arv = arvToday * factor;

    var grossEquity = arv - basis;
    var closingCosts = arv * U.parseNum(s.closingCostPct);
    var netProceeds = arv - basis - closingCosts;

    var limit = EXCLUSION[s.filingStatus] || EXCLUSION.mfj;
    var headroom = limit - grossEquity;
    var overLimit = grossEquity > limit;
    var excess = Math.max(0, grossEquity - limit);
    var taxOnExcess = excess * LTCG_RATE;
    var effectiveNet = netProceeds - taxOnExcess;

    // Meter geometry (segments sum across max(arv, basis))
    var total = Math.max(arv, basis, 1);
    var safeGain = Math.max(0, Math.min(grossEquity, limit));
    var overGain = Math.max(0, grossEquity - limit);
    var basisPct = U.clamp((basis / total) * 100, 0, 100);
    var gainPct = U.clamp((safeGain / total) * 100, 0, 100);
    var overPct = U.clamp((overGain / total) * 100, 0, 100);
    var limitPos = ((basis + limit) / total) * 100;
    var showLimit = overLimit && limitPos <= 100;

    return {
      construction: construction,
      basis: basis,
      arvToday: arvToday,
      arv: arv,
      grossEquity: grossEquity,
      closingCosts: closingCosts,
      netProceeds: netProceeds,
      limit: limit,
      headroom: headroom,
      overLimit: overLimit,
      excess: excess,
      taxOnExcess: taxOnExcess,
      effectiveNet: effectiveNet,
      meter: {
        basisPct: basisPct, gainPct: gainPct, overPct: overPct,
        limitPos: limitPos, showLimit: showLimit
      }
    };
  }

  // ---- plain-text deal memo --------------------------------------------
  function buildMemo(s) {
    var d = compute(s);
    var L = [];
    var title = s.label ? s.label : ("ZIP " + (s.zip || "—"));
    L.push("2yrflip — §121 DEAL MEMO");
    L.push("=========================");
    L.push(title + (s.zip && s.label ? "  (" + s.zip + ")" : ""));
    L.push("");
    L.push("INPUTS");
    L.push("  ZIP ................ " + (s.zip || "—"));
    L.push("  Lot cost ........... " + U.fmtUSD(s.lotCost));
    L.push("  Build size ......... " + U.fmtSqft(s.sqft));
    L.push("  Cost / sqft ........ " + U.fmtUSD(s.costPerSqft));
    L.push("  ARV / sqft ......... " + U.fmtUSD(s.arvPerSqft));
    L.push("  Appreciation ....... " + U.fmtPct(s.appreciationRate) + " / yr");
    L.push("  Hold period ........ " + U.parseNum(s.holdMonths) + " months");
    L.push("  Filing status ...... " + (s.filingStatus === "single" ? "Single" : "MFJ"));
    L.push("  Closing costs ...... " + U.fmtPct(s.closingCostPct));
    L.push("");
    L.push("RESULTS");
    L.push("  Construction cost .. " + U.fmtUSD(d.construction));
    L.push("  All-in basis ....... " + U.fmtUSD(d.basis));
    L.push("  ARV at listing ..... " + U.fmtUSD(d.arv));
    L.push("  Gross equity ....... " + U.fmtUSD(d.grossEquity));
    L.push("  Closing costs ...... " + U.fmtUSD(d.closingCosts));
    L.push("  Net proceeds ....... " + U.fmtUSD(d.netProceeds));
    L.push("  §121 exclusion ..... " + U.fmtUSD(d.limit));
    L.push("  Headroom remaining . " + U.fmtUSD(d.headroom));
    if (d.overLimit) {
      L.push("  ** OVER LIMIT by " + U.fmtUSD(-d.headroom) + " **");
      L.push("  Est. tax on excess . " + U.fmtUSD(d.taxOnExcess) + " (15% LT cap gains)");
    }
    L.push("  Est. net in pocket . " + U.fmtUSD(d.effectiveNet));
    L.push("");
    L.push("Estimates only. Not tax advice. §121: $250K single / $500K MFJ.");
    return L.join("\n");
  }

  // ---- UI ---------------------------------------------------------------
  // field config drives the input panel
  var FIELDS = [
    { key: "label", label: "Label (optional)", type: "text", full: true, placeholder: "e.g. Bridgeland spec #1" },
    { key: "zip", label: "ZIP code", type: "text", full: true, placeholder: "77386" },
    { key: "lotCost", label: "Lot cost", type: "money" },
    { key: "sqft", label: "Build size", type: "num", post: "sqft" },
    { key: "costPerSqft", label: "Cost / sqft", type: "money" },
    { key: "arvPerSqft", label: "ARV / sqft (comp)", type: "money" },
    { key: "appreciationRate", label: "Appreciation / yr", type: "pct" },
    { key: "holdMonths", label: "Hold period", type: "num", post: "mo" },
    { key: "closingCostPct", label: "Closing costs", type: "pct" },
    { key: "filingStatus", label: "Filing status", type: "select",
      options: [["mfj", "Married — joint"], ["single", "Single"]] }
  ];

  // decimal (0.035) -> clean percent number for an input (3.5, no float noise)
  function pctInput(dec) { return Math.round(U.parseNum(dec) * 100 * 1e4) / 1e4; }

  var state = Object.assign({}, DEFAULTS);
  var inputs = {};         // key -> input element
  var resultsHost = null;  // results panel container
  var onSavedCb = null;    // callback to refresh cards/compare

  function readState() {
    FIELDS.forEach(function (f) {
      var node = inputs[f.key];
      if (!node) return;
      if (f.type === "pct") state[f.key] = U.parseNum(node.value) / 100;
      else if (f.type === "select" || f.type === "text") state[f.key] = node.value;
      else state[f.key] = U.parseNum(node.value);
    });
    return state;
  }

  function buildField(f) {
    var label = U.el("label", { for: "f_" + f.key, text: f.label });
    var control;

    if (f.type === "select") {
      control = U.el("select", { id: "f_" + f.key },
        f.options.map(function (o) {
          var opt = U.el("option", { value: o[0], text: o[1] });
          if (state[f.key] === o[0]) opt.selected = true;
          return opt;
        }));
    } else {
      var val = state[f.key];
      if (f.type === "pct") val = pctInput(val);
      var attrs = { id: "f_" + f.key, type: f.type === "text" ? "text" : "number" };
      if (f.placeholder) attrs.placeholder = f.placeholder;
      if (f.type === "money" || f.type === "num") { attrs.min = "0"; attrs.step = "any"; }
      if (f.type === "pct") { attrs.step = "0.1"; attrs.min = "0"; }
      if (f.type !== "text") attrs.value = val;
      else attrs.value = val || "";
      control = U.el("input", attrs);
    }

    inputs[f.key] = control;

    var wrapClass = "input-wrap";
    var pre = null, post = null;
    if (f.type === "money") { wrapClass += " has-pre"; pre = U.el("span", { class: "affix affix--pre", text: "$" }); }
    if (f.type === "pct") { wrapClass += " has-post"; post = U.el("span", { class: "affix affix--post", text: "%" }); }
    if (f.post) { wrapClass += " has-post"; post = U.el("span", { class: "affix affix--post", text: f.post }); }

    var wrap = U.el("div", { class: wrapClass }, [pre, control, post]);
    var note = U.el("div", { class: "field__note", id: "note_" + f.key });

    return U.el("div", { class: "field" + (f.full ? " field--full" : "") }, [label, wrap, note]);
  }

  function setZipNote() {
    var note = document.getElementById("note_zip");
    var aNote = document.getElementById("note_appreciationRate");
    if (!note) return;
    var zip = inputs.zip.value.trim();
    if (!zip) { note.textContent = ""; if (aNote) aNote.textContent = ""; return; }
    var res = window.ZipDefaults.lookup(zip);
    // apply default rate for this ZIP
    inputs.appreciationRate.value = pctInput(res.rate);
    state.appreciationRate = res.rate;
    if (res.fallback) {
      note.textContent = "Not in table — using " + U.fmtPct(res.rate) + " default. Override as needed.";
      if (aNote) aNote.textContent = "default (fallback)";
    } else {
      note.textContent = res.area + " — default " + U.fmtPct(res.rate);
      if (aNote) aNote.textContent = "ZIP default " + U.fmtPct(res.rate) + " (editable)";
    }
    recalc();
  }

  function metric(label, value, opts) {
    opts = opts || {};
    var v = U.el("div", { class: "metric__value" + (opts.neg ? " is-neg" : ""), text: value });
    return U.el("div", { class: "metric" + (opts.accent ? " metric--accent" : "") + (opts.span ? " metric--span" : "") },
      [U.el("div", { class: "metric__label", text: label }), v]);
  }

  function renderResults() {
    if (!resultsHost) return;
    var s = state;
    var d = compute(s);
    resultsHost.innerHTML = "";

    // headline + status
    var statusClass = d.overLimit ? "meter__status meter__status--over" : "meter__status meter__status--safe";
    var statusText = d.overLimit
      ? "⚠ Over §121 by " + U.fmtUSD(-d.headroom)
      : "✓ Within §121 (" + U.fmtUSD(d.headroom) + " left)";

    var headline = U.el("div", { class: "meter__headline" }, [
      U.el("div", {}, [
        U.el("div", { class: "meter__net-label", text: "Est. net in pocket (tax-free up to limit)" }),
        U.el("div", { class: "meter__net" + (d.effectiveNet < 0 ? " is-neg" : ""), text: U.fmtUSD(d.effectiveNet) })
      ]),
      U.el("div", { class: statusClass, text: statusText })
    ]);

    // meter bar
    var segs = [
      U.el("div", { class: "meter__seg meter__seg--basis", style: "width:" + d.meter.basisPct + "%", title: "Basis " + U.fmtUSD(d.basis) }),
      U.el("div", { class: "meter__seg meter__seg--gain", style: "width:" + d.meter.gainPct + "%", title: "Tax-free gain" }),
      U.el("div", { class: "meter__seg meter__seg--over", style: "width:" + d.meter.overPct + "%", title: "Taxable overage" })
    ];
    var barChildren = segs;
    if (d.meter.showLimit) {
      barChildren = segs.concat([U.el("div", { class: "meter__limit", style: "left:" + d.meter.limitPos + "%" })]);
    }
    var bar = U.el("div", { class: "meter__bar" }, barChildren);

    var legend = U.el("div", { class: "meter__legend" }, [
      U.el("span", {}, [U.el("i", { class: "swatch swatch--basis" }), "Basis " + U.fmtUSDshort(d.basis)]),
      U.el("span", {}, [U.el("i", { class: "swatch swatch--gain" }), "Tax-free gain " + U.fmtUSDshort(Math.min(Math.max(d.grossEquity,0), d.limit))]),
      d.overLimit ? U.el("span", {}, [U.el("i", { class: "swatch swatch--over" }), "Over limit " + U.fmtUSDshort(d.excess)]) : null,
      U.el("span", {}, ["ARV " + U.fmtUSDshort(d.arv)])
    ]);

    var meter = U.el("div", { class: "meter" }, [headline, bar, legend]);

    // metrics grid
    var grid = U.el("div", { class: "metrics" }, [
      metric("All-in basis", U.fmtUSD(d.basis)),
      metric("ARV at listing", U.fmtUSD(d.arv)),
      metric("Gross equity", U.fmtUSD(d.grossEquity), { neg: d.grossEquity < 0 }),
      metric("Closing costs", U.fmtUSD(d.closingCosts)),
      metric("Net proceeds", U.fmtUSD(d.netProceeds), { accent: true, neg: d.netProceeds < 0 }),
      metric("§121 headroom", U.fmtUSD(d.headroom), { neg: d.headroom < 0 })
    ]);

    // tax note
    var taxNote = U.el("div", { class: "tax-note" + (d.overLimit ? "" : " is-hidden") }, []);
    taxNote.innerHTML = "Estimated tax on excess: <strong>" + U.fmtUSD(d.taxOnExcess) +
      "</strong> &mdash; 15% LT cap-gains on " + U.fmtUSD(d.excess) +
      " above the " + U.fmtUSD(d.limit) + " exclusion. Estimate only, not tax advice.";

    resultsHost.appendChild(meter);
    resultsHost.appendChild(grid);
    resultsHost.appendChild(taxNote);
  }

  function recalc() { readState(); renderResults(); }

  function currentScenario() {
    readState();
    return {
      zip: state.zip.trim(),
      label: state.label.trim(),
      lotCost: U.parseNum(state.lotCost),
      sqft: U.parseNum(state.sqft),
      costPerSqft: U.parseNum(state.costPerSqft),
      arvPerSqft: U.parseNum(state.arvPerSqft),
      appreciationRate: U.parseNum(state.appreciationRate),
      holdMonths: U.parseNum(state.holdMonths),
      filingStatus: state.filingStatus,
      closingCostPct: U.parseNum(state.closingCostPct)
    };
  }

  function saveScenario() {
    var s = currentScenario();
    if (!s.zip) {
      var z = inputs.zip;
      z.focus();
      document.getElementById("note_zip").textContent = "Enter a ZIP to save this scenario.";
      return;
    }
    var rec = Object.assign({ id: U.uuid(), createdAt: new Date().toISOString() }, s);
    window.Store.add(rec);
    if (onSavedCb) onSavedCb();
    flash("Saved");
  }

  function copySummary() {
    var text = buildMemo(currentScenario());
    var done = function () { flash("Copied"); };
    var fail = function () {
      // fallback for file:// / older browsers
      var ta = U.el("textarea", { style: "position:fixed;opacity:0;" });
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); flash("Copied"); }
      catch (e) { flash("Copy failed"); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else { fail(); }
  }

  var flashTimer = null;
  function flash(msg) {
    var btnRow = document.getElementById("flashHost");
    if (!btnRow) return;
    btnRow.textContent = msg;
    btnRow.classList.add("is-on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { btnRow.classList.remove("is-on"); btnRow.textContent = ""; }, 1600);
  }

  function resetForm() {
    state = Object.assign({}, DEFAULTS);
    FIELDS.forEach(function (f) {
      var node = inputs[f.key];
      if (!node) return;
      if (f.type === "pct") node.value = pctInput(DEFAULTS[f.key]);
      else node.value = DEFAULTS[f.key];
    });
    ["zip", "appreciationRate"].forEach(function (k) {
      var n = document.getElementById("note_" + k); if (n) n.textContent = "";
    });
    recalc();
  }

  // load a saved scenario back into the form (used by "edit" from cards)
  function loadScenario(s) {
    FIELDS.forEach(function (f) {
      var node = inputs[f.key]; if (!node) return;
      var val = s[f.key];
      if (val == null) val = DEFAULTS[f.key];
      if (f.type === "pct") node.value = pctInput(val);
      else node.value = val;
    });
    recalc();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function init(panel, onSaved) {
    onSavedCb = onSaved;

    // input panel
    var fieldGrid = U.el("div", { class: "field-grid" }, FIELDS.map(buildField));

    var actions = U.el("div", { class: "input-actions" }, [
      U.el("button", { class: "btn btn--primary", type: "button", onclick: saveScenario }, ["＋ Save scenario"]),
      U.el("button", { class: "btn", type: "button", onclick: copySummary }, ["Copy summary"]),
      U.el("button", { class: "btn btn--ghost", type: "button", onclick: resetForm }, ["Reset"]),
      U.el("span", { id: "flashHost", class: "flash" })
    ]);

    var inputPanel = U.el("section", { class: "panel input-panel" }, [
      U.el("div", { class: "panel-head" }, [
        U.el("h2", { text: "Deal parameters" }),
        U.el("p", { text: "Live estimate — every keystroke recalculates." })
      ]),
      fieldGrid,
      actions
    ]);

    // results panel
    resultsHost = U.el("div", { class: "results-body" });
    var resultsPanel = U.el("section", { class: "panel results-panel" }, [
      U.el("div", { class: "results-head" }, [
        U.el("h2", { text: "Projected outcome" })
      ]),
      resultsHost
    ]);

    var grid = U.el("div", { class: "calc-grid" }, [inputPanel, resultsPanel]);

    // scenario cards host (rendered by scenarios.js)
    var cardsSection = U.el("div", { id: "scenariosSection" });

    panel.appendChild(grid);
    panel.appendChild(cardsSection);

    // wire live recalculation
    FIELDS.forEach(function (f) {
      var node = inputs[f.key];
      node.addEventListener("input", recalc);
      if (f.type === "select") node.addEventListener("change", recalc);
    });
    inputs.zip.addEventListener("blur", setZipNote);

    recalc();
    if (window.Scenarios) window.Scenarios.render(cardsSection, { onEdit: loadScenario });
  }

  window.Calculator = {
    EXCLUSION: EXCLUSION,
    LTCG_RATE: LTCG_RATE,
    DEFAULTS: DEFAULTS,
    compute: compute,
    buildMemo: buildMemo,
    loadScenario: loadScenario,
    tab: { id: "calculator", label: "Calculator", init: init }
  };
})();
