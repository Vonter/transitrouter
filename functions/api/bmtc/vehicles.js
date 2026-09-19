/**
 * Cloudflare Pages Function for BMTC Live Vehicle Tracking
 *
 * Endpoint: /api/bmtc/vehicles?routetext=KIA-9&servicetypeid=0
 *           /api/bmtc/vehicles?routeid=1101&servicetypeid=0
 * routeid is reverse-resolved to a routetext via BLR_ID_MAPPING when possible.
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
import { fetchGtfsRtFeed, matchesRouteId } from './bmtc-rt.js';
import { fetchRouteLiveInfo, getRouteStopIndex, normalizeEtaSeconds, parseRouteMapping } from './namma-bmtc.js';

export async function onRequest(context) {
  const { request } = context;
  const userAgent = request.headers.get('User-Agent');

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
    const routeIdParam = url.searchParams.get('routeid');
    const routeText =
      url.searchParams.get('routetext') || resolveRouteTextFromId(routeIdParam);

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
    const gtfsFeed = await fetchGtfsRtFeedOrNull();
    if (gtfsFeed) {
      // The feed's route_id is currently the route text (e.g. "KIA-9").
      const gtfsCandidates = [routeText, ...nammaBmtcRoutes.map((r) => r.nammaBmtcRouteId), finalRouteId].filter(Boolean);
      for (const candidateId of gtfsCandidates) {
        const matched = matchGtfsRtVehicles(gtfsFeed, candidateId, routeText, nammaBmtcRoutes);
        if (matched.length > 0) {
          return new Response(
            JSON.stringify({ routeId: finalRouteId || null, vehicles: matched, source: 'gtfs-rt' }),
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
      const vehicles = await fetchVehiclesFromNammaBmtc(nammaBmtcRoutes, routeText, userAgent);
      return new Response(
        JSON.stringify({ routeId: finalRouteId || null, vehicles, source: 'api' }),
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
          source: null,
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
      JSON.stringify({ routeId: finalRouteId, vehicles: [], source: null, message: 'No vehicle tracking data available' }),
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

let routeTextById = null;

/** Reverse-resolves a route id (GTFS-RT id or Namma BMTC id) to its
 * routetext via BLR_ID_MAPPING, so routeid queries can use the same
 * Namma BMTC fallback as routetext ones. */
function resolveRouteTextFromId(routeId) {
  if (!routeId) return null;
  if (!routeTextById) {
    routeTextById = new Map();
    for (const [text, entry] of Object.entries(BLR_ID_MAPPING.routes)) {
      const { gtfsRtRouteId, nammaBmtcRoutes } = parseRouteMapping(entry, BLR_ID_MAPPING);
      if (gtfsRtRouteId) routeTextById.set(gtfsRtRouteId, text);
      for (const r of nammaBmtcRoutes) routeTextById.set(r.nammaBmtcRouteId, text);
    }
  }
  return routeTextById.get(String(routeId)) || null;
}

/** Fetches the GTFS-RT feed once; `null` on failure so callers can tell a
 * feed outage apart from "fetched OK, nothing matched". */
async function fetchGtfsRtFeedOrNull() {
  try {
    return await fetchGtfsRtFeed();
  } catch (error) {
    console.error('BMTC GTFS-RT feed fetch failed, falling back to Namma BMTC:', error);
    return null;
  }
}

/** Filters already-fetched GTFS-RT vehicles by route id, in the same
 * shape fetchVehiclesFromNammaBmtc below produces (fields the feed has no
 * equivalent for are explicit `null` rather than omitted). Each vehicle's
 * trip update (joined on vehicle id — the feed leaves trip_id empty) gives
 * the next stop it is heading to and the ETA there: the first remaining
 * stop_time_update, in Namma BMTC stop ids. */
function matchGtfsRtVehicles({ vehicles, tripUpdates }, routeId, routeText, nammaBmtcRoutes) {
  const tripUpdateByVehicle = new Map();
  for (const tu of tripUpdates) {
    for (const key of [tu.vehicleId, tu.vehicleLabel]) {
      if (key && !tripUpdateByVehicle.has(key)) tripUpdateByVehicle.set(key, tu);
    }
  }
  const stopIndex = getRouteStopIndex(BLR_ID_MAPPING);
  const nowSec = Date.now() / 1000;

  const nextStopFor = (v) => {
    const tu = tripUpdateByVehicle.get(v.vehicleId) || tripUpdateByVehicle.get(v.vehicleLabel);
    const next = tu?.stopTimeUpdates?.[0];
    if (!next?.stopId) return { localStopId: null, etaSeconds: null };
    let localStopId = null;
    for (const { nammaBmtcRouteId } of nammaBmtcRoutes) {
      localStopId = stopIndex.get(nammaBmtcRouteId)?.get(next.stopId) ?? null;
      if (localStopId) break;
    }
    const time = next.arrival?.time ?? next.departure?.time;
    return { localStopId, etaSeconds: time ? Math.max(0, Math.round(time - nowSec)) : null };
  };

  return vehicles
    .filter((v) => matchesRouteId(v, routeId) && v.lat != null && v.lng != null)
    .map((v) => {
      const { localStopId, etaSeconds } = nextStopFor(v);
      return {
        vehicleId: v.vehicleId,
        vehicleNumber: v.vehicleLabel || v.vehicleId,
        serviceType: null,
        serviceTypeId: null,
        location: { lat: v.lat, lng: v.lng },
        heading: v.bearing,
        eta: etaSeconds,
        schedule: { arrivalTime: null, departureTime: null, tripStartTime: null, tripEndTime: null },
        actual: { arrivalTime: null, departureTime: null },
        stops: {
          last: null, current: null, next: null,
          lastLocationId: null, currentLocationId: null, nextLocationId: localStopId,
        },
        stopCoveredStatus: null,
        tripPosition: null,
        lastRefresh: null,
        lastRefreshMs: v.timestamp ? v.timestamp * 1000 : null,
        lastReceivedFlag: null,
        direction: null,
        stationName: null,
        routeNo: routeText || null,
      };
    });
}

/** Fetches vehicles for every direction variant of a route from Namma
 * BMTC's route-live-info, merged and deduplicated by vehicle id. */
async function fetchVehiclesFromNammaBmtc(nammaBmtcRoutes, routeText, userAgent) {
  const results = await Promise.all(
    nammaBmtcRoutes.map(async ({ nammaBmtcRouteId, sampleStopId }) => {
      try {
        return await fetchRouteLiveInfo(nammaBmtcRouteId, sampleStopId, userAgent);
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
