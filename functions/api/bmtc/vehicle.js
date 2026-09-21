/**
 * Cloudflare Pages Function for BMTC GTFS-RT vehicle lookup
 * Endpoint: /api/bmtc/vehicle                  (all active vehicles)
 *           /api/bmtc/vehicle?vehicleid=<id>   (one vehicle's info)
 * See ../vehicle.js for the response shapes.
 *
 * Trip update stop ids are Namma BMTC's; they're translated to local stop
 * ids via BLR_ID_MAPPING when the route is known, matching vehicles.js.
 * The feed's route_id is used directly as the route number unless it's a
 * known gtfsRtRouteId, in which case it resolves to the local route name.
 */
import BLR_ID_MAPPING from './blr-id-mapping.js';
import { createVehicleHandler } from '../vehicle.js';
import { fetchGtfsRtFeed } from './bmtc-rt.js';
import { getRouteStopIndex, parseRouteMapping } from './namma-bmtc.js';

let routeNameByGtfsRtId = null;
function resolveRouteNo(routeId) {
  if (!routeNameByGtfsRtId) {
    routeNameByGtfsRtId = new Map();
    for (const [name, entry] of Object.entries(BLR_ID_MAPPING.routes)) {
      const { gtfsRtRouteId } = parseRouteMapping(entry, BLR_ID_MAPPING);
      if (gtfsRtRouteId) routeNameByGtfsRtId.set(gtfsRtRouteId, name);
    }
  }
  return routeNameByGtfsRtId.get(String(routeId)) || routeId;
}

function mapStopId(stopId, routeId) {
  const index = getRouteStopIndex(BLR_ID_MAPPING);
  const routeText = resolveRouteNo(routeId);
  const { nammaBmtcRoutes } = parseRouteMapping(BLR_ID_MAPPING.routes[routeText], BLR_ID_MAPPING);
  for (const { nammaBmtcRouteId } of nammaBmtcRoutes) {
    const local = index.get(nammaBmtcRouteId)?.get(stopId);
    if (local) return local;
  }
  return stopId;
}

export const onRequest = createVehicleHandler('BMTC', () => fetchGtfsRtFeed(), {
  resolveRouteNo,
  mapStopId,
});
