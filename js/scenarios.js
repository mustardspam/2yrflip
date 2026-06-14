/* ============================================================
   scenarios.js — saved scenario cards (window.Scenarios)
   ============================================================ */
(function () {
  "use strict";

  var U = window.Utils;
  var host = null;
  var opts = {};

  function card(s) {
    var d = window.Calculator.compute(s);
    var over = d.overLimit;

    var flag = U.el("span", {
      class: "card__flag " + (over ? "card__flag--over" : "card__flag--ok"),
      text: over ? "⚠ Over limit" : "✓ Tax-free"
    });

    var top = U.el("div", { class: "card__top" }, [
      U.el("div", {}, [
        U.el("div", { class: "card__zip", text: s.zip || "—" }),
        s.label ? U.el("div", { class: "card__label", text: s.label }) : null
      ]),
      flag
    ]);

    var rows = U.el("div", { class: "card__rows" }, [
      row("All-in basis", U.fmtUSD(d.basis)),
      row("ARV", U.fmtUSD(d.arv)),
      row("Gross equity", U.fmtUSD(d.grossEquity)),
      row("Net proceeds", U.fmtUSD(d.netProceeds))
    ]);

    var net = U.el("div", {}, [
      U.el("div", { class: "label-cap", text: "Est. net in pocket" }),
      U.el("div", { class: "card__net" + (d.effectiveNet < 0 ? " is-neg" : ""), text: U.fmtUSD(d.effectiveNet) })
    ]);

    var actions = U.el("div", { class: "card__actions" }, [
      U.el("button", { class: "btn", type: "button", title: "Load into calculator",
        onclick: function () { if (opts.onEdit) opts.onEdit(s); } }, ["Edit"]),
      U.el("button", { class: "btn", type: "button", title: "Copy deal memo",
        onclick: function () { copyMemo(s); } }, ["Copy"]),
      U.el("button", { class: "btn btn--danger", type: "button", title: "Delete",
        onclick: function () { del(s); } }, ["✕"])
    ]);

    return U.el("div", { class: "card", "data-id": s.id }, [top, rows, net, actions]);
  }

  function row(k, v) {
    return U.el("div", { class: "card__row" }, [
      U.el("span", { class: "k", text: k }),
      U.el("span", { class: "v", text: v })
    ]);
  }

  function copyMemo(s) {
    var text = window.Calculator.buildMemo(s);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(toast, fallbackCopy.bind(null, text));
    } else { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    var ta = U.el("textarea", { style: "position:fixed;opacity:0;" });
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(); } catch (e) {}
    document.body.removeChild(ta);
  }
  function toast() { if (window.App && window.App.toast) window.App.toast("Deal memo copied"); }

  function del(s) {
    window.Store.remove(s.id);
    if (window.App && window.App.refreshAll) window.App.refreshAll();
    else draw();
  }

  function draw() {
    if (!host) return;
    host.innerHTML = "";
    var list = window.Store.load();

    var titleRow = U.el("div", { class: "section-title" }, [
      U.el("h2", { text: "Saved scenarios" }),
      U.el("span", { class: "label-cap", text: list.length + (list.length === 1 ? " deal" : " deals") })
    ]);
    host.appendChild(titleRow);

    if (!list.length) {
      host.appendChild(U.el("div", { class: "empty",
        text: "No saved scenarios yet. Fill in a deal above and hit “Save scenario” to start comparing markets." }));
      return;
    }

    // newest first
    var sorted = list.slice().sort(function (a, b) {
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    });
    host.appendChild(U.el("div", { class: "cards" }, sorted.map(card)));
  }

  function render(hostEl, options) {
    host = hostEl;
    opts = options || {};
    draw();
  }

  window.Scenarios = { render: render, refresh: draw };
})();
