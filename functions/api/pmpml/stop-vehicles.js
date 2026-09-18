/**
 * Cloudflare Pages Function for PMPML Stop Vehicles (Phase 2, GTFS-RT variant)
 * Fetches vehicle positions for multiple routes at a stop.
 * Endpoint: /api/pmpml-gtfs/stop-vehicles?routes=220,50,14RING
 *
 * Filters the GTFS-RT feed's VehiclePositions by route_id, translating each
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
  Accept: 'application/json, text/plain, */*',
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
    const routesParam = new URL(request.url).searchParams.get('routes');

    if (!routesParam) {
      return jsonResponse({ error: 'routes parameter is required' }, 400);
    }

    const routeNames = routesParam
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);

    if (routeNames.length === 0) {
      return jsonResponse({ vehicles: [] }, 200);
    }

    const mappedNames = [];
    const unmappedNames = [];
    for (const name of routeNames) {
      if (ROUTE_MAPPING[name]?.length) mappedNames.push(name);
      else unmappedNames.push(name);
    }

    const [gtfsVehicles, chartrVehicles] = await Promise.all([
      mappedNames.length ? fetchVehiclePositions() : Promise.resolve([]),
      unmappedNames.length ? fetchVehiclesFromChartr(unmappedNames) : Promise.resolve([]),
    ]);

    const allVehicles = [...chartrVehicles];

    if (mappedNames.length) {
      // A vehicle can match more than one requested route if their mapped
      // route_ids overlap (shouldn't normally happen, but merge defensively).
      const matched = new Map(); // vehicleId -> { vehicle, routeNames: Set }
      for (const v of gtfsVehicles) {
        if (v.lat == null || v.lng == null) continue;
        for (const name of mappedNames) {
          if (!matchesRouteIds(v, ROUTE_MAPPING[name])) continue;

          const key = v.vehicleId || `${v.routeId}:${v.lat},${v.lng}`;
          if (!matched.has(key)) matched.set(key, { vehicle: v, routeNames: new Set() });
          matched.get(key).routeNames.add(name);
        }
      }

      for (const { vehicle, routeNames: names } of matched.values()) {
        allVehicles.push({
          vehicleId: vehicle.vehicleId,
          vehicleNumber: vehicle.vehicleLabel || vehicle.vehicleId,
          lat: vehicle.lat,
          lng: vehicle.lng,
          bearing: vehicle.bearing || null,
          routeNames: Array.from(names),
        });
      }
    }

    const cacheHeaders = { 'Cache-Control': 'public, max-age=15' };
    return jsonResponse({ vehicles: allVehicles }, 200, cacheHeaders);
  } catch (error) {
    console.error('PMPML Stop Vehicles Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch vehicle data', message: error.message },
      500,
    );
  }
}

async function fetchVehiclesFromChartr(routeNames) {
  // Resolve route names to route long name variants, deduplicate
  const routeIdToNames = new Map();
  for (const name of routeNames) {
    const names = [name + 'UP', name + 'DOWN', name];
    for (const n of names) {
      if (!routeIdToNames.has(n)) routeIdToNames.set(n, []);
      routeIdToNames.get(n).push(name);
    }
  }

  const allVehicles = [];
  await Promise.all(
    Array.from(routeIdToNames.entries()).map(async ([routeId, serviceNames]) => {
      const vehicles = await fetchVehiclesForRoute(routeId);
      if (!vehicles) return;
      vehicles.forEach((v) => {
        allVehicles.push({ ...v, routeNames: serviceNames });
      });
    }),
  );

  return allVehicles;
}

async function fetchVehiclesForRoute(routeLongName) {
  try {
    const res = await fetch(
      'https://prod-pmpml-live-data-api.chartr.in/buses-on-route',
      {
        method: 'POST',
        headers: PMPML_HEADERS,
        body: JSON.stringify({
          route_long_name: routeLongName
        }),
      },
    );

    if (!res.ok) return null;

    const result = await res.json();
    const vehicles = new Map();
    for (const v of result.data) {
      if(v.id && !vehicles.has(v.id)) {
        vehicles.set(v.id, {
          vehicleId: v.id,
          vehicleNumber: v.id,
          lat: parseFloat(v.lat),
          lng: parseFloat(v.lon),
          bearing: v.orientation === 0.0 ? null : v.orientation,
        })
      }
    }

    return Array.from(vehicles.values());
  } catch (error) {
    console.error(`Error fetching vehicle data for route ${routeLongName}:`, error);
    return null;
  }
}
