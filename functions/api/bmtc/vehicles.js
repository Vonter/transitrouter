/**
 * Cloudflare Pages Function for BMTC Live Vehicle Tracking
 *
 * Endpoint: /api/bmtc/vehicles?routetext=KIA-9&servicetypeid=0
 *           /api/bmtc/vehicles?routeid=1101&servicetypeid=0
 *
 * routetext is resolved via BLR_ID_MAPPING — a route missing from it can't
 * be served. Tries the GTFS-RT feed first (lower latency than a live
 * call), matching against every known id for the route: Namma BMTC's ids
 * first, then the legacy numeric BMTC id — trying Namma BMTC ids first
 * means the fast path keeps working automatically if gtfs.bengawalk.com
 * ever switches its route_id scheme to match Namma BMTC's. Only falls back
 * to a live Namma BMTC route-live-info call (once per direction variant,
 * merged) when neither matches. bmtcmobileapi.karnataka.gov.in is retired.
 */
import BLR_ID_MAPPING from './blr-id-mapping.js';
import { fetchVehiclePositions, matchesRouteId } from './bmtc-rt.js';
import { fetchRouteLiveInfo, normalizeEtaSeconds, parseRouteMapping } from './namma-bmtc.js';

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

    const { gtfsRtRouteId, nammaBmtcRoutes } = parseRouteMapping(
      routeText ? BLR_ID_MAPPING.routes[routeText] : null,
      BLR_ID_MAPPING,
    );

    let finalRouteId = routeIdParam ? parseInt(routeIdParam, 10) : null;
    if (!finalRouteId && gtfsRtRouteId) {
      finalRouteId = parseInt(gtfsRtRouteId, 10);
    }

    // Try GTFS-RT first, against every id scheme we know for this route.
    const gtfsAllVehicles = await fetchGtfsRtVehicles();
    if (gtfsAllVehicles) {
      const gtfsCandidates = [...nammaBmtcRoutes.map((r) => r.nammaBmtcRouteId), finalRouteId].filter(Boolean);
      for (const candidateId of gtfsCandidates) {
        const matched = matchGtfsRtVehicles(gtfsAllVehicles, candidateId, routeText);
        if (matched.length > 0) {
          return new Response(
            JSON.stringify({ routeId: finalRouteId || null, vehicles: matched }),
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
      }
      // No live GTFS-RT vehicles under any known id — fall through.
    }

    if (routeText && nammaBmtcRoutes.length > 0) {
      const vehicles = await fetchVehiclesFromNammaBmtc(nammaBmtcRoutes, routeText);
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

    // routetext not found in the mapping — nothing left to fall back to.
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
    // routetext to resolve a Namma BMTC fallback from.
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

/** Fetches the GTFS-RT feed once; `null` on failure so callers can tell a
 * feed outage apart from "fetched OK, nothing matched". */
async function fetchGtfsRtVehicles() {
  try {
    return await fetchVehiclePositions();
  } catch (error) {
    console.error('BMTC GTFS-RT feed fetch failed, falling back to Namma BMTC:', error);
    return null;
  }
}

/** Filters already-fetched GTFS-RT vehicles by route id, in the same
 * shape fetchVehiclesFromNammaBmtc below produces (fields the feed has no
 * equivalent for are explicit `null` rather than omitted). */
function matchGtfsRtVehicles(allVehicles, routeId, routeText) {
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

/** Fetches vehicles for every direction variant of a route from Namma
 * BMTC's route-live-info, merged and deduplicated by vehicle id. */
async function fetchVehiclesFromNammaBmtc(nammaBmtcRoutes, routeText) {
  const results = await Promise.all(
    nammaBmtcRoutes.map(async ({ nammaBmtcRouteId, sampleStopId }) => {
      try {
        return await fetchRouteLiveInfo(nammaBmtcRouteId, sampleStopId);
      } catch (error) {
        console.error(`Namma BMTC route-live-info failed for ${nammaBmtcRouteId}:`, error);
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
