// ============================================================
// Supabase Edge Function: buybox
// ------------------------------------------------------------
// Proxy/orchestrator for the 2yrflip "Buy Box" tab.
//   1. Parse the street address out of a Zillow listing URL slug
//      (we do NOT scrape Zillow page content — ToS-safe).
//   2. RentCast: sale listing (asking price, sqft, lot, coords)
//      + AVM value (comparable sales -> median $/sqft).
//   3. FEMA NFHL: flood zone by lat/long (free, keyless).
//   4. Return one normalized JSON payload to the browser.
//
// Secrets (set via `supabase secrets set`):
//   RENTCAST_KEY   — RentCast API key (required for live data)
//   ALLOWED_ORIGIN — e.g. https://mustardspam.github.io (CORS lock)
//
// Deploy:  supabase functions deploy buybox
// ============================================================

const RENTCAST_KEY = Deno.env.get("RENTCAST_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const RENTCAST_BASE = "https://api.rentcast.io/v1";
const FEMA_NFHL =
  "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query";

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Content-Type": "application/json",
  };
}

// ---- Zillow URL -> address ---------------------------------
// Zillow detail URLs look like:
//   https://www.zillow.com/homedetails/123-Main-St-Houston-TX-77007/12345678_zpid/
// The address is in the slug. We parse it; no page fetch.
function addressFromZillowUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/homedetails\/([^/]+)\/\d+_zpid/i)
      || u.pathname.match(/\/homedetails\/([^/]+)\//i);
    if (!m) return null;
    let slug = decodeURIComponent(m[1]);
    // "123-Main-St-Houston-TX-77007" -> "123 Main St Houston TX 77007"
    slug = slug.replace(/-/g, " ").replace(/\s+/g, " ").trim();
    // Normalize trailing "TX 77007" spacing is already fine for RentCast.
    return slug.length > 6 ? slug : null;
  } catch {
    return null;
  }
}

