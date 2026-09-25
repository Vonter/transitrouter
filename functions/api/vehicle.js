/**
 * Shared handler for per-city vehicle endpoints (bmtc/, pmpml/, delhi/
 * `vehicle.js`), so each city only supplies how to fetch its data and how
 * to translate ids. The data source is either a GTFS-RT feed or a source
 * API, as long as it is normalized to { vehicles, tripUpdates } (the
 * shapes the *-rt.js readers produce).
 *
 *   GET /api/<city>/vehicle                    -> { vehicles: [{ vehicleId, vehicleNumber }] }
 *   GET /api/<city>/vehicle?vehicleid=<id>     -> vehicle info (404 JSON error if not in feed)
 *
 * `vehicleid` accepts either value the list endpoint returns.
 * Vehicle info reuses the shape of vehicles.js entries; `occupancy`/`load`
 * appear only when the feed itself reports occupancy.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

// GTFS-RT VehiclePosition.OccupancyStatus
const OCCUPANCY_STATUS = [
  'EMPTY',
  'MANY_SEATS_AVAILABLE',
  'FEW_SEATS_AVAILABLE',
  'STANDING_ROOM_ONLY',
  'CRUSHED_STANDING_ROOM_ONLY',
  'FULL',
  'NOT_ACCEPTING_PASSENGERS',
  'NO_DATA_AVAILABLE',
  'NOT_BOARDABLE',
];

// Same load codes arrivals use (.time-sea/.time-sda/.time-lsd).
export function occupancyToLoad(status) {
  if (status === 0 || status === 1) return 'SEA';
  if (status === 2 || status === 3) return 'SDA';
  if (status >= 4 && status <= 6) return 'LSD';
  return null;
}

function keysOf(entry) {
  return [entry.vehicleId, entry.vehicleLabel].filter(Boolean);
}

/** Active = present in the feed with a position or with trip updates. */
export function listActiveVehicles({ vehicles, tripUpdates }) {
  const seen = new Map();
  for (const e of [...vehicles, ...tripUpdates]) {
    const id = e.vehicleId || e.vehicleLabel;
    if (id && !seen.has(id)) {
      seen.set(id, { vehicleId: id, vehicleNumber: e.vehicleLabel || id });
    }
  }
  return Array.from(seen.values());
}

/**
 * Builds vehicle info, or null if the vehicle isn't in the feed.
 * opts.resolveRouteNo(routeId) -> public route number (default: routeId)
 * opts.mapStopId(stopId, routeId) -> stop id in local terms (default: as-is)
 * opts.source -> 'gtfs-rt' (default) or 'api', named in the frontend's live-data indicator
 */
export function buildVehicleInfo({ vehicles, tripUpdates }, vehicleKey, opts = {}) {
  const { resolveRouteNo = (r) => r, mapStopId = (s) => s } = opts;
  const position = vehicles.find((v) => keysOf(v).includes(vehicleKey));
  const tripUpdate = tripUpdates.find((t) => keysOf(t).includes(vehicleKey));
  if (!position && !tripUpdate) return null;

  const base = position || tripUpdate;
  const routeId = position?.routeId || tripUpdate?.routeId || null;
  const nowMs = Date.now();

  const info = {
    vehicleId: base.vehicleId || base.vehicleLabel,
    vehicleNumber: base.vehicleLabel || base.vehicleId,
    routeId,
    routeNo: routeId ? resolveRouteNo(routeId) || null : null,
    tripId: position?.tripId || tripUpdate?.tripId || null,
    location:
      position && position.lat != null ? { lat: position.lat, lng: position.lng } : null,
    heading: position?.bearing ?? null,
    source: opts.source || 'gtfs-rt',
    lastRefreshMs: position?.timestamp ? position.timestamp * 1000 : null,
  };

  if (position && position.occupancyStatus != null) {
    info.occupancy = { status: OCCUPANCY_STATUS[position.occupancyStatus] || null };
    if (position.occupancyPercentage != null) {
      info.occupancy.percentage = position.occupancyPercentage;
    }
    const load = occupancyToLoad(position.occupancyStatus);
    if (load) info.load = load;
  } else if (position && position.occupancyPercentage != null) {
    info.occupancy = { percentage: position.occupancyPercentage };
  }

  if (tripUpdate) {
    info.stops = tripUpdate.stopTimeUpdates.map((stu) => {
      const time = stu.arrival?.time ?? stu.departure?.time ?? null;
      return {
        stopId: mapStopId(stu.stopId, tripUpdate.routeId) ?? stu.stopId,
        arrivalTime: time,
        duration_ms: time != null ? Math.max(0, time * 1000 - nowMs) : null,
        delay: stu.arrival?.delay ?? stu.departure?.delay ?? null,
      };
    });
  }

  return info;
}

/**
 * Creates the Pages Function handler. `fetchFeed(context)` must resolve to
 * { vehicles, tripUpdates }.
 */
export function createVehicleHandler(name, fetchFeed, opts = {}) {
  return async function onRequest(context) {
    const { request } = context;
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    try {
      const vehicleId = new URL(request.url).searchParams.get('vehicleid');
      const feed = await fetchFeed(context);
      const cache = { 'Cache-Control': 'public, max-age=15' };

      if (!vehicleId) {
        return jsonResponse({ vehicles: listActiveVehicles(feed) }, 200, cache);
      }

      const info = buildVehicleInfo(feed, vehicleId, opts);
      if (!info) {
        return jsonResponse({ error: 'Vehicle not found in feed', vehicleId }, 404, cache);
      }
      return jsonResponse(info, 200, cache);
    } catch (error) {
      console.error(`${name} Vehicle API Function Error:`, error);
      return jsonResponse(
        { error: 'Failed to fetch vehicle data', message: error.message },
        500,
      );
    }
  };
}
