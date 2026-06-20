/* ============================================================
   utils.js — formatting + small helpers (global: window.Utils)
   ============================================================ */
(function () {
  "use strict";

  var usd0 = new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0
  });

  function fmtUSD(n) {
    if (!isFinite(n)) return "$0";
    return usd0.format(Math.round(n));
  }

  // Compact for tight spots: $1.2M / $640K
  function fmtUSDshort(n) {
    if (!isFinite(n)) return "$0";
    var a = Math.abs(n), sign = n < 0 ? "-" : "";
    if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
    if (a >= 1e3) return sign + "$" + Math.round(a / 1e3) + "K";
    return fmtUSD(n);
  }

  function fmtPct(decimal, places) {
    if (!isFinite(decimal)) decimal = 0;
    return (decimal * 100).toFixed(places == null ? 1 : places) + "%";
  }

  function fmtSqft(n) {
    if (!isFinite(n)) n = 0;
    return Math.round(n).toLocaleString("en-US") + " sqft";
  }

  // Parse a possibly-formatted numeric string -> number (0 on failure)
  function parseNum(v) {
    if (typeof v === "number") return v;
    if (v == null) return 0;
    var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
    return isFinite(n) ? n : 0;
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  // RFC4122-ish v4; crypto when available, Math.random fallback
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) {
      try { return window.crypto.randomUUID(); } catch (e) {}
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Round a decimal (0.065) to a clean percent-input value (6.5) for display.
  function pctInput(dec) { return Math.round(parseNum(dec) * 100 * 1e4) / 1e4; }

  // Shared labeled-input builder used by Buy Box + Lot Finder field grids.
  // els: the module's id->element map to populate; prefix: id namespace (e.g. "bb", "lf").
  function field(els, prefix, key, label, opts) {
    opts = opts || {};
    var id = prefix + "_" + key;
    var control;
    if (opts.type === "select") {
      control = el("select", { id: id }, opts.options.map(function (o) {
        return el("option", { value: o[0], text: o[1] });
      }));
    } else {
      var attrs = { id: id, type: opts.text ? "text" : "number" };
      if (opts.placeholder) attrs.placeholder = opts.placeholder;
      if (!opts.text) { attrs.step = "any"; attrs.min = "0"; }
      control = el("input", attrs);
    }
    els[key] = control;

    var cls = "input-wrap", pre = null, post = null;
    if (opts.money) { cls += " has-pre"; pre = el("span", { class: "affix affix--pre", text: "$" }); }
    if (opts.pct) { cls += " has-post"; post = el("span", { class: "affix affix--post", text: "%" }); }
    if (opts.post) { cls += " has-post"; post = el("span", { class: "affix affix--post", text: opts.post }); }

    return el("div", { class: "field" + (opts.full ? " field--full" : "") }, [
      el("label", { for: id, text: label }),
      el("div", { class: cls }, [pre, control, post]),
      opts.note ? el("div", { class: "field__note", id: id + "_note", text: opts.note }) : null
    ]);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k.slice(0, 2) === "on" && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] != null) {
          node.setAttribute(k, attrs[k]);
        }
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  window.Utils = {
    fmtUSD: fmtUSD,
    fmtUSDshort: fmtUSDshort,
    fmtPct: fmtPct,
    fmtSqft: fmtSqft,
    parseNum: parseNum,
    clamp: clamp,
    pctInput: pctInput,
    field: field,
    uuid: uuid,
    el: el
  };
})();
