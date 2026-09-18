/**
 * Shared helper for calling Namma BMTC's live-tracking API
 * (production.zophop.com), used by vehicles/stop-vehicles/arrivals/
 * stop-routes in place of the retired bmtcmobileapi.karnataka.gov.in.
 * Needs a browser-like User-Agent (bare requests get a CloudFront 403) but
 * no auth. Every response nests per-vehicle records as JSON-encoded
 * strings, hence the double-parse via `safeParse`.
 */

const NAMMA_BMTC_BASE = 'https://production.zophop.com';
const NAMMA_BMTC_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
  Accept: 'application/json, text/plain, */*',
};

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
export async function fetchStopRouteEta(stopIdRouteIdList) {
  const result = new Map();
  if (!stopIdRouteIdList.length) return result;

  const res = await fetch(
    `${NAMMA_BMTC_BASE}/vasudha/cities/bengaluru/stop-route-eta`,
    {
      method: 'POST',
      headers: { ...NAMMA_BMTC_HEADERS, 'Content-Type': 'application/json' },
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
export async function fetchRouteLiveInfo(nammaBmtcRouteId, anyStopId) {
  const url = `${NAMMA_BMTC_BASE}/vasudha/track/route-live-info/bengaluru/${nammaBmtcRouteId}?stopIds=${encodeURIComponent(anyStopId)}`;
  const res = await fetch(url, { headers: NAMMA_BMTC_HEADERS });
  if (!res.ok) throw new Error(`Namma BMTC route-live-info returned ${res.status}`);

  const data = await res.json();
  const vehicles = new Map();
  for (const [vehicleId, raw] of Object.entries(data.routeLiveInfo || {})) {
    const parsed = safeParse(raw);
    if (parsed) vehicles.set(vehicleId, parsed);
  }
  return vehicles;
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