function zipFromAddress(addr: string): string {
  const m = addr.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---- RentCast helpers --------------------------------------
async function rcGet(path: string): Promise<any | null> {
  if (!RENTCAST_KEY) return null;
  try {
    const res = await fetch(`${RENTCAST_BASE}${path}`, {
      headers: { "X-Api-Key": RENTCAST_KEY, accept: "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getListing(address: string) {
  // Sale listing: asking price + facts + coords
  const q = encodeURIComponent(address);
  const listing = await rcGet(`/listings/sale?address=${q}`);
  const row = Array.isArray(listing) ? listing[0] : listing;
  if (!row) {
    // Fall back to property record (no asking price, but coords/sqft/lot)
    const prop = await rcGet(`/properties?address=${q}`);
    const p = Array.isArray(prop) ? prop[0] : prop;
    if (!p) return null;
    return {
      askingPrice: p.lastSalePrice ?? null,
      existingSqft: p.squareFootage ?? null,
      lotSizeSqft: p.lotSize ?? null,
      lat: p.latitude ?? null,
      lng: p.longitude ?? null,
      propertyType: p.propertyType ?? null,
    };
  }
  return {
    askingPrice: row.price ?? null,
    existingSqft: row.squareFootage ?? null,
    lotSizeSqft: row.lotSize ?? null,
    lat: row.latitude ?? null,
    lng: row.longitude ?? null,
    propertyType: row.propertyType ?? null,
  };
}

async function getComps(address: string, sqft: number | null, propertyType: string | null) {
  const params = new URLSearchParams({ address });
  if (sqft) params.set("squareFootage", String(sqft));
  if (propertyType) params.set("propertyType", propertyType);
  const avm = await rcGet(`/avm/value?${params.toString()}`);
  if (!avm) return null;
  const comps = Array.isArray(avm.comparables) ? avm.comparables : [];
  const perSqft = comps
    .map((c: any) => {
      const price = c.price ?? c.listPrice ?? c.lastSalePrice;
      const cs = c.squareFootage;
      return price && cs ? price / cs : null;
    })
    .filter((v: number | null): v is number => !!v && isFinite(v));
  if (!perSqft.length) return { medianPerSqft: 0, count: 0, lowPerSqft: 0, highPerSqft: 0, asOf: null };
  return {
    medianPerSqft: Math.round(median(perSqft)),
    count: perSqft.length,
    lowPerSqft: Math.round(Math.min(...perSqft)),
    highPerSqft: Math.round(Math.max(...perSqft)),
    asOf: avm.asOf ?? null,
  };
}

// ---- FEMA flood zone ---------------------------------------
async function getFloodZone(lat: number, lng: number) {
  try {
    const params = new URLSearchParams({
      geometry: `${lng},${lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "FLD_ZONE,ZONE_SUBTY",
      returnGeometry: "false",
      f: "json",
    });
    const res = await fetch(`${FEMA_NFHL}?${params.toString()}`);
    if (!res.ok) return { floodZone: "UNKNOWN", floodDesc: "FEMA lookup unavailable" };
    const data = await res.json();
    const feat = data?.features?.[0]?.attributes;
    if (!feat) return { floodZone: "X", floodDesc: "Outside mapped high-risk area (assumed Zone X)" };
    const zone = feat.FLD_ZONE || "UNKNOWN";
    const subty = feat.ZONE_SUBTY || "";
    return { floodZone: zone, floodDesc: subty || zoneLabel(zone) };
  } catch {
    return { floodZone: "UNKNOWN", floodDesc: "FEMA lookup failed" };
  }
}

function zoneLabel(zone: string): string {
  const z = zone.toUpperCase();
  if (z === "X" || z === "X500" || z.startsWith("AREA OF MINIMAL")) return "Minimal flood hazard";
  if (z.startsWith("V")) return "Coastal high-risk (VE) — flood insurance required";
  if (z.startsWith("A")) return "High-risk (SFHA) — flood insurance required";
  if (z === "D") return "Undetermined risk";
  return "See FEMA map";
}

// ---- handler ------------------------------------------------
Deno.serve(async (req) => {
  const headers = cors(ALLOWED_ORIGIN);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }

  // Accept either a Zillow URL or a raw address
  let address: string | null = body.address ?? null;
  if (!address && body.url) address = addressFromZillowUrl(String(body.url));
  if (!address) {
    return new Response(JSON.stringify({
      error: "Could not parse an address from that URL. Paste the full Zillow listing URL, or enter the address manually.",
    }), { status: 422, headers });
  }

  if (!RENTCAST_KEY) {
    return new Response(JSON.stringify({
      error: "Server missing RENTCAST_KEY. Set it with `supabase secrets set RENTCAST_KEY=...`.",
      address,
    }), { status: 503, headers });
  }

  const listing = await getListing(address);
  if (!listing) {
    return new Response(JSON.stringify({
      error: "No property data found for that address. Try the manual-entry path.",
      address,
    }), { status: 404, headers });
  }

  const [comps, flood] = await Promise.all([
    getComps(address, listing.existingSqft, listing.propertyType),
    (listing.lat != null && listing.lng != null)
      ? getFloodZone(listing.lat, listing.lng)
      : Promise.resolve({ floodZone: "UNKNOWN", floodDesc: "No coordinates for flood lookup" }),
  ]);

  const payload = {
    source: "rentcast+fema",
    address,
    zip: zipFromAddress(address),
    askingPrice: listing.askingPrice,
    lotSizeSqft: listing.lotSizeSqft,
    existingSqft: listing.existingSqft,
    lat: listing.lat,
    lng: listing.lng,
    comps: comps ?? { medianPerSqft: 0, count: 0, lowPerSqft: 0, highPerSqft: 0, asOf: null },
    floodZone: flood.floodZone,
    floodDesc: flood.floodDesc,
  };

  return new Response(JSON.stringify(payload), { headers });
});
