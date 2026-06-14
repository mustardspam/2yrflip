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
// Secrets (set in dashboard → Edge Functions → Secrets):
//   RENTCAST_KEY   — RentCast API key (required for live data)
//   ALLOWED_ORIGIN — e.g. https://mustardspam.github.io (CORS lock)
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
function addressFromZillowUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/homedetails\/([^/]+)\/\d+_zpid/i)
      || u.pathname.match(/\/homedetails\/([^/]+)\//i);
    if (!m) return null;
    let slug = decodeURIComponent(m[1]);
    slug = slug.replace(/-/g, " ").replace(/\s+/g, " ").trim();
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

// ---- RentCast helpers (with diagnostics) -------------------
async function rcGet(path: string, dbg: string[]): Promise<any | null> {
  const tag = path.split("?")[0];
  if (!RENTCAST_KEY) { dbg.push(`${tag}:NO_KEY`); return null; }
  try {
    const res = await fetch(`${RENTCAST_BASE}${path}`, {
      headers: { "X-Api-Key": RENTCAST_KEY, accept: "application/json" },
    });
    dbg.push(`${tag}:${res.status}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    dbg.push(`${tag}:ERR`);
    return null;
  }
}

async function getListing(address: string, dbg: string[]) {
  const q = encodeURIComponent(address);
  const listing = await rcGet(`/listings/sale?address=${q}`, dbg);
  const row = Array.isArray(listing) ? listing[0] : listing;
  if (row) {
    return {
      askingPrice: row.price ?? null,
      existingSqft: row.squareFootage ?? null,
      lotSizeSqft: row.lotSize ?? null,
      lat: row.latitude ?? null,
      lng: row.longitude ?? null,
      propertyType: row.propertyType ?? null,
    };
  }
  // Fall back to property record (no asking price, but facts/coords)
  const prop = await rcGet(`/properties?address=${q}`, dbg);
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

async function getComps(address: string, sqft: number | null, propertyType: string | null, dbg: string[]) {
  const params = new URLSearchParams({ address });
  if (sqft) params.set("squareFootage", String(sqft));
  if (propertyType) params.set("propertyType", propertyType);
  const avm = await rcGet(`/avm/value?${params.toString()}`, dbg);
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

  let address: string | null = body.address ?? null;
  if (!address && body.url) address = addressFromZillowUrl(String(body.url));
  if (!address) {
    return new Response(JSON.stringify({
      error: "Could not parse an address from that URL. Paste the full Zillow listing URL, or enter the address manually.",
    }), { status: 422, headers });
  }

  if (!RENTCAST_KEY) {
    return new Response(JSON.stringify({
      error: "Server missing RENTCAST_KEY. Set it in Edge Functions → Secrets.",
      address,
    }), { status: 503, headers });
  }

  const dbg: string[] = [];
  const listing = await getListing(address, dbg);
  if (!listing) {
    return new Response(JSON.stringify({
      error: "No property data found for that address. Try the manual-entry path.",
      address,
      debug: { hasKey: !!RENTCAST_KEY, keyLen: RENTCAST_KEY.length, calls: dbg },
    }), { status: 404, headers });
  }

  const [comps, flood] = await Promise.all([
    getComps(address, listing.existingSqft, listing.propertyType, dbg),
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
    debug: { calls: dbg },
  };

  return new Response(JSON.stringify(payload), { headers });
});
