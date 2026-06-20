/* ============================================================
   dealMath.js — shared equity-capture model (window.DealMath)
   Single source of truth for "is this raw-land deal worth it,"
   used by both the Buy Box tab (one lot at a time) and the
   Lot Finder tab (many candidates at once). Keeping the math in
   one place means the two tabs can never score the same lot
   differently.
   ============================================================ */
(function () {
  "use strict";

  var U = window.Utils;
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

  // ---- compute -------------------------------------------------------
  // Forward equity-capture projection for a RAW-LAND build:
  // buy lot (asking = cost) -> build -> hold ~2yr -> sell. Reports the real
  // equity captured and how much of it §121 shelters tax-free.
  // Economic track (carry INCLUDED) and tax track (carry EXCLUDED) are kept
  // separate — tax gain is structurally larger than real profit by the carry.
  // listing: {askingPrice, compPsf, compCount, lowPsf, highPsf, floodZone}
  function computeDeal(listing, assumptions) {
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

  window.DealMath = {
    ASSUMPTION_DEFAULTS: ASSUMPTION_DEFAULTS,
    EXCLUSION: EXCLUSION,
    ROI_TARGET: ROI_TARGET,
    GO_ROI_MIN: GO_ROI_MIN,
    LOT_FLOOR: LOT_FLOOR,
    LOT_CEIL: LOT_CEIL,
    computeDeal: computeDeal,
    floodScore: floodScore,
    floodTone: floodTone
  };
})();
