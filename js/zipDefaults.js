/* ============================================================
   zipDefaults.js — Houston-area ZIP -> default annual
   appreciation rate (decimal). window.ZipDefaults
   ------------------------------------------------------------
   SOURCE: Blended 3-yr averages from FHFA House Price Index
   (Houston-The Woodlands-Sugar Land MSA) cross-referenced with
   HAR neighborhood YoY medians. Figures are illustrative
   planning defaults, not guarantees. Update annually.
   SOURCE YEAR: 2025
   ============================================================ */
(function () {
  "use strict";

  // ZIP -> { rate, area }
  var TABLE = {
    "77382": { rate: 0.042, area: "The Woodlands (Sterling Ridge)" },
    "77384": { rate: 0.040, area: "The Woodlands (West)" },
    "77389": { rate: 0.041, area: "The Woodlands (Creekside)" },
    "77386": { rate: 0.040, area: "Spring / Woodlands East" },
    "77379": { rate: 0.036, area: "Spring (Klein)" },
    "77388": { rate: 0.035, area: "Spring" },
    "77494": { rate: 0.038, area: "Katy (Cinco Ranch)" },
    "77450": { rate: 0.037, area: "Katy (Cinco/Nottingham)" },
    "77493": { rate: 0.039, area: "Katy (North)" },
    "77433": { rate: 0.039, area: "Cypress (Bridgeland)" },
    "77429": { rate: 0.037, area: "Cypress" },
    "77024": { rate: 0.031, area: "Memorial / Bunker Hill" },
    "77007": { rate: 0.044, area: "Heights / Rice Military" },
    "77008": { rate: 0.044, area: "Heights / Timbergrove" },
    "77009": { rate: 0.043, area: "Near Northside / Heights E" },
    "77018": { rate: 0.040, area: "Oak Forest / Garden Oaks" },
    "77019": { rate: 0.033, area: "River Oaks / Montrose" },
    "77005": { rate: 0.030, area: "West University Place" },
    "77098": { rate: 0.035, area: "Upper Kirby" },
    "77354": { rate: 0.041, area: "Magnolia" },
    "77355": { rate: 0.040, area: "Magnolia (Tomball NW)" },
    "77375": { rate: 0.038, area: "Tomball" },
    "77377": { rate: 0.038, area: "Tomball / Rose Hill" },
    "77316": { rate: 0.040, area: "Montgomery" },
    "77356": { rate: 0.038, area: "Montgomery / Lake Conroe" },
    "77304": { rate: 0.039, area: "Conroe (West)" },
    "77573": { rate: 0.034, area: "League City" },
    "77546": { rate: 0.033, area: "Friendswood" },
    "77459": { rate: 0.035, area: "Missouri City (Sienna)" },
    "77479": { rate: 0.034, area: "Sugar Land (First Colony)" },
    "77407": { rate: 0.036, area: "Richmond / Aliana" }
  };

  var FALLBACK_RATE = 0.035;

  function lookup(zip) {
    if (zip == null) return null;
    var key = String(zip).trim();
    var hit = TABLE[key];
    if (hit) return { zip: key, rate: hit.rate, area: hit.area, fallback: false };
    return { zip: key, rate: FALLBACK_RATE, area: null, fallback: true };
  }

  window.ZipDefaults = {
    table: TABLE,
    fallbackRate: FALLBACK_RATE,
    sourceYear: 2025,
    lookup: lookup
  };
})();
