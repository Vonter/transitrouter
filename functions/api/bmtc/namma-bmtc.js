/**
 * Shared helper for calling Namma BMTC's live-tracking API
 * (production.zophop.com), used by vehicles/stop-vehicles/arrivals/
 * stop-routes in place of the retired bmtcmobileapi.karnataka.gov.in.
 * Needs a browser-like User-Agent (bare requests get a CloudFront 403) but
 * no auth: callers pass the visiting client's own User-Agent through, with
 * DEFAULT_USER_AGENT only as the fallback when the request carries none. Every response nests per-vehicle records as JSON-encoded
 * strings, hence the double-parse via `safeParse`.
 */

const NAMMA_BMTC_BASE = 'https://production.zophop.com';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0';

function nammaBmtcHeaders(userAgent) {
  return {
    'User-Agent': userAgent || DEFAULT_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
  };
}

function safeParse(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * POST /vasudha/cities/bengaluru/stop-route-eta
 * body: {stopIdRouteIdList: ["<nammaBmtcStopId>:<nammaBmtcRouteId>", ...]}
 * Returns Map<"<stopId>:<routeId>", Map<vehicleId, parsedRecord>>.
 */
export async function fetchStopRouteEta(stopIdRouteIdList, userAgent) {
  const result = new Map();
  if (!stopIdRouteIdList.length) return result;

  const res = await fetch(
    `${NAMMA_BMTC_BASE}/vasudha/cities/bengaluru/stop-route-eta`,
    {
      method: 'POST',
      headers: { ...nammaBmtcHeaders(userAgent), 'Content-Type': 'application/json' },
      body: JSON.stringify({ stopIdRouteIdList }),
    },
  );
  if (!res.ok) throw new Error(`Namma BMTC stop-route-eta returned ${res.status}`);

  const data = await res.json();
  for (const [pairKey, vehicles] of Object.entries(data.stopRouteEtas || {})) {
    const vehicleMap = new Map();
    for (const [vehicleId, raw] of Object.entries(vehicles || {})) {
      const parsed = safeParse(raw);
      if (parsed) vehicleMap.set(vehicleId, parsed);
    }
    result.set(pairKey, vehicleMap);
  }
  return result;
}

/**
 * GET /vasudha/track/route-live-info/bengaluru/<routeId>?stopIds=<id>
 * `stopIds` is required but doesn't filter `routeLiveInfo` (only the
 * unused `stopsEta` section) — any valid stop id on the route works.
 * Returns Map<vehicleId, parsedRecord> for every vehicle on the route.
 */
export async function fetchRouteLiveInfo(nammaBmtcRouteId, anyStopId, userAgent) {
  const url = `${NAMMA_BMTC_BASE}/vasudha/track/route-live-info/bengaluru/${nammaBmtcRouteId}?stopIds=${encodeURIComponent(anyStopId)}`;
  const res = await fetch(url, { headers: nammaBmtcHeaders(userAgent) });
  if (!res.ok) throw new Error(`Namma BMTC route-live-info returned ${res.status}`);

  const data = await res.json();
  const vehicles = new Map();
  for (const [vehicleId, raw] of Object.entries(data.routeLiveInfo || {})) {
    const parsed = safeParse(raw);
    if (parsed) vehicles.set(vehicleId, parsed);
  }
  return vehicles;
}

// Seat availability is served from chalo.com/app/api, not production.zophop.com
// (which rejects requests without a current app version).
const SEAT_AVAILABILITY_URL = 'https://chalo.com/app/api/seat/availability';

// Load codes the frontend styles (.time-sea/.time-sda/.time-lsd).
const SEAT_STATUS_TO_LOAD = { 3: 'SEA', 4: 'SDA', 5: 'LSD' };

/** Seat-availability status 3 (least occupied) … 5 (most occupied); -1 or
 * anything unknown is treated as clear. */
export function seatStatusToLoad(status) {
  return SEAT_STATUS_TO_LOAD[status] || 'SEA';
}

/**
 * POST chalo.com/app/api/seat/availability
 * body: {mode: 2, cityId: "bengaluru", vehicle: [{number: "<busNumber>"}, ...]}
 * Returns Map<busNumber, 'SEA'|'SDA'|'LSD'> for the buses it knows about.
 */
export async function fetchBusLoads(busNumbers, userAgent) {
  const loads = new Map();
  const numbers = [...new Set(busNumbers.filter(Boolean))];
  if (!numbers.length) return loads;

  const res = await fetch(SEAT_AVAILABILITY_URL, {
    method: 'POST',
    headers: { ...nammaBmtcHeaders(userAgent), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 2,
      cityId: 'bengaluru',
      vehicle: numbers.map((number) => ({ number })),
    }),
  });
  if (!res.ok) throw new Error(`Namma BMTC seat availability returned ${res.status}`);

  const data = await res.json();
  for (const { number, status } of data.vehicle || []) {
    loads.set(number, seatStatusToLoad(status));
  }
  return loads;
}

