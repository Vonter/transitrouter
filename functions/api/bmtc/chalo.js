/**
 * Shared helper for calling Chalo's live-tracking API (chalo.com), which
 * BMTC's vehicles/stop-vehicles/arrivals/stop-routes endpoints use in place
 * of the retired bmtcmobileapi.karnataka.gov.in. GTFS-RT (bmtc-rt.js) is
 * unrelated and untouched by this migration.
 *
 * Chalo needs a browser-like User-Agent (bare requests get a CloudFront
 * 403) but no auth/cookies/API key. Every response nests per-vehicle
 * records as JSON-encoded STRINGS, so callers get a double-parse via
 * `safeParse`.
 */

const CHALO_BASE = 'https://chalo.com/app/api';
const CHALO_HEADERS = {
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
 * body: {stopIdRouteIdList: ["<chaloStopId>:<chaloRouteId>", ...]}
 * Returns Map<"<stopId>:<routeId>", Map<vehicleId, parsedRecord>>.
 */
export async function fetchStopRouteEta(stopIdRouteIdList) {
  const result = new Map();
  if (!stopIdRouteIdList.length) return result;

  const res = await fetch(
    `${CHALO_BASE}/vasudha/cities/bengaluru/stop-route-eta`,
    {
      method: 'POST',
      headers: { ...CHALO_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stopIdRouteIdList }),
    },
  );
  if (!res.ok) throw new Error(`Chalo stop-route-eta returned ${res.status}`);

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
 * `stopIds` is required by Chalo but doesn't filter `routeLiveInfo` (it
 * only affects the unused `stopsEta` section) — any valid stop id on the
 * route satisfies it. Returns Map<vehicleId, parsedRecord> (vehicle
 * positions for every vehicle currently on the route).
 */
export async function fetchRouteLiveInfo(chaloRouteId, anyStopId) {
  const url = `${CHALO_BASE}/vasudha/track/route-live-info/bengaluru/${chaloRouteId}?stopIds=${encodeURIComponent(anyStopId)}`;
  const res = await fetch(url, { headers: CHALO_HEADERS });
  if (!res.ok) throw new Error(`Chalo route-live-info returned ${res.status}`);

  const data = await res.json();
  const vehicles = new Map();
  for (const [vehicleId, raw] of Object.entries(data.routeLiveInfo || {})) {
    const parsed = safeParse(raw);
    if (parsed) vehicles.set(vehicleId, parsed);
  }
  return vehicles;
}

/** Chalo uses eta===-1 (or a missing field) to mean "unknown" — never
 * surface that as a negative/garbage duration. */
export function normalizeEtaSeconds(etaSeconds) {
  if (etaSeconds == null || etaSeconds < 0) return null;
  return etaSeconds;
}

/**
 * blr-id-mapping.js dedupes the ~8-char opaque Chalo route/stop ids into
 * top-level `r`/`s` arrays (built by scripts/build_blr_id_mapping.py's
 * IdIndex) since each id is referenced far more times than there are
 * distinct ids — `routes`/`stops` entries below store short integer
 * indices into these arrays instead of repeating the raw id every time.
 */

/**
 * Parses one `routes` entry from blr-id-mapping.js, encoded compactly as
 * "<gtfsRtRouteId>|<rIdx>:<sIdx>,<rIdx>:<sIdx>,..." (gtfsRtRouteId may be
 * empty; sIdx may be empty if the route had no stops). `mapping` is the
 * full BLR_ID_MAPPING module (for its `r`/`s` index arrays). Returns
 * { gtfsRtRouteId: string|null, chaloRoutes: {chaloRouteId, sampleStopId}[] }.
 */
export function parseRouteMapping(entry, mapping) {
  if (!entry) return { gtfsRtRouteId: null, chaloRoutes: [] };
  const [gtfsRtRouteId, variants] = entry.split('|');
  const chaloRoutes = (variants ? variants.split(',') : [])
    .filter(Boolean)
    .map((pair) => {
      const [rIdx, sIdx] = pair.split(':');
      return {
        chaloRouteId: mapping.r[rIdx],
        sampleStopId: sIdx !== '' && sIdx !== undefined ? mapping.s[sIdx] : null,
      };
    });
  return { gtfsRtRouteId: gtfsRtRouteId || null, chaloRoutes };
}

/**
 * Parses one `stops` entry from blr-id-mapping.js, encoded compactly as
 * "<rIdx>:<sIdx>,<rIdx>:<sIdx>,...". Keyed per-route (not one shared chalo
 * stop id for the local stop) because Chalo commonly assigns a different
 * stop id to each direction of what the community GTFS treats as one stop
 * (e.g. opposite sides of the road) — each route's own chalo stop id
 * already reflects its correct direction/platform, so there's no separate
 * disambiguation needed. `mapping` is the full BLR_ID_MAPPING module.
 * Returns {routeId, chaloStopId}[] (empty array if entry is missing/empty).
 */
export function parseStopMapping(entry, mapping) {
  if (!entry) return [];
  return entry
    .split(',')
    .filter(Boolean)
    .map((pair) => {
      const [rIdx, sIdx] = pair.split(':');
      return { routeId: mapping.r[rIdx], chaloStopId: mapping.s[sIdx] };
    });
}
