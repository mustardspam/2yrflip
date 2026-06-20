/* ============================================================
   lotfinder.js — "Lot Finder" tab (window.LotFinder)
   Area search: drop a pin + radius, set targets, get back raw-land
   candidates with comps attached. Scoring reuses DealMath.computeDeal
   (the same engine Buy Box uses) so results are directly comparable
   to a manual Buy Box lookup of the same address.
   ============================================================ */
(function () {
  "use strict";

  var U = window.Utils;
  var DealMath = window.DealMath;

  var DEFAULT_CENTER = { lat: 29.7604, lng: -95.3698 }; // downtown Houston
  var SHORTLIST_K = 10; // mirrors the Edge Function's hard cap — used for the pre-search estimate only

  var searchParams = {
    centerLat: DEFAULT_CENTER.lat, centerLng: DEFAULT_CENTER.lng,
    radiusMiles: 3, maxLotPrice: 0, targetEquity: 100000
  };
  var assumptions = Object.assign({}, DealMath.ASSUMPTION_DEFAULTS);

  var els = {};
  var resultHost = null, statusHost = null, scanHost = null;
  var map = null, centerMarker = null, radiusCircle = null;
  var resultMarkers = [];
  var lastCandidates = []; // raw listing+comp data from the last search, before scoring
  var lastResults = [];    // {listing, deal} — scored from lastCandidates, sorted desc by equity

  // ---- map -------------------------------------------------------------
  function milesToMeters(mi) { return mi * 1609.34; }

  function initMap(container) {
    map = L.map(container, { scrollWheelZoom: false }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 18
    }).addTo(map);

    centerMarker = L.marker([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], { draggable: true }).addTo(map);
    radiusCircle = L.circle([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], {
      radius: milesToMeters(searchParams.radiusMiles), color: "#1f3350", weight: 2, dashArray: "6 5",
      fillColor: "#1f3350", fillOpacity: 0.06
    }).addTo(map);

    centerMarker.on("drag", function (e) { setCenter(e.target.getLatLng().lat, e.target.getLatLng().lng); });
    map.on("click", function (e) { centerMarker.setLatLng(e.latlng); setCenter(e.latlng.lat, e.latlng.lng); });

    setTimeout(function () { if (map) map.invalidateSize(); }, 50);
  }

  function setCenter(lat, lng) {
    searchParams.centerLat = lat; searchParams.centerLng = lng;
    if (centerMarker) centerMarker.setLatLng([lat, lng]);
    if (radiusCircle) radiusCircle.setLatLng([lat, lng]);
  }

  function setRadius(mi) {
    searchParams.radiusMiles = mi;
    if (radiusCircle) radiusCircle.setRadius(milesToMeters(mi));
  }

  // Free OSM geocoder — fair-use limited (~1 req/sec), fine for occasional manual lookups.
  function geocode(query) {
    if (!query) return;
    status("Locating " + query + "…", "loading");
    fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(query))
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!rows || !rows.length) { status("Couldn't find that location.", "warn"); return; }
        var lat = parseFloat(rows[0].lat), lng = parseFloat(rows[0].lon);
        setCenter(lat, lng);
        map.setView([lat, lng], 12);
        status("Centered on " + (rows[0].display_name || query) + ".", "ok");
      })
      .catch(function () { status("Geocoding lookup failed.", "error"); });
  }

  function clearResultMarkers() {
    resultMarkers.forEach(function (m) { map.removeLayer(m); });
    resultMarkers = [];
  }

  function pinColor(verdict) {
    return verdict === "go" ? "#1f9d6b" : (verdict === "caution" ? "#b9831c" : "#d24b4b");
  }

  function addResultMarker(item, idx) {
    var lat = item.listing.lat, lng = item.listing.lng;
    if (lat == null || lng == null) return;
    var marker = L.circleMarker([lat, lng], {
      radius: 7, color: "#fff", weight: 2, fillColor: pinColor(item.deal.verdict), fillOpacity: 0.95
    }).addTo(map);
    marker.on("click", function () {
      var card = document.getElementById("lf_card_" + idx);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("is-pulse");
        setTimeout(function () { card.classList.remove("is-pulse"); }, 1200);
      }
    });
    resultMarkers.push(marker);
  }

  // ---- passcode (shared secret with Buy Box) ----------------------------
  function getPass() {
    var p = localStorage.getItem("bb_passcode");
    if (!p) {
      p = (window.prompt("Enter the Buy Box / Lot Finder access passcode:") || "").trim();
      if (p) localStorage.setItem("bb_passcode", p);
    }
    return p;
  }

  function status(msg, kind) {
    if (!statusHost) return;
    statusHost.textContent = msg || "";
    statusHost.className = "bb-status" + (kind ? " bb-status--" + kind : "");
  }

  // ---- mock data (pre-deploy / demo) ------------------------------------
  function strHash(s) {
    var h = 0; s = String(s);
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }
  function mockSearch() {
    var n = 6 + (strHash(searchParams.centerLat + "," + searchParams.centerLng) % 6); // 6–11
    var candidates = [];
    for (var i = 0; i < n; i++) {
      var seed = strHash(searchParams.centerLat + "," + searchParams.centerLng + ":" + i);
      var psf = 180 + (seed % 160);
      var asking = 70000 + (seed % 16) * 17000;
      var dlat = ((seed % 200) - 100) / 100 * (searchParams.radiusMiles / 69); // rough mi->deg
      var dlng = (((seed >> 4) % 200) - 100) / 100 * (searchParams.radiusMiles / 60);
      candidates.push({
        listing: {
          address: (1000 + seed % 9000) + " Sample St, Houston, TX 770" + (seed % 90 + 10),
          askingPrice: asking, lotSizeSqft: 6000 + (seed % 4000),
          lat: searchParams.centerLat + dlat, lng: searchParams.centerLng + dlng
        },
        comps: { medianPerSqft: psf, count: 4 + (seed % 6), lowPerSqft: Math.round(psf * 0.85), highPerSqft: Math.round(psf * 1.15) },
        floodZone: ["X", "X", "X500", "AE", "A"][seed % 5],
        cached: false
      });
    }
    return { candidates: candidates, scanned: n, shortlisted: n, usage: { used: 0, cap: 48 } };
  }

  // ---- search ------------------------------------------------------------
  function confirmAndSearch() {
    readInputs();
    var worstCase = 1 + SHORTLIST_K;
    var cfg = window.LOTFINDER_CONFIG || {};
    var mock = cfg.USE_MOCK || !cfg.FUNCTION_URL;
    var msg = mock
      ? "Run a sample search (mock mode — no API calls)?"
      : "This search may use up to " + worstCase + " RentCast calls against your monthly cap. Continue?";
    if (!window.confirm(msg)) return;
    runSearch(mock, cfg);
  }

  function runSearch(mock, cfg) {
    status("Searching…", "loading");
    resultHost.innerHTML = "";
    clearResultMarkers();

    if (mock) {
      applyResponse(mockSearch());
      status("Sample candidates (mock mode). Deploy the Edge Function for live data.", "info");
      return;
    }

    var pass = getPass();
    if (!pass) { status("Passcode required for live search.", "warn"); return; }

    fetch(cfg.FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + (cfg.SUPABASE_ANON_KEY || ""),
        "apikey": cfg.SUPABASE_ANON_KEY || "",
        "x-app-pass": pass
      },
      body: JSON.stringify({
        lat: searchParams.centerLat, lng: searchParams.centerLng,
        radiusMiles: searchParams.radiusMiles, maxLotPrice: searchParams.maxLotPrice
      })
    }).then(function (res) {
      return res.json().then(function (j) { return { status: res.status, ok: res.ok, j: j }; });
    }).then(function (r) {
      if (r.status === 401) {
        localStorage.removeItem("bb_passcode");
        status("Passcode rejected. Click Search to re-enter it.", "error");
        return;
      }
      if (r.status === 429) { status(r.j.error || "Monthly lookup limit reached.", "error"); return; }
      if (!r.ok) { status(r.j.error || "Search failed.", "error"); return; }
      applyResponse(r.j);
      var u = r.j.usage;
      var quota = u ? "  ·  " + u.used + "/" + u.cap + " lookups used this month" : "";
      status("Found " + r.j.scanned + " lot" + (r.j.scanned === 1 ? "" : "s") + " in range, scored top " +
        r.j.shortlisted + "." + quota, "ok");
    }).catch(function () {
      status("Network error. Try again.", "error");
    });
  }

  function applyResponse(resp) {
    lastCandidates = (resp.candidates || []).map(function (c) {
      var listing = {
        askingPrice: c.listing.askingPrice, compPsf: (c.comps && c.comps.medianPerSqft) || 0,
        compCount: (c.comps && c.comps.count) || 0, lowPsf: (c.comps && c.comps.lowPerSqft) || 0,
        highPsf: (c.comps && c.comps.highPerSqft) || 0, floodZone: c.floodZone || "X"
      };
      listing.address = c.listing.address; listing.lat = c.listing.lat; listing.lng = c.listing.lng;
      listing.lotSizeSqft = c.listing.lotSizeSqft; listing.compDetails = (c.comps && c.comps.compDetails) || [];
      return listing;
    });
    rescore();
  }

  // Re-runs DealMath.computeDeal() over already-fetched candidates with the
  // CURRENT assumptions/filters — no re-fetch, so editing a build assumption
  // after a search is free and instant, same as Buy Box's live recalc.
  function rescore() {
    var pool = searchParams.maxLotPrice > 0
      ? lastCandidates.filter(function (l) { return l.askingPrice <= searchParams.maxLotPrice; })
      : lastCandidates;
    var results = pool.map(function (listing) {
      return { listing: listing, deal: DealMath.computeDeal(listing, assumptions) };
    });
    results.sort(function (a, b) { return b.deal.economicEquityAfterTax - a.deal.economicEquityAfterTax; });
    lastResults = results;
    if (scanHost) {
      scanHost.textContent = lastCandidates.length
        ? lastCandidates.length + " scored · " + results.filter(meetsTarget).length + " meet target"
        : "";
    }
    renderResults();
  }

  function meetsTarget(r) {
    return searchParams.targetEquity <= 0 || r.deal.economicEquityAfterTax >= searchParams.targetEquity;
  }

  // ---- results UI --------------------------------------------------------
  function miniDial(score, verdict) {
    var color = verdict === "go" ? "var(--green)" : (verdict === "caution" ? "var(--gold-dark)" : "var(--red)");
    return U.el("div", { class: "lf-dial", style: "border-color:" + color + ";color:" + color }, [String(score)]);
  }

  function verdictLabel(verdict) {
    return verdict === "go" ? "Pursue" : (verdict === "caution" ? "Maybe" : "Pass");
  }

  function resultCard(item, idx) {
    var d = item.deal, L = item.listing;
    var verdictClass = d.verdict === "go" ? "ok" : (d.verdict === "caution" ? "warn" : "bad");
    var roiTxt = d.annualizedRoi != null ? U.fmtPct(d.annualizedRoi) + "/yr" : "—";
    var card = U.el("div", { class: "lf-card lf-card--" + verdictClass, id: "lf_card_" + idx }, [
      U.el("div", { class: "lf-card__head" }, [
        U.el("div", {}, [
          U.el("div", { class: "lf-card__addr", text: L.address || "Address unavailable" }),
          U.el("div", { class: "lf-card__sub", text: U.fmtUSD(L.askingPrice) + (L.lotSizeSqft ? " · " + U.fmtSqft(L.lotSizeSqft) : "") })
        ]),
        U.el("div", { class: "lf-card__verdict" }, [
          miniDial(d.score, d.verdict),
          U.el("span", { class: "lf-card__verdict-label", text: verdictLabel(d.verdict) })
        ])
      ]),
      U.el("div", { class: "lf-card__metrics" }, [
        U.el("div", {}, [U.el("div", { class: "label-cap", text: "After-tax equity" }), U.el("div", { class: "lf-card__metric" + (d.economicEquityAfterTax < 0 ? " is-neg" : ""), text: U.fmtUSD(d.economicEquityAfterTax) })]),
        U.el("div", {}, [U.el("div", { class: "label-cap", text: "Return" }), U.el("div", { class: "lf-card__metric", text: roiTxt })]),
        U.el("div", {}, [U.el("div", { class: "label-cap", text: "Monthly note" }), U.el("div", { class: "lf-card__metric", text: U.fmtUSD(d.monthlyPITI) })])
      ]),
      U.el("button", { class: "btn btn--ghost lf-card__btn", type: "button", onclick: function () { sendToBuyBox(L); } },
        ["View full breakdown in Buy Box →"])
    ]);
    return card;
  }

  function sendToBuyBox(L) {
    if (!window.BuyBox || !window.BuyBox.loadListing || !window.App) return;
    window.App.activate("buybox"); // must run first — lazily creates Buy Box's inputs (els) on first visit
    window.BuyBox.loadListing({
      address: L.address, askingPrice: L.askingPrice, compPsf: L.compPsf, compCount: L.compCount,
      lowPsf: L.lowPsf, highPsf: L.highPsf, floodZone: L.floodZone, lat: L.lat, lng: L.lng,
      compDetails: L.compDetails, assumptions: assumptions
    });
  }

  function collapseRow(label, items, startIdx) {
    var open = false;
    var body = U.el("div", { class: "lf-collapse__body is-hidden" }, items.map(function (it, i) { return resultCard(it, startIdx + i); }));
    var head = U.el("div", { class: "lf-collapse__head" }, [
      U.el("span", { text: label }),
      U.el("i", { class: "lf-collapse__chev", text: "▾" })
    ]);
    head.addEventListener("click", function () {
      open = !open;
      body.classList.toggle("is-hidden", !open);
      head.classList.toggle("is-open", open);
    });
    return U.el("div", { class: "lf-collapse" }, [head, body]);
  }

  function renderResults() {
    resultHost.innerHTML = "";
    clearResultMarkers();
    if (!lastResults.length) {
      resultHost.appendChild(U.el("div", { class: "empty", text: "Search an area to see candidate lots here." }));
      return;
    }
    var meets = lastResults.filter(meetsTarget);
    var below = lastResults.filter(function (r) { return !meetsTarget(r); });

    if (!meets.length) {
      resultHost.appendChild(U.el("div", { class: "empty", text: "No candidates in range meet your target equity. Try a larger radius or a lower target." }));
    } else {
      meets.forEach(function (item, i) { resultHost.appendChild(resultCard(item, i)); });
    }
    if (below.length) {
      resultHost.appendChild(collapseRow(below.length + " below target", below, meets.length));
    }
    lastResults.forEach(function (item, i) { addResultMarker(item, i); });
  }

  // ---- input plumbing ------------------------------------------------------
  function readInputs() {
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
    searchParams.targetEquity = U.parseNum(els.targetEquity.value);
    searchParams.maxLotPrice = U.parseNum(els.maxLotPrice.value);
  }

  function setAssumptionInputs() {
    els.plannedSqft.value = assumptions.plannedSqft;
    els.costPerSqft.value = assumptions.costPerSqft;
    els.appreciationRate.value = U.pctInput(assumptions.appreciationRate);
    els.holdMonths.value = assumptions.holdMonths;
    els.filingStatus.value = assumptions.filingStatus;
    els.sellClosingPct.value = U.pctInput(assumptions.sellClosingPct);
    els.acqClosingPct.value = U.pctInput(assumptions.acqClosingPct);
    els.carryPct.value = U.pctInput(assumptions.carryPct);
    els.demoCost.value = assumptions.demoCost;
    els.ltcgRate.value = U.pctInput(assumptions.ltcgRate);
    els.mortgageRate.value = U.pctInput(assumptions.mortgageRate);
    els.mortgageTermYears.value = assumptions.mortgageTermYears;
    els.propertyTaxRate.value = U.pctInput(assumptions.propertyTaxRate);
    els.homeInsuranceRate.value = U.pctInput(assumptions.homeInsuranceRate);
    els.pmiRate.value = U.pctInput(assumptions.pmiRate);
    els.targetEquity.value = searchParams.targetEquity;
    els.maxLotPrice.value = searchParams.maxLotPrice || "";
  }

  function field(key, label, opts) { return U.field(els, "lf", key, label, opts); }

  // ---- init ----------------------------------------------------------------
  function init(panel) {
    var mapContainer = U.el("div", { class: "lf-map", id: "lf_map" });
    var radiusSlider = U.el("input", { type: "range", min: "0.5", max: "10", step: "0.5", value: "3" });
    var radiusOut = U.el("span", { class: "lf-radius-out", text: "3.0 mi" });
    radiusSlider.addEventListener("input", function () {
      var mi = parseFloat(radiusSlider.value);
      setRadius(mi);
      radiusOut.textContent = mi.toFixed(1) + " mi";
    });
    els.radius = radiusSlider;
    var radiusRow = U.el("div", { class: "lf-radius-row" }, [
      U.el("span", { class: "label-cap", text: "Radius" }), radiusSlider, radiusOut
    ]);

    var addressRow = U.el("div", { class: "bb-urlrow" }, [
      U.el("input", { id: "lf_addr_search", type: "text", placeholder: "Center on address…" }),
      U.el("button", { class: "btn", type: "button", onclick: function () {
        geocode(document.getElementById("lf_addr_search").value.trim());
      } }, ["Locate"])
    ]);

    statusHost = U.el("div", { class: "bb-status", id: "lf_status" });

    var assumpGrid = U.el("div", { class: "field-grid" }, [
      field("plannedSqft", "Planned build size", { post: "sqft" }),
      field("costPerSqft", "Build cost / sqft", { money: true }),
      field("appreciationRate", "Appreciation / yr", { pct: true }),
      field("holdMonths", "Hold period", { post: "mo" }),
      field("filingStatus", "Filing status", { type: "select", options: [["mfj", "Married — joint"], ["single", "Single"]] }),
      field("sellClosingPct", "Sell-side closing", { pct: true }),
      field("acqClosingPct", "Acquisition closing", { pct: true }),
      field("carryPct", "Annual carry cost", { pct: true }),
      field("demoCost", "Demolition cost", { money: true }),
      field("ltcgRate", "LT cap-gains rate", { pct: true })
    ]);

    var financeGrid = U.el("div", { class: "field-grid" }, [
      field("mortgageRate", "Mortgage rate", { pct: true }),
      field("mortgageTermYears", "Mortgage term", { post: "yrs" }),
      field("propertyTaxRate", "Property tax rate", { pct: true }),
      field("homeInsuranceRate", "Homeowners insurance", { pct: true }),
      field("pmiRate", "PMI rate", { pct: true, note: "Applied only if LTV > 80%" })
    ]);

    var filterGrid = U.el("div", { class: "field-grid" }, [
      field("targetEquity", "Target after-tax equity (min)", { money: true }),
      field("maxLotPrice", "Max lot price", { money: true, note: "Optional — 0 = no cap" })
    ]);

    var searchBtn = U.el("button", { class: "btn btn--primary", type: "button", onclick: confirmAndSearch }, ["Search this area"]);

    var inputPanel = U.el("section", { class: "panel" }, [
      U.el("div", { class: "panel-head" }, [
        U.el("h2", { text: "Lot Finder" }),
        U.el("p", { text: "Drop a pin, set your targets, find lots that pencil." })
      ]),
      mapContainer, radiusRow, addressRow, statusHost,
      U.el("div", { class: "bb-subhead" }, [U.el("h3", { text: "Build assumptions" })]),
      assumpGrid,
      U.el("div", { class: "bb-subhead" }, [U.el("h3", { text: "Permanent financing" })]),
      financeGrid,
      U.el("div", { class: "bb-subhead" }, [U.el("h3", { text: "Search filters" })]),
      filterGrid,
      U.el("div", { class: "input-actions" }, [searchBtn])
    ]);

    resultHost = U.el("div", { class: "lf-results" });
    var resultPanel = U.el("section", { class: "panel results-panel" }, [
      U.el("div", { class: "results-head" }, [
        U.el("h2", { text: "Candidate lots" }),
        (function () { scanHost = U.el("span", { class: "label-cap" }); return scanHost; })()
      ]),
      resultHost
    ]);

    panel.appendChild(U.el("div", { class: "calc-grid" }, [inputPanel, resultPanel]));

    setAssumptionInputs();
    initMap(mapContainer);

    Object.keys(els).forEach(function (k) {
      if (k === "radius") return;
      var onChange = function () { readInputs(); rescore(); };
      els[k].addEventListener("input", onChange);
      if (els[k].tagName === "SELECT") els[k].addEventListener("change", onChange);
    });
  }

  window.LotFinder = {
    tab: { id: "lotfinder", label: "Lot Finder", init: init }
  };
})();