/**
 * Fills in `load` on trips that have already passed the ETA filters, leaving
 * the caller's 'SEA' default in place for vehicles the seat API doesn't know.
 * Deliberately called after filtering, not before: a stop's raw stop-route-eta
 * response carries roughly three times more vehicles than end up rendered
 * (eta -1, or beyond the arrival window), and looking those up is wasted work.
 * Never rejects — seat availability is decoration, not a reason to fail a stop.
 */
export async function applyBusLoads(trips, userAgent) {
  if (!trips.length) return;
  try {
    const loads = await fetchBusLoads(
      trips.map((trip) => trip.bus_no),
      userAgent,
    );
    for (const trip of trips) {
      const load = loads.get(trip.bus_no);
      if (load) trip.load = load;
    }
  } catch (error) {
    console.error('Namma BMTC seat availability failed, defaulting load to SEA:', error);
  }
}

/** eta===-1 (or missing) means "unknown" — never surface as negative. */
export function normalizeEtaSeconds(etaSeconds) {
  if (etaSeconds == null || etaSeconds < 0) return null;
  return etaSeconds;
}

// blr-id-mapping.js dedupes route/stop ids into top-level `r`/`s` arrays;
// entries below store short integer indices into them instead of the raw
// ~8-char id. `mapping` is the full BLR_ID_MAPPING module.

/**
 * Parses one `routes` entry: "<gtfsRtRouteId>|<rIdx>:<sIdx>,...".
 * Returns { gtfsRtRouteId: string|null, nammaBmtcRoutes: {nammaBmtcRouteId, sampleStopId}[] }.
 */
export function parseRouteMapping(entry, mapping) {
  if (!entry) return { gtfsRtRouteId: null, nammaBmtcRoutes: [] };
  const [gtfsRtRouteId, variants] = entry.split('|');
  const nammaBmtcRoutes = (variants ? variants.split(',') : [])
    .filter(Boolean)
    .map((pair) => {
      const [rIdx, sIdx] = pair.split(':');
      return {
        nammaBmtcRouteId: mapping.r[rIdx],
        sampleStopId: sIdx !== '' && sIdx !== undefined ? mapping.s[sIdx] : null,
      };
    });
  return { gtfsRtRouteId: gtfsRtRouteId || null, nammaBmtcRoutes };
}

/**
 * Parses one `stops` entry: "<rIdx>:<sIdx>,<rIdx>:<sIdx>,...". Keyed
 * per-route (not one shared stop id) since Namma BMTC often assigns a
 * different stop id per direction for what the community GTFS treats as
 * one stop. Returns {routeId, nammaBmtcStopId}[] (empty if entry is missing).
 */
export function parseStopMapping(entry, mapping) {
  if (!entry) return [];
  return entry
    .split(',')
    .filter(Boolean)
    .map((pair) => {
      const [rIdx, sIdx] = pair.split(':');
      return { routeId: mapping.r[rIdx], nammaBmtcStopId: mapping.s[sIdx] };
    });
}

let routeStopIndex = null;

/**
 * nammaBmtcRouteId -> Map<nammaBmtcStopId, localStopId>, inverted once from
 * `mapping.stops`. Translates the Namma BMTC stop ids the GTFS-RT feed's
 * trip updates use back to local stop ids.
 */
export function getRouteStopIndex(mapping) {
  if (routeStopIndex) return routeStopIndex;
  routeStopIndex = new Map();
  for (const [localStopId, entry] of Object.entries(mapping.stops)) {
    for (const { routeId, nammaBmtcStopId } of parseStopMapping(entry, mapping)) {
      if (!routeStopIndex.has(routeId)) routeStopIndex.set(routeId, new Map());
      routeStopIndex.get(routeId).set(nammaBmtcStopId, localStopId);
    }
  }
  return routeStopIndex;
}
