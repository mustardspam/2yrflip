/* ============================================================
   storage.js — localStorage persistence (window.Store)
   Key: s121_scenarios  ->  JSON array of Scenario objects
   ============================================================ */
(function () {
  "use strict";

  var KEY = "s121_scenarios";
  var available = (function () {
    try {
      var t = "__s121_test__";
      window.localStorage.setItem(t, "1");
      window.localStorage.removeItem(t);
      return true;
    } catch (e) {
      return false;
    }
  })();

  // In-memory fallback if localStorage is blocked (e.g. some file:// modes)
  var mem = [];

  function readRaw() {
    if (!available) return mem.slice();
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn("Store: failed to parse, resetting.", e);
      return [];
    }
  }

  function writeRaw(arr) {
    if (!available) { mem = arr.slice(); return; }
    try {
      window.localStorage.setItem(KEY, JSON.stringify(arr));
    } catch (e) {
      console.warn("Store: write failed.", e);
    }
  }

  function load() { return readRaw(); }

  function get(id) {
    return readRaw().filter(function (s) { return s.id === id; })[0] || null;
  }

  function add(scenario) {
    var arr = readRaw();
    arr.push(scenario);
    writeRaw(arr);
    return scenario;
  }

  function update(id, patch) {
    var arr = readRaw().map(function (s) {
      return s.id === id ? Object.assign({}, s, patch) : s;
    });
    writeRaw(arr);
    return get(id);
  }

  function remove(id) {
    writeRaw(readRaw().filter(function (s) { return s.id !== id; }));
  }

  function clear() { writeRaw([]); }

  window.Store = {
    storageAvailable: available,
    load: load,
    get: get,
    add: add,
    update: update,
    remove: remove,
    clear: clear
  };
})();
