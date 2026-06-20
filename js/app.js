/* ============================================================
   app.js — tab router + shell (window.App)
   registerTab(id, label, initFn, opts) pattern lets Phase 2
   tabs slot in without touching existing modules.
   ============================================================ */
(function () {
  "use strict";

  var U = window.Utils;
  var tabBar, panelHost, toastEl;
  var tabs = {};          // id -> { id, label, initFn, btn, panel, reserved, initialized }
  var order = [];
  var activeId = null;

  function registerTab(id, label, initFn, opts) {
    opts = opts || {};
    var btn = U.el("button", {
      class: "tab", type: "button", role: "tab", "data-tab": id
    }, [label]);
    if (opts.reserved) {
      btn.disabled = true;
      btn.appendChild(U.el("span", { class: "tab__soon", text: "Phase 2" }));
    } else {
      btn.addEventListener("click", function () { activate(id); });
    }
    tabBar.appendChild(btn);

    var panel = U.el("section", { class: "tab-panel", id: "panel-" + id, role: "tabpanel" });
    if (opts.reserved) {
      panel.appendChild(U.el("div", { class: "empty" }, [
        U.el("strong", { text: label + " — coming in Phase 2." }),
        U.el("br"),
        document.createTextNode(opts.blurb || "")
      ]));
    }
    panelHost.appendChild(panel);

    tabs[id] = { id: id, label: label, initFn: initFn, btn: btn, panel: panel,
      reserved: !!opts.reserved, initialized: false };
    order.push(id);
  }

  function activate(id) {
    var t = tabs[id];
    if (!t || t.reserved) return;
    activeId = id;

    order.forEach(function (oid) {
      var ot = tabs[oid];
      var on = oid === id;
      ot.btn.classList.toggle("tab--active", on);
      ot.panel.classList.toggle("tab-panel--active", on);
    });

    if (!t.initialized) {
      try { t.initFn(t.panel); } catch (e) { console.error("Tab init failed:", id, e); }
      t.initialized = true;
    } else if (id === "compare" && window.Compare) {
      window.Compare.refresh(); // keep comparison fresh on re-entry
    }

    if (history.replaceState) history.replaceState(null, "", "#" + id);
  }

  function refreshAll() {
    if (window.Scenarios) window.Scenarios.refresh();
    if (window.Compare) window.Compare.refresh();
  }

  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = U.el("div", { class: "toast" });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("is-on"); }, 1800);
  }

  function init() {
    tabBar = document.getElementById("tabBar");
    panelHost = document.getElementById("tabPanels");

    // Active tabs (MVP)
    registerTab(window.Calculator.tab.id, window.Calculator.tab.label,
      function (panel) { window.Calculator.tab.init(panel, refreshAll); });

    if (window.BuyBox) {
      registerTab(window.BuyBox.tab.id, window.BuyBox.tab.label,
        function (panel) { window.BuyBox.tab.init(panel); });
    }

    if (window.LotFinder) {
      registerTab(window.LotFinder.tab.id, window.LotFinder.tab.label,
        function (panel) { window.LotFinder.tab.init(panel); });
    }

    registerTab(window.Compare.tab.id, window.Compare.tab.label,
      function (panel) { window.Compare.tab.init(panel); });

    // Phase 2 — reserved (designed for, not built)
    registerTab("lots", "Lot Pipeline", null,
      { reserved: true, blurb: "Track prospective lots by status, link to scenarios, HCAD parcel lookup." });
    registerTab("budget", "Job Budget", null,
      { reserved: true, blurb: "Per-project trade line items, change orders, actuals vs. budget." });
    registerTab("portfolio", "Portfolio", null,
      { reserved: true, blurb: "Roll-up across active projects: aggregate equity, exposure, projected net." });

    // initial route from hash, else default to first active tab
    var hashId = (location.hash || "").replace("#", "");
    activate(tabs[hashId] && !tabs[hashId].reserved ? hashId : order[0]);
  }

  window.App = { registerTab: registerTab, activate: activate, refreshAll: refreshAll, toast: toast };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
