/**
 * Cloudflare Pages Function for Indian Railways Live Vehicle Tracking
 * Endpoint: /api/railways/vehicles?routetext=22470
 *           /api/railways/vehicles?routeid=22470 (equivalent — route_id
 *           and the public train number are the same string, see railways-rt.js)
 *
 * Unlike BMTC/PMPML/Delhi there's no id-mapping step: the feed's route_id
 * is already the train number, so this is a direct GTFS-RT filter with no
 * fallback API (none exists for this feed).
 *
 * Each vehicle also carries `stops.{lastLocationId,nextLocationId}` —
 * joined from this feed's own TripUpdates by vehicle id — so the plain
 * service page's StopsList (which places a vehicle by looking those up,
 * not from `location` alone) can position it in the stop list, matching
 * what the dedicated /vehicle endpoint already does.
 */
import { occupancyToLoad } from '../vehicle.js';
import { fetchGtfsRtFeed, matchesRouteId } from './railways-rt.js';

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

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const url = new URL(request.url);
    const trainNumber = url.searchParams.get('routetext') || url.searchParams.get('routeid');

    if (!trainNumber) {
      return jsonResponse({ error: 'routetext or routeid parameter is required' }, 400);
    }

    const cacheHeaders = { 'Cache-Control': 'public, max-age=15' };

    let feed = { vehicles: [], tripUpdates: [] };
    try {
      feed = await fetchGtfsRtFeed();
    } catch (error) {
      console.error('Indian Railways GTFS-RT feed fetch failed:', error);
      return jsonResponse({ routeText: trainNumber, vehicles: [], source: 'gtfs-rt' }, 200, cacheHeaders);
    }

    const tripUpdateByVehicle = new Map();
    for (const tu of feed.tripUpdates) {
      for (const key of [tu.vehicleId, tu.vehicleLabel]) {
        if (key && !tripUpdateByVehicle.has(key)) tripUpdateByVehicle.set(key, tu);
      }
    }
    const nowSec = Date.now() / 1000;

    const vehicles = feed.vehicles
      .filter((v) => matchesRouteId(v, trainNumber) && v.lat != null && v.lng != null)
      .map((v) => {
        const load = occupancyToLoad(v.occupancyStatus);
        return {
          vehicleId: v.vehicleId,
          vehicleNumber: v.vehicleLabel || v.vehicleId,
          location: { lat: v.lat, lng: v.lng },
          heading: v.bearing || null,
          lastRefreshMs: v.timestamp ? v.timestamp * 1000 : null,
          stops: resolveStopPlacement(tripUpdateByVehicle.get(v.vehicleId) || tripUpdateByVehicle.get(v.vehicleLabel), nowSec),
          // Only when the feed itself reports occupancy (it doesn't today).
          ...(load && { load }),
        };
      });

    return jsonResponse({ routeText: trainNumber, vehicles, source: 'gtfs-rt' }, 200, cacheHeaders);
  } catch (error) {
    console.error('Indian Railways Vehicles API Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch vehicle tracking data', message: error.message },
      500,
    );
  }
}

/** Where StopsList.jsx should place this vehicle: after the last stop
 * whose time has passed, else before the next one (mirrors BMTC's
 * matchGtfsRtVehicles — see functions/api/bmtc/vehicles.js). Stop ids are
 * used as-is; no translation needed (see railways-rt.js). */
function resolveStopPlacement(tripUpdate, nowSec) {
  const placement = { last: null, current: null, next: null, lastLocationId: null, currentLocationId: null, nextLocationId: null };
  if (!tripUpdate) return placement;

  const timed = tripUpdate.stopTimeUpdates
    .map((stu) => ({ stopId: stu.stopId, time: stu.arrival?.time ?? stu.departure?.time }))
    .filter((s) => s.stopId && s.time != null)
    .sort((a, b) => a.time - b.time);

  let last = null;
  let next = null;
  for (const s of timed) {
    if (s.time <= nowSec) last = s;
    else if (!next) next = s;
  }
  placement.lastLocationId = last?.stopId ?? null;
  placement.nextLocationId = next?.stopId ?? null;
  return placement;
}
