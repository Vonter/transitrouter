/**
 * Cloudflare Pages Function for PMPML Live Vehicle Tracking (GTFS-RT variant)
 * Endpoint: /api/pmpml-gtfs/vehicles?routetext=220
 *
 * Filters the GTFS-RT feed's VehiclePositions by route_id, translating the
 * public route number to route_id(s) via pmpml-route-mapping.js (see the
 * caveat in pmpml-rt.js for why that translation is needed). Falls back to
 * chartr's buses-on-route API for any route missing from that mapping
 * (e.g. a new route added after the mapping was last generated).
 */
import { fetchVehiclePositions, matchesRouteIds } from './pmpml-rt.js';
import ROUTE_MAPPING from './pmpml-route-mapping.js';

const PMPML_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
  Accept: '*/*',
  'Content-Type': 'application/json',
  'x-api-key': 't',
};

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
    const routeText = url.searchParams.get('routetext');

    if (!routeText) {
      return jsonResponse({ error: 'routetext parameter is required' }, 400);
    }

    const routeIds = ROUTE_MAPPING[routeText];
    const source = routeIds?.length ? 'gtfs-rt' : 'api';
    const vehicles = routeIds?.length
      ? await fetchVehiclesFromGtfsRt(routeIds)
      : await fetchVehiclesFromChartr(routeText);

    return jsonResponse({ routeText, vehicles, source }, 200, {
      'Cache-Control': 'public, max-age=15',
    });
  } catch (error) {
    console.error('PMPML Vehicles API Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch vehicle tracking data', message: error.message },
      500,
    );
  }
}

async function fetchVehiclesFromGtfsRt(routeIds) {
  const allVehicles = await fetchVehiclePositions();
  const vehicles = [];

  for (const v of allVehicles) {
    if (!matchesRouteIds(v, routeIds)) continue;

    vehicles.push({
      vehicleId: v.vehicleId,
      vehicleNumber: v.vehicleLabel || v.vehicleId,
      location: {
        lat: v.lat,
        lng: v.lng,
      },
      bearing: v.bearing || null,
    });
  }

  return vehicles;
}

async function fetchVehiclesFromChartr(routeText) {
  // Try UP, DOWN, and plain variants of the route long name
  const variants = [routeText + 'UP', routeText + 'DOWN', routeText];
  const seenIds = new Set();
  const allVehicles = [];

  const results = await Promise.all(variants.map(fetchVehiclesForRoute));

  for (const vehicles of results) {
    if (!vehicles) continue;
    for (const v of vehicles) {
      if (!seenIds.has(v.vehicleId)) {
        seenIds.add(v.vehicleId);
        allVehicles.push(v);
      }
    }
  }

  return allVehicles;
}

async function fetchVehiclesForRoute(routeLongName) {
  try {
    const res = await fetch(
      'https://prod-pmpml-live-data-api.chartr.in/buses-on-route',
      {
        method: 'POST',
        headers: PMPML_HEADERS,
        body: JSON.stringify({ route_long_name: routeLongName }),
      },
    );

    if (!res.ok) return null;

    const result = await res.json();
    const vehicles = new Map();

    for (const v of result.data) {
      if (v.id && !vehicles.has(v.id)) {
        vehicles.set(v.id, {
          vehicleId: v.id,
          vehicleNumber: v.id,
          location: {
            lat: parseFloat(v.lat),
            lng: parseFloat(v.lon),
          },
          bearing: v.orientation === 0.0 ? null : v.orientation,
        });
      }
    }

    return Array.from(vehicles.values());
  } catch (error) {
    console.error(`Error fetching vehicle data for route ${routeLongName}:`, error);
    return null;
  }
}
