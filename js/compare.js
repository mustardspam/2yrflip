/* ============================================================
   compare.js — side-by-side comparison (window.Compare.tab)
   Up to 4 scenarios; highest value per numeric row highlighted.
   ============================================================ */
(function () {
  "use strict";

  var U = window.Utils;
  var MAX = 4;
  var selected = [];        // array of scenario ids
  var panelHost = null;

  // metric rows: pull from compute(); highlight = highest value wins
  // goal: "max" = higher is better, "min" = lower is better.
  // The favorable extreme per row is highlighted (not just the highest).
  var ROWS = [
    { key: "basis", label: "All-in basis", fmt: U.fmtUSD, highlight: true, goal: "min" },
    { key: "arv", label: "ARV at listing", fmt: U.fmtUSD, highlight: true, goal: "max" },
    { key: "grossEquity", label: "Gross equity", fmt: U.fmtUSD, highlight: true, goal: "max" },
    { key: "closingCosts", label: "Closing costs", fmt: U.fmtUSD, highlight: true, goal: "min" },
    { key: "netProceeds", label: "Net proceeds", fmt: U.fmtUSD, highlight: true, goal: "max" },
    { key: "headroom", label: "§121 headroom", fmt: U.fmtUSD, highlight: true, goal: "max" },
    { key: "effectiveNet", label: "Est. net in pocket", fmt: U.fmtUSD, highlight: true, goal: "max" }
  ];

  function syncSelection(list) {
    var ids = list.map(function (s) { return s.id; });
    selected = selected.filter(function (id) { return ids.indexOf(id) !== -1; });
    if (!selected.length) {
      // default: most-recent up to MAX
      var sorted = list.slice().sort(function (a, b) {
        return (b.createdAt || "").localeCompare(a.createdAt || "");
      });
      selected = sorted.slice(0, MAX).map(function (s) { return s.id; });
    }
  }

  function toggle(id) {
    var i = selected.indexOf(id);
    if (i !== -1) selected.splice(i, 1);
    else if (selected.length < MAX) selected.push(id);
    draw();
  }

  function pickers(list) {
    var wrap = U.el("div", { class: "compare-pickers" });
    list.forEach(function (s) {
      var on = selected.indexOf(s.id) !== -1;
      var full = !on && selected.length >= MAX;
      var b = U.el("button", {
        class: "compare-pick" + (on ? " is-on" : ""),
        type: "button",
        onclick: function () { toggle(s.id); }
      }, [(on ? "✓ " : "") + (s.zip || "—") + (s.label ? " · " + s.label : "")]);
      if (full) b.disabled = true;
      wrap.appendChild(b);
    });
    return wrap;
  }

  function table(scenarios) {
    var computed = scenarios.map(function (s) {
      return { s: s, d: window.Calculator.compute(s) };
    });

    // header
    var headCells = [U.el("th", {}, [U.el("span", { text: "Metric" })])];
    computed.forEach(function (c) {
      var remove = U.el("button", { class: "compare-remove", type: "button", title: "Remove",
        onclick: function () { toggle(c.s.id); } }, ["✕"]);
      headCells.push(U.el("th", {}, [
        U.el("span", { text: (c.s.zip || "—") }),
        remove,
        U.el("span", { class: "sub", text: c.s.label || "" })
      ]));
    });
    var thead = U.el("thead", {}, [U.el("tr", {}, headCells)]);

    // body rows
    var bodyRows = ROWS.map(function (rdef) {
      var vals = computed.map(function (c) { return c.d[rdef.key]; });
      var finite = vals.filter(isFinite);
      var best = (rdef.highlight && finite.length)
        ? (rdef.goal === "min" ? Math.min.apply(null, finite) : Math.max.apply(null, finite))
        : null;
      var cells = [U.el("td", { text: rdef.label })];
      vals.forEach(function (v) {
        var isBest = rdef.highlight && computed.length > 1 && v === best && isFinite(v);
        cells.push(U.el("td", { class: isBest ? "best" : "", text: rdef.fmt(v) }));
      });
      return U.el("tr", {}, cells);
    });

    // §121 status row (flags, no highlight)
    var flagCells = [U.el("td", { text: "§121 status" })];
    computed.forEach(function (c) {
      flagCells.push(U.el("td", {
        class: c.d.overLimit ? "flag-over" : "flag-ok",
        text: c.d.overLimit ? "⚠ Over" : "✓ Tax-free"
      }));
    });
    bodyRows.push(U.el("tr", {}, flagCells));

    var tbody = U.el("tbody", {}, bodyRows);
    return U.el("div", { class: "compare-wrap" }, [
      U.el("table", { class: "compare-table" }, [thead, tbody])
    ]);
  }

  function draw() {
    if (!panelHost) return;
    panelHost.innerHTML = "";
    var list = window.Store.load();

    panelHost.appendChild(U.el("div", { class: "section-title" }, [U.el("h2", { text: "Compare markets" })]));

    if (!list.length) {
      panelHost.appendChild(U.el("p", { class: "compare-intro",
        text: "Save a few scenarios in the Calculator tab, then pick up to 4 here to compare side by side." }));
      panelHost.appendChild(U.el("div", { class: "empty", text: "No saved scenarios yet." }));
      return;
    }

    syncSelection(list);

    panelHost.appendChild(U.el("p", { class: "compare-intro",
      text: "Pick up to " + MAX + " scenarios. Best value in each row is highlighted (★)." }));
    panelHost.appendChild(pickers(list));

    var chosen = selected
      .map(function (id) { return window.Store.get(id); })
      .filter(Boolean);

    if (!chosen.length) {
      panelHost.appendChild(U.el("div", { class: "empty", text: "Select at least one scenario above." }));
      return;
    }
    panelHost.appendChild(table(chosen));
  }

  function init(panel) { panelHost = panel; draw(); }

  window.Compare = {
    refresh: function () { if (panelHost) draw(); },
    tab: { id: "compare", label: "Compare", init: init }
  };
})();
