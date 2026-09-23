/**
 * Shared TripUpdate -> `services` conversion for the Indian Railways
 * endpoints (stop-routes.js, arrivals.js), which differ only in whether
 * they enrich each trip with the train's live position.
 *
 * `no`/route_id is the bare train number (see railways-rt.js); `destination`
 * is resolved from the last stop of the TripUpdate's own remaining
 * stop_time_updates — the feed doesn't carry the train's true scheduled
 * terminus, so this is "as far as this update currently knows", the same
 * approximation other cities' live APIs make for `destination`/
 * `destination_code` (e.g. PMPML's `terminal_stop`).
 */
import STATIONS from '../../../data/railways/stops.min.json';

const MAX_MS = 90 * 60 * 1000;

const stationName = (stopId) => STATIONS[stopId]?.[2] || stopId;

/**
 * Converts this feed's TripUpdates into the `services` shape the frontend
 * expects, for the ones with a stop_time_update at `stationId`.
 * `vehicleLocations` (from buildVehicleLocationLookup), when given, attaches
 * each trip's live position; omit it for a position-free "Phase 1" response.
 */
export function convertTripUpdatesToServices(tripUpdates, stationId, vehicleLocations = null) {
  const nowMs = Date.now();
  const servicesMap = new Map();

  for (const tu of tripUpdates) {
    const stopIdx = tu.stopTimeUpdates.findIndex((stu) => stu.stopId === stationId);
    if (stopIdx === -1) continue;

    const stu = tu.stopTimeUpdates[stopIdx];
    const eventTime = stu.arrival?.time ?? stu.departure?.time;
    if (eventTime == null) continue;

    const duration_ms = eventTime * 1000 - nowMs;
    if (duration_ms < 0 || duration_ms > MAX_MS) continue;

    const lastStop = tu.stopTimeUpdates[tu.stopTimeUpdates.length - 1];
    const destinationCode = lastStop?.stopId ?? null;
    const destination = destinationCode ? stationName(destinationCode) : null;

    const trainNumber = tu.routeId;
    const key = trainNumber || tu.tripId;
    if (!servicesMap.has(key)) {
      servicesMap.set(key, { no: trainNumber || tu.tripId, destination, trips: [] });
    }

    const location =
      vehicleLocations &&
      ((tu.vehicleId && vehicleLocations.get(tu.vehicleId)) ||
        (tu.vehicleLabel && vehicleLocations.get(tu.vehicleLabel)));

    servicesMap.get(key).trips.push({
      duration_ms,
      type: 'SD',
      load: 'SEA',
      feature: 'WAB',
      visit_number: 1,
      origin_code: null,
      destination_code: destination,
      vehicle_id: tu.vehicleId,
      bus_no: trainNumber,
      ...(vehicleLocations ? { location: location || null } : {}),
    });
  }

  return Array.from(servicesMap.values()).map(({ no, destination, trips }) => {
    trips.sort((a, b) => a.duration_ms - b.duration_ms);
    const service = { no, destination, frequency: trips.length };
    if (trips[0]) service.next = trips[0];
    if (trips[1]) service.next2 = trips[1];
    if (trips[2]) service.next3 = trips[2];
    return service;
  });
}
