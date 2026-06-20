// ============================================================
// Supabase Edge Function: lotfinder
// ------------------------------------------------------------
// Area-search sibling to `buybox`. Instead of one address in,
// one analysis out, this takes a center point + radius and
// returns a SHORTLIST of raw-land candidates with comps already
// attached — equity-capture math itself stays client-side
// (DealMath.computeDeal), exactly like a Buy Box lookup.
//
// Cost control (this is the whole point of this function):
//   1. ONE RentCast land-listings call pulls every raw-land
//      listing in the radius — cheap, no comps yet.
//   2. Listings are pre-ranked by price (and optionally capped
//      by maxLotPrice) with NO RentCast spend.
//   3. Only the top K candidates get a real comp (AVM) lookup —
//      this is the expensive part, hard-capped at K regardless
//      of how many listings the radius contains.
//   4. Per-address comp lookups reuse the SAME buybox_cache table
//      as the buybox function (keyed by address+month), so a lot
//      already analyzed this month via Buy Box — or by an earlier,
//      overlapping Lot Finder search — costs nothing to re-serve.
//   5. All RentCast spend (1 + up to K) is reserved atomically
//      against the SAME monthly cap as buybox via try_reserve/
//      release_usage — there is no separate budget for this
//      function to bypass the existing lockdown.
//
// Secrets: shared with buybox (same Supabase project) —
//   RENTCAST_KEY, APP_PASSCODE, MONTHLY_CALL_CAP, ALLOWED_ORIGIN, OWNER_OVERRIDE_KEY
// ------------------------------------------------------------
// Requires the SAME usage_setup.sql tables/RPCs as buybox.
// ============================================================

const RENTCAST_KEY = Deno.env.get("RENTCAST_KEY") ?? "";
const APP_PASSCODE = Deno.env.get("APP_PASSCODE") ?? "";
const CAP_RAW = parseInt(Deno.env.get("MONTHLY_CALL_CAP") ?? "48", 10);
const CAP = Number.isFinite(CAP_RAW) && CAP_RAW > 0 ? CAP_RAW : 48;
const OWNER_OVERRIDE_KEY = Deno.env.get("OWNER_OVERRIDE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const RENTCAST_BASE = "https://api.rentcast.io/v1";
const FEMA_NFHL =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";

// Hard ceiling on expensive (AVM) calls per search, independent of radius/listing count.
const SHORTLIST_K = 10;
const MIN_RADIUS_MI = 0.25;
const MAX_RADIUS_MI = 15;

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-pass, x-owner-key",
    "Content-Type": "application/json",
  };
}

function monthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---- Supabase (PostgREST) via service role — same tables as buybox --------
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
async function releaseUsage(month: string, n: number): Promise<void> {
  if (n <= 0) return;
  try {
    await pg("rpc/release_usage", { method: "POST", body: JSON.stringify({ p_month: month, p_n: n }) });
  } catch { /* ignore */ }
}
// Owner-override path: add N unconditionally, no cap check. Returns the new total.
async function addUsage(month: string, n: number): Promise<number> {
  try {
    const r = await pg("rpc/add_usage", { method: "POST", body: JSON.stringify({ p_month: month, p_n: n }) });
    if (!r.ok) return 0;
    return Number(await r.json()) || 0;
  } catch { return 0; }
}
async function cacheGet(addr: string, month: string): Promise<any | null> {
  try {
    const r = await pg(`buybox_cache?address=eq.${encodeURIComponent(addr)}&month=eq.${month}&select=payload`);
    if (!r.ok) return null;
    const rows = await r.json();
    const payload = rows[0]?.payload ?? null;
    if (payload && !Array.isArray(payload.comps?.compDetails)) return null;
    return payload;
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

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function formatAddress(row: any): string {
  return [row.addressLine1, row.city, row.state, row.zipCode].filter(Boolean).join(", ")
    || row.formattedAddress || row.address || "";
}
function zipFromAddress(addr: string): string {
  const m = addr.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

// ---- RentCast (dbg records each billable call) -----------------------------
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

// Cheap bulk pull: every raw-land listing in the radius, no comps yet.
async function getLandListings(lat: number, lng: number, radiusMiles: number, dbg: string[]) {
  const params = new URLSearchParams({
    latitude: String(lat), longitude: String(lng), radius: String(radiusMiles),
    propertyType: "Land", status: "Active", limit: "200",
  });
  const res = await rcGet(`/listings/sale?${params.toString()}`, dbg);
  const rows = Array.isArray(res) ? res : (res ? [res] : []);
  return rows.map((row: any) => ({
    address: formatAddress(row), askingPrice: row.price ?? null,
    lotSizeSqft: row.lotSize ?? null, lat: row.latitude ?? null, lng: row.longitude ?? null,
  })).filter((l: any) => l.address && l.askingPrice);
}

// Same comp lookup as buybox — always Single Family, regardless of subject type.
async function getComps(address: string, dbg: string[]) {
  const params = new URLSearchParams({ address, propertyType: "Single Family" });
  const avm = await rcGet(`/avm/value?${params.toString()}`, dbg);
  if (!avm) return null;
  const comps = Array.isArray(avm.comparables) ? avm.comparables : [];
  const compDetails = comps.map((c: any) => {
    const price = c.price ?? c.listPrice ?? c.lastSalePrice;
    const psf = price && c.squareFootage ? Math.round(price / c.squareFootage) : null;
    const addr = formatAddress(c);
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
    return { floodZone: feat.FLD_ZONE || "UNKNOWN", floodDesc: feat.ZONE_SUBTY || "" };
  } catch { return { floodZone: "UNKNOWN", floodDesc: "FEMA lookup failed" }; }
}

// ---- handler ----------------------------------------------------------------
Deno.serve(async (req) => {
  const headers = cors(ALLOWED_ORIGIN);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });

  if (APP_PASSCODE) {
    const pass = req.headers.get("x-app-pass") ?? "";
    if (pass !== APP_PASSCODE) {
      return new Response(JSON.stringify({ error: "Unauthorized — enter the app passcode." }), { status: 401, headers });
    }
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const lat = Number(body.lat), lng = Number(body.lng);
  let radiusMiles = Number(body.radiusMiles);
  const maxLotPrice = Number(body.maxLotPrice) || 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return new Response(JSON.stringify({ error: "Missing or invalid lat/lng." }), { status: 422, headers });
  }
  if (!Number.isFinite(radiusMiles)) radiusMiles = 3;
  radiusMiles = Math.min(MAX_RADIUS_MI, Math.max(MIN_RADIUS_MI, radiusMiles)); // defensive clamp, ignores client overreach
  if (!RENTCAST_KEY) {
    return new Response(JSON.stringify({ error: "Server missing RENTCAST_KEY." }), { status: 503, headers });
  }

  const month = monthKey();

  // Reserve worst case (1 bulk pull + K comp calls) up front; release what's unused below.
  // Owner override (x-owner-key) skips the cap check entirely — see OWNER_OVERRIDE_KEY note above.
  const RESERVE_N = 1 + SHORTLIST_K;
  const ownerOverride = !!OWNER_OVERRIDE_KEY && req.headers.get("x-owner-key") === OWNER_OVERRIDE_KEY;
  let capOk: boolean, reservedAt: number;
  if (ownerOverride) {
    capOk = true; reservedAt = await addUsage(month, RESERVE_N);
  } else {
    ({ ok: capOk, count: reservedAt } = await tryReserve(month, RESERVE_N));
  }
  if (!capOk) {
    return new Response(JSON.stringify({
      error: `Monthly lookup limit reached (${CAP} RentCast calls). Resets on the 1st.`,
      usage: { used: reservedAt, cap: CAP },
    }), { status: 429, headers });
  }

  const dbg: string[] = [];
  const billed = () => dbg.filter((s) => /^\/(listings|properties|avm)/.test(s) && /:\d+$/.test(s)).length;

  let listings = await getLandListings(lat, lng, radiusMiles, dbg);
  const scanned = listings.length;
  if (maxLotPrice > 0) listings = listings.filter((l: any) => l.askingPrice <= maxLotPrice);
  listings.sort((a: any, b: any) => a.askingPrice - b.askingPrice); // cheapest-first heuristic — no comp data yet to rank by
  const shortlist = listings.slice(0, SHORTLIST_K);

  const candidates = await Promise.all(shortlist.map(async (l: any) => {
    const addrKey = l.address.toLowerCase();
    const cached = await cacheGet(addrKey, month);
    if (cached) {
      return { listing: l, comps: cached.comps, floodZone: cached.floodZone, floodDesc: cached.floodDesc, cached: true };
    }
    const [comps, flood] = await Promise.all([
      getComps(l.address, dbg),
      (l.lat != null && l.lng != null) ? getFloodZone(l.lat, l.lng)
        : Promise.resolve({ floodZone: "UNKNOWN", floodDesc: "No coordinates for flood lookup" }),
    ]);
    const payload = {
      source: "rentcast+fema", address: l.address, zip: zipFromAddress(l.address),
      askingPrice: l.askingPrice, lotSizeSqft: l.lotSizeSqft, existingSqft: null,
      lat: l.lat, lng: l.lng,
      comps: comps ?? { medianPerSqft: 0, count: 0, lowPerSqft: 0, highPerSqft: 0, asOf: null, compDetails: [] },
      floodZone: flood.floodZone, floodDesc: flood.floodDesc,
    };
    await cachePut(addrKey, month, payload); // shared with buybox: a later Buy Box lookup of this address is now free this month
    return { listing: l, comps: payload.comps, floodZone: flood.floodZone, floodDesc: flood.floodDesc, cached: false };
  }));

  const n = billed();
  await releaseUsage(month, RESERVE_N - n);
  const newUsed = reservedAt - Math.max(0, RESERVE_N - n);

  return new Response(JSON.stringify({
    candidates, scanned, shortlisted: shortlist.length,
    usage: { used: newUsed, cap: CAP },
  }), { headers });
});
