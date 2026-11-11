/**
 * Cloudflare Pages Function for Ahmedabad Stop Vehicles (Phase 2)
 * Fetches vehicle positions for multiple routes at a stop.
 * Endpoint: /api/ahmedabad/stop-vehicles?routes=101sh,103
 *
 * `routes` are public route numbers, matched via the id mapping against the feed's route_id
 * (see ahmedabad-rt.js) — no id-mapping table, no fallback API.
 */
import { fetchVehiclePositions, matchesRouteId } from './ahmedabad-rt.js';

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
      console.error('Ahmedabad GTFS-RT feed fetch failed:', error);
      return jsonResponse({ vehicles: [] }, 200, { 'Cache-Control': 'public, max-age=15' });
    }

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
    console.error('Ahmedabad Stop Vehicles Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch vehicle data', message: error.message },
      500,
    );
  }
}
