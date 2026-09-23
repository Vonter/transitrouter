/**
 * Cloudflare Pages Function for Indian Railways Stop Vehicles (Phase 2)
 * Fetches vehicle positions for multiple trains at a stop.
 * Endpoint: /api/railways/stop-vehicles?routes=22470,26502
 *
 * `routes` are train numbers, matched directly against the feed's route_id
 * (see railways-rt.js) — no id-mapping table, no fallback API.
 */
import { fetchVehiclePositions, matchesRouteId } from './railways-rt.js';

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
    const routesParam = new URL(request.url).searchParams.get('routes');

    if (!routesParam) {
      return jsonResponse({ error: 'routes parameter is required' }, 400);
    }

    const trainNumbers = routesParam
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);

    if (trainNumbers.length === 0) {
      return jsonResponse({ vehicles: [] }, 200);
    }

    let allFeedVehicles = [];
    try {
      allFeedVehicles = await fetchVehiclePositions();
    } catch (error) {
      console.error('Indian Railways GTFS-RT feed fetch failed:', error);
      return jsonResponse({ vehicles: [] }, 200, { 'Cache-Control': 'public, max-age=15' });
    }

    // A vehicle can only match one train number here (route_id is the
    // train number itself, one-to-one), unlike BMTC/PMPML where several
    // requested names can resolve to the same id — kept as a routeNames
    // array anyway for a consistent response shape across cities.
    const vehicles = [];
    for (const trainNumber of trainNumbers) {
      for (const v of allFeedVehicles) {
        if (v.lat == null || v.lng == null) continue;
        if (!matchesRouteId(v, trainNumber)) continue;
        vehicles.push({
          vehicleId: v.vehicleId,
          vehicleNumber: v.vehicleLabel || v.vehicleId,
          lat: v.lat,
          lng: v.lng,
          bearing: v.bearing || null,
          routeNames: [trainNumber],
        });
      }
    }

    const cacheHeaders = { 'Cache-Control': 'public, max-age=15' };
    return jsonResponse({ vehicles }, 200, cacheHeaders);
  } catch (error) {
    console.error('Indian Railways Stop Vehicles Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch vehicle data', message: error.message },
      500,
    );
  }
}
