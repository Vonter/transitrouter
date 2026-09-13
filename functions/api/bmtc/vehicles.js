/**
 * Cloudflare Pages Function for BMTC Live Vehicle Tracking
 *
 * Endpoint: /api/bmtc/vehicles?routetext=KIA-9&servicetypeid=0
 *           /api/bmtc/vehicles?routeid=1101&servicetypeid=0
 *
 * Accepts either routetext (route name) or routeid (numeric GTFS-RT route
 * id) as parameter.
 *
 * routetext is resolved via the static BLR_ID_MAPPING — a route missing
 * from that mapping can't be served. Tries the GTFS-RT feed first once a
 * numeric route id is known (via routeid directly, or `.gtfsRtRouteId` from
 * the mapping); when that feed comes back empty (it only carries a sample
 * of the fleet), falls back to Chalo's route-live-info, queried once per
 * direction variant of the route and merged (see BLR_ID_MAPPING's
 * `.chaloRoutes`, and chalo.js). bmtcmobileapi.karnataka.gov.in is retired.
 *
 * Chalo's per-vehicle schema is leaner than GTFS-RT's contract fields here
 * (no schedule/actual times, stop info, trip position, etc.) — those are
 * explicit `null` rather than omitted, same as the GTFS-RT branch already
 * did before this migration.
 */
import BLR_ID_MAPPING from './blr-id-mapping.js';
import { fetchVehiclePositions, matchesRouteId } from './bmtc-rt.js';
import { fetchRouteLiveInfo, normalizeEtaSeconds, parseRouteMapping } from './chalo.js';

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return handleCORS();
  }

  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: getCORSHeaders(),
    });
  }

  try {
    const url = new URL(request.url);
    const routeText = url.searchParams.get('routetext');
    const routeIdParam = url.searchParams.get('routeid');

    if (!routeText && !routeIdParam) {
      return new Response(
        JSON.stringify({
          error: 'Either routetext or routeid parameter is required',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...getCORSHeaders() },
        },
      );
    }

    const { gtfsRtRouteId, chaloRoutes } = parseRouteMapping(
      routeText ? BLR_ID_MAPPING.routes[routeText] : null,
      BLR_ID_MAPPING,
    );

    let finalRouteId = routeIdParam ? parseInt(routeIdParam, 10) : null;
    if (!finalRouteId && gtfsRtRouteId) {
      finalRouteId = parseInt(gtfsRtRouteId, 10);
    }

    // Try GTFS-RT first whenever a numeric route id is already known.
    if (finalRouteId) {
      const gtfsVehicles = await fetchVehiclesFromGtfsRt(finalRouteId, routeText);
      if (gtfsVehicles.length > 0) {
        return new Response(
          JSON.stringify({ routeId: finalRouteId, vehicles: gtfsVehicles }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=15',
              ...getCORSHeaders(),
            },
          },
        );
      }
      // No live GTFS-RT vehicles for this route right now (feed only
      // samples the fleet) — fall through to Chalo below.
    }

    if (routeText && chaloRoutes.length > 0) {
      const vehicles = await fetchVehiclesFromChalo(chaloRoutes, routeText);
      return new Response(
        JSON.stringify({ routeId: finalRouteId || null, vehicles }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=15',
            ...getCORSHeaders(),
          },
        },
      );
    }

    // routetext not found in the mapping (no GTFS-RT id, no Chalo route) —
    // there's no live lookup left to fall back to.
    if (routeText && !finalRouteId) {
      return new Response(
        JSON.stringify({
          routeId: null,
          vehicles: [],
          geoJSON: { type: 'FeatureCollection', features: [] },
          message: 'No routes found',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=15',
            ...getCORSHeaders(),
          },
        },
      );
    }

    // Numeric routeid given but GTFS-RT had nothing and there's no
    // routetext to resolve a Chalo fallback from.
    return new Response(
      JSON.stringify({ routeId: finalRouteId, vehicles: [], message: 'No vehicle tracking data available' }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=15',
          ...getCORSHeaders(),
        },
      },
    );
  } catch (error) {
    console.error('BMTC Vehicles API Function Error:', error);
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch vehicle tracking data',
        message: error.message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...getCORSHeaders() },
      },
    );
  }
}

/**
 * Fetches vehicles for a route from the GTFS-RT feed, in the same shape
 * fetchVehiclesFromChalo below produces — fields the source has no
 * equivalent for (schedule, actual times, stop info, trip position, etc.)
 * are explicit `null` rather than omitted.
 */
async function fetchVehiclesFromGtfsRt(routeId, routeText) {
  let allVehicles;
  try {
    allVehicles = await fetchVehiclePositions();
  } catch (error) {
    console.error('BMTC GTFS-RT feed fetch failed, falling back to Chalo:', error);
    return [];
  }

  return allVehicles
    .filter((v) => matchesRouteId(v, routeId) && v.lat != null && v.lng != null)
    .map((v) => ({
      vehicleId: v.vehicleId,
      vehicleNumber: v.vehicleLabel || v.vehicleId,
      serviceType: null,
      serviceTypeId: null,
      location: { lat: v.lat, lng: v.lng },
      heading: v.bearing,
      eta: null,
      schedule: { arrivalTime: null, departureTime: null, tripStartTime: null, tripEndTime: null },
      actual: { arrivalTime: null, departureTime: null },
      stops: {
        last: null, current: null, next: null,
        lastLocationId: null, currentLocationId: null, nextLocationId: null,
      },
      stopCoveredStatus: null,
      tripPosition: null,
      lastRefresh: null,
      lastRefreshMs: v.timestamp ? v.timestamp * 1000 : null,
      lastReceivedFlag: null,
      direction: null,
      stationName: null,
      routeNo: routeText || null,
    }));
}

/**
 * Fetches vehicles for every direction variant of a route from Chalo's
 * route-live-info, merged and deduplicated by vehicle id.
 */
async function fetchVehiclesFromChalo(chaloRoutes, routeText) {
  const results = await Promise.all(
    chaloRoutes.map(async ({ chaloRouteId, sampleStopId }) => {
      try {
        return await fetchRouteLiveInfo(chaloRouteId, sampleStopId);
      } catch (error) {
        console.error(`Chalo route-live-info failed for ${chaloRouteId}:`, error);
        return new Map();
      }
    }),
  );

  const seen = new Set();
  const vehicles = [];
  for (const vehicleMap of results) {
    for (const [vehicleId, parsed] of vehicleMap) {
      if (seen.has(vehicleId)) continue;
      if (typeof parsed._latitude !== 'number' || typeof parsed._longitude !== 'number') continue;
      seen.add(vehicleId);
      vehicles.push({
        vehicleId,
        vehicleNumber: parsed.vNo || vehicleId,
        serviceType: null,
        serviceTypeId: null,
        location: { lat: parsed._latitude, lng: parsed._longitude },
        heading: parsed.bearing ?? null,
        eta: normalizeEtaSeconds(parsed.eta),
        schedule: { arrivalTime: null, departureTime: null, tripStartTime: null, tripEndTime: null },
        actual: { arrivalTime: null, departureTime: null },
        stops: {
          last: null, current: null, next: null,
          lastLocationId: null, currentLocationId: null, nextLocationId: null,
        },
        stopCoveredStatus: null,
        tripPosition: null,
        lastRefresh: null,
        lastRefreshMs: parsed.tS ?? null,
        lastReceivedFlag: null,
        direction: null,
        stationName: null,
        routeNo: routeText || null,
      });
    }
  }
  return vehicles;
}

function getCORSHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function handleCORS() {
  return new Response(null, { status: 204, headers: getCORSHeaders() });
}
