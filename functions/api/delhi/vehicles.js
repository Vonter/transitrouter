/**
 * Cloudflare Pages Function for Delhi (DTC) Live Vehicle Tracking
 * Endpoint: /api/delhi/vehicles?routetext=534
 *
 * There is no separate arrivals/vehicle API backend for Delhi — this reads
 * vehicle positions directly from the GTFS-RT feed, filtered by route_id
 * via delhi-route-mapping.js (see the caveat in delhi-rt.js for why that
 * translation is needed, and that it's unverified against a live feed).
 */
import { fetchVehiclePositions, matchesRouteIds } from './delhi-rt.js';
import ROUTE_MAPPING from './delhi-route-mapping.js';

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
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const routeText = new URL(request.url).searchParams.get('routetext');

    if (!routeText) {
      return jsonResponse({ error: 'routetext parameter is required' }, 400);
    }

    const routeIds = ROUTE_MAPPING[routeText];
    if (!routeIds?.length) {
      return jsonResponse({ routeText, vehicles: [], source: null }, 200, {
        'Cache-Control': 'public, max-age=15',
      });
    }

    const allVehicles = await fetchVehiclePositions(env);
    const vehicles = allVehicles
      .filter((v) => matchesRouteIds(v, routeIds))
      .map((v) => ({
        vehicleId: v.vehicleId,
        vehicleNumber: v.vehicleLabel || v.vehicleId,
        location: { lat: v.lat, lng: v.lng },
        bearing: v.bearing || null,
      }));

    return jsonResponse({ routeText, vehicles, source: 'gtfs-rt' }, 200, {
      'Cache-Control': 'public, max-age=15',
    });
  } catch (error) {
    console.error('Delhi Vehicles API Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch vehicle tracking data', message: error.message },
      500,
    );
  }
}
