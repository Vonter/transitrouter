/**
 * Cloudflare Pages Function for BMTC Stop Routes (Phase 1)
 * Returns arrival ETAs without vehicle positions for fast initial render.
 * Endpoint: /api/bmtc/stop-routes?stationid=20558
 *
 * Same Namma BMTC stop-route-eta source as arrivals.js (see that file for the
 * id-resolution and data-richness notes), just without the GTFS-RT
 * location enrichment step.
 */
import BLR_ID_MAPPING from './blr-id-mapping.js';
import { applyBusLoads, fetchStopRouteEta, normalizeEtaSeconds, parseRouteMapping, parseStopMapping } from './namma-bmtc.js';

// ETAs come from Namma BMTC's own API, not a GTFS-RT feed.
const SOURCE = 'api';

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

// nammaBmtcRouteId -> local route_short_name, built once from BLR_ID_MAPPING so
// services can be labeled with local names rather than Namma BMTC's own `rN`.
let nammaBmtcRouteIdToLocalName = null;
function getNammaBmtcRouteIdToLocalName() {
  if (nammaBmtcRouteIdToLocalName) return nammaBmtcRouteIdToLocalName;
  nammaBmtcRouteIdToLocalName = new Map();
  for (const [name, entry] of Object.entries(BLR_ID_MAPPING.routes)) {
    const { nammaBmtcRoutes } = parseRouteMapping(entry, BLR_ID_MAPPING);
    for (const { nammaBmtcRouteId } of nammaBmtcRoutes) {
      nammaBmtcRouteIdToLocalName.set(nammaBmtcRouteId, name);
    }
  }
  return nammaBmtcRouteIdToLocalName;
}

export async function onRequest(context) {
  const { request } = context;
  const userAgent = request.headers.get('User-Agent');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const stationId = new URL(request.url).searchParams.get('stationid');

    if (!stationId) {
      return jsonResponse({ error: 'stationid parameter is required' }, 400);
    }

    const cacheHeaders = { 'Cache-Control': 'public, max-age=10' };

    const stopRoutePairs = parseStopMapping(BLR_ID_MAPPING.stops[stationId], BLR_ID_MAPPING);
    if (stopRoutePairs.length === 0) {
      return jsonResponse({ services: [], source: SOURCE }, 200, cacheHeaders);
    }

    // Each pair already carries the Namma BMTC stop id specific to that route's
    // own direction (see parseStopMapping) — no shared/collapsed stop id.
    const stopIdRouteIdList = stopRoutePairs.map(({ routeId, nammaBmtcStopId }) => `${nammaBmtcStopId}:${routeId}`);
    const etaResult = await fetchStopRouteEta(stopIdRouteIdList, userAgent);

    const services = await convertNammaBmtcToServices(etaResult, stopIdRouteIdList, userAgent);
    return jsonResponse({ services, source: SOURCE }, 200, cacheHeaders);
  } catch (error) {
    console.error('BMTC Stop Routes Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch stop routes', message: error.message },
      500,
    );
  }
}

async function convertNammaBmtcToServices(etaResult, stopIdRouteIdList, userAgent) {
  const MAX_MS = 90 * 60 * 1000;
  const routeIdToLocalName = getNammaBmtcRouteIdToLocalName();

  const servicesMap = new Map();
  const allTrips = [];
  for (const pairKey of stopIdRouteIdList) {
    const [, nammaBmtcRouteId] = pairKey.split(':');
    const localRouteName = routeIdToLocalName.get(nammaBmtcRouteId);
    if (!localRouteName) continue;

    const vehicleMap = etaResult.get(pairKey);
    if (!vehicleMap) continue;

    for (const [vehicleId, parsed] of vehicleMap) {
      const etaSeconds = normalizeEtaSeconds(parsed.eta);
      if (etaSeconds == null) continue;

      const duration_ms = etaSeconds * 1000;
      if (duration_ms > MAX_MS) continue;

      const key = `${localRouteName}-${parsed.dest}`;
      if (!servicesMap.has(key)) {
        servicesMap.set(key, { no: localRouteName, destination: parsed.dest, trips: [] });
      }

      const trip = {
        duration_ms,
        type: 'SD',
        load: 'SEA',
        feature: 'WAB',
        visit_number: 1,
        origin_code: null,
        destination_code: parsed.dest,
        vehicle_id: vehicleId,
        bus_no: parsed.vNo,
      };
      servicesMap.get(key).trips.push(trip);
      allTrips.push(trip);
    }
  }

  await applyBusLoads(allTrips, userAgent);

  return Array.from(servicesMap.values()).map(({ no, destination, trips }) => {
    trips.sort((a, b) => a.duration_ms - b.duration_ms);
    const service = { no, destination, frequency: trips.length };
    if (trips[0]) service.next = trips[0];
    if (trips[1]) service.next2 = trips[1];
    if (trips[2]) service.next3 = trips[2];
    if (trips[3]) service.next4 = trips[3];
    if (trips[4]) service.next5 = trips[4];
    return service;
  });
}
