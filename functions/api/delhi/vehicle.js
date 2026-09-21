/**
 * Cloudflare Pages Function for Delhi (DTC) GTFS-RT vehicle lookup
 * Endpoint: /api/delhi/vehicle                  (all active vehicles)
 *           /api/delhi/vehicle?vehicleid=<id>   (one vehicle's info)
 * See ../vehicle.js for the response shapes.
 *
 * Only the VehiclePositions feed is consumed for Delhi, so there are no
 * per-stop arrival times in the response.
 */
import { createVehicleHandler } from '../vehicle.js';
import { fetchVehiclePositions } from './delhi-rt.js';
import ROUTE_MAPPING from './delhi-route-mapping.js';

const ROUTE_ID_TO_NAME = Object.fromEntries(
  Object.entries(ROUTE_MAPPING).flatMap(([name, ids]) => ids.map((id) => [id, name])),
);

export const onRequest = createVehicleHandler(
  'Delhi',
  async ({ env }) => ({ vehicles: await fetchVehiclePositions(env), tripUpdates: [] }),
  { resolveRouteNo: (routeId) => ROUTE_ID_TO_NAME[routeId] },
);
