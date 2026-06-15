// ============================================================
// Supabase Edge Function: buybox  (hardened)
// ------------------------------------------------------------
// Proxy/orchestrator for the 2yrflip "Buy Box" tab.
//   1. Passcode gate (x-app-pass header vs APP_PASSCODE secret).
//   2. Address cache — repeat lookups don't re-bill RentCast.
//   3. Hard monthly cap — refuses before calling RentCast once the
//      self-set limit is reached (so RentCast overage is impossible).
//   4. Parse address from Zillow URL slug (no scraping).
//   5. RentCast listing + AVM comps; FEMA NFHL flood zone.
//
// Secrets (Edge Functions → Secrets):
//   RENTCAST_KEY       — RentCast API key            (required)
//   APP_PASSCODE       — shared access passcode       (required to lock)
//   MONTHLY_CALL_CAP   — max RentCast calls / month   (optional, default 48)
//   ALLOWED_ORIGIN     — CORS origin                  (optional, default *)
// Auto-injected by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ------------------------------------------------------------
// Requires usage_setup.sql to have been run once.
// ============================================================

const RENTCAST_KEY = Deno.env.get("RENTCAST_KEY") ?? "";
const APP_PASSCODE = Deno.env.get("APP_PASSCODE") ?? "";
const CAP_RAW = parseInt(Deno.env.get("MONTHLY_CALL_CAP") ?? "48", 10);
// Guard: a misconfigured (NaN / <=0) cap must NOT silently disable the limit.
const CAP = Number.isFinite(CAP_RAW) && CAP_RAW > 0 ? CAP_RAW : 48;
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const RENTCAST_BASE = "https://api.rentcast.io/v1";
const FEMA_NFHL =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-pass",
    "Content-Type": "application/json",
  };
}

function monthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---- Supabase (PostgREST) via service role ----------------
async function pg(path: string, init: RequestInit = {}) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}
// Atomically reserve n slots; returns { ok, count }.
// ok=false means cap exceeded and the reserve was rolled back.
async function tryReserve(month: string, n: number): Promise<{ ok: boolean; count: number }> {
  try {
    const r = await pg("rpc/try_reserve", {
      method: "POST",
      body: JSON.stringify({ p_month: month, p_n: n, p_cap: CAP }),
    });
    if (!r.ok) return { ok: false, count: 0 };
    const res = await r.json();
    return { ok: res.ok ?? false, count: Number(res.count) || 0 };
  } catch { return { ok: false, count: 0 }; }
}
// Release over-reserved slots after actual call count is known.
async function releaseUsage(month: string, n: number): Promise<void> {
  if (n <= 0) return;
  try {
    await pg("rpc/release_usage", { method: "POST", body: JSON.stringify({ p_month: month, p_n: n }) });
  } catch { /* ignore */ }
}
async function cacheGet(addr: string, month: string): Promise<any | null> {
  try {
    const r = await pg(`buybox_cache?address=eq.${encodeURIComponent(addr)}&month=eq.${month}&select=payload`);
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0]?.payload ?? null;
  } catch { return null; }
}
async function cachePut(addr: string, month: string, payload: any) {
  try {
    await pg("buybox_cache?on_conflict=address", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ address: addr, month, payload }),
    });
  } catch { /* ignore */ }
}

// ---- Zillow URL -> address ---------------------------------
function addressFromZillowUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/homedetails\/([^/]+)\/\d+_zpid/i) || u.pathname.match(/\/homedetails\/([^/]+)\//i);
    if (!m) return null;
    const slug = decodeURIComponent(m[1]).replace(/-/g, " ").replace(/\s+/g, " ").trim();
    return slug.length > 6 ? slug : null;
  } catch { return null; }
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

// ---- RentCast (dbg records each billable call) -------------
async function rcGet(path: string, dbg: string[]): Promise<any | null> {
  const tag = path.split("?")[0];
  if (!RENTCAST_KEY) { dbg.push(`${tag}:NO_KEY`); return null; }
  try {
    const res = await fetch(`${RENTCAST_BASE}${path}`, { headers: { "X-Api-Key": RENTCAST_KEY, accept: "application/json" } });
    dbg.push(`${tag}:${res.status}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { dbg.push(`${tag}:ERR`); return null; }
}
async function getListing(address: string, dbg: string[]) {
  const q = encodeURIComponent(address);
  const listing = await rcGet(`/listings/sale?address=${q}`, dbg);
  const row = Array.isArray(listing) ? listing[0] : listing;
  if (row) {
    return { askingPrice: row.price ?? null, existingSqft: row.squareFootage ?? null, lotSizeSqft: row.lotSize ?? null,
      lat: row.latitude ?? null, lng: row.longitude ?? null, propertyType: row.propertyType ?? null };
  }
  const prop = await rcGet(`/properties?address=${q}`, dbg);
  const p = Array.isArray(prop) ? prop[0] : prop;
  if (!p) return null;
  return { askingPrice: p.lastSalePrice ?? null, existingSqft: p.squareFootage ?? null, lotSizeSqft: p.lotSize ?? null,
    lat: p.latitude ?? null, lng: p.longitude ?? null, propertyType: p.propertyType ?? null };
}
async function getComps(address: string, sqft: number | null, propertyType: string | null, dbg: string[]) {
  const params = new URLSearchParams({ address });
  if (sqft) params.set("squareFootage", String(sqft));
  if (propertyType) params.set("propertyType", propertyType);
  const avm = await rcGet(`/avm/value?${params.toString()}`, dbg);
  if (!avm) return null;
  const comps = Array.isArray(avm.comparables) ? avm.comparables : [];
  const compDetails = comps.map((c: any) => {
    const price = c.price ?? c.listPrice ?? c.lastSalePrice;
    const psf = price && c.squareFootage ? Math.round(price / c.squareFootage) : null;
    const addr = [c.addressLine1, c.city, c.state, c.zipCode].filter(Boolean).join(", ")
      || c.address || "";
    return psf != null && isFinite(psf)
      ? { address: addr, price: price ?? null, sqft: c.squareFootage ?? null, psf, distance: c.distance ?? null }
      : null;
  }).filter(Boolean);
  if (!compDetails.length) return { medianPerSqft: 0, count: 0, lowPerSqft: 0, highPerSqft: 0, asOf: null, compDetails: [] };
  const perSqft = compDetails.map((c: any) => c.psf);
  return { medianPerSqft: Math.round(median(perSqft)), count: perSqft.length,
    lowPerSqft: Math.round(Math.min(...perSqft)), highPerSqft: Math.round(Math.max(...perSqft)),
    asOf: avm.asOf ?? null, compDetails };
}

// ---- FEMA flood zone ---------------------------------------
async function getFloodZone(lat: number, lng: number) {
  try {
    const params = new URLSearchParams({
      geometry: `${lng},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
      spatialRel: "esriSpatialRelIntersects", outFields: "FLD_ZONE,ZONE_SUBTY", returnGeometry: "false", f: "json",
    });
    const res = await fetch(`${FEMA_NFHL}?${params.toString()}`);
    if (!res.ok) return { floodZone: "UNKNOWN", floodDesc: "FEMA lookup unavailable" };
    const data = await res.json();
    const feat = data?.features?.[0]?.attributes;
    if (!feat) return { floodZone: "X", floodDesc: "Outside mapped high-risk area (assumed Zone X)" };
    return { floodZone: feat.FLD_ZONE || "UNKNOWN", floodDesc: feat.ZONE_SUBTY || zoneLabel(feat.FLD_ZONE || "") };
  } catch { return { floodZone: "UNKNOWN", floodDesc: "FEMA lookup failed" }; }
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
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });

  // 1) passcode gate
  if (APP_PASSCODE) {
    const pass = req.headers.get("x-app-pass") ?? "";
    if (pass !== APP_PASSCODE) {
      return new Response(JSON.stringify({ error: "Unauthorized — enter the app passcode." }), { status: 401, headers });
    }
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  let address: string | null = body.address ?? null;
  if (!address && body.url) address = addressFromZillowUrl(String(body.url));
  if (!address) {
    return new Response(JSON.stringify({ error: "Could not parse an address from that URL. Paste the full Zillow URL or enter the address manually." }), { status: 422, headers });
  }
  if (!RENTCAST_KEY) {
    return new Response(JSON.stringify({ error: "Server missing RENTCAST_KEY." }), { status: 503, headers });
  }

  const month = monthKey();
  const addrKey = address.toLowerCase();

  // 2) cache — free, always allowed
  const cached = await cacheGet(addrKey, month);
  if (cached) { cached.cached = true; return new Response(JSON.stringify(cached), { headers }); }

  // 3) hard monthly cap — atomically reserve up to 3 slots before touching RentCast.
  // tryReserve increments then rolls back if the new total exceeds CAP, so two
  // concurrent requests can't both pass a cap that's about to be hit.
  const { ok: capOk, count: reservedAt } = await tryReserve(month, 3);
  if (!capOk) {
    return new Response(JSON.stringify({
      error: `Monthly lookup limit reached (${CAP} RentCast calls). Resets on the 1st. Edit fields manually to keep going.`,
      usage: { used: reservedAt, cap: CAP },
    }), { status: 429, headers });
  }

  const dbg: string[] = [];
  const listing = await getListing(address, dbg);
  // count only calls that actually reached RentCast (got an HTTP status)
  const billed = () => dbg.filter((s) => /^\/(listings|properties|avm)/.test(s) && /:\d+$/.test(s)).length;

  if (!listing) {
    const n = billed();
    await releaseUsage(month, 3 - n);
    return new Response(JSON.stringify({ error: "No property data found for that address. Try the manual-entry path.", address, debug: { calls: dbg } }), { status: 404, headers });
  }

  const [comps, flood] = await Promise.all([
    getComps(address, listing.existingSqft, listing.propertyType, dbg),
    (listing.lat != null && listing.lng != null) ? getFloodZone(listing.lat, listing.lng)
      : Promise.resolve({ floodZone: "UNKNOWN", floodDesc: "No coordinates for flood lookup" }),
  ]);

  const n = billed();
  await releaseUsage(month, 3 - n);              // return any unused slots
  const newUsed = reservedAt - Math.max(0, 3 - n);

  const payload = {
    source: "rentcast+fema", address, zip: zipFromAddress(address),
    askingPrice: listing.askingPrice, lotSizeSqft: listing.lotSizeSqft, existingSqft: listing.existingSqft,
    lat: listing.lat, lng: listing.lng,
    comps: comps ?? { medianPerSqft: 0, count: 0, lowPerSqft: 0, highPerSqft: 0, asOf: null },
    floodZone: flood.floodZone, floodDesc: flood.floodDesc,
    usage: { used: newUsed, cap: CAP },
  };
  await cachePut(addrKey, month, payload);
  return new Response(JSON.stringify(payload), { headers });
});
