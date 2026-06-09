/**
 * Pure schedule-derived ETA helpers shared by the stop panel
 * (components/BusServicesArrival.js) and the /arrival page (arrival.js).
 *
 * Keeping this math in one place guarantees both pages compute identical
 * scheduled ETAs. Schedule trip times are "HH:MM[:SS]" strings in local time;
 * hours may exceed 24 for after-midnight trips. Times are treated at
 * whole-minute granularity and never wrapped to the next day — once the last
 * trip of the day has passed, a route simply has no upcoming scheduled ETA.
 */

/**
 * Minutes-of-day for a "HH:MM[:SS]" schedule time.
 * @param {string} time
 * @returns {number|null} Minutes since midnight, or null if unparseable.
 */
export function parseScheduleMinutes(time) {
  const match = typeof time === 'string' && /^(\d{1,2}):(\d{2})/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Upcoming departures later today from a list of schedule trip times.
 * @param {string[]} trips
 * @param {Date} [now]
 * @returns {Array<{minutes: number, duration_ms: number}>} Soonest first.
 */
export function upcomingDepartures(trips, now = new Date()) {
  if (!Array.isArray(trips)) return [];
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const result = [];
  for (const trip of trips) {
    const minutes = parseScheduleMinutes(trip);
    if (minutes == null) continue;
    const duration_ms = (minutes - nowMinutes) * 60 * 1000;
    if (duration_ms > 0) result.push({ minutes, duration_ms });
  }
  return result.sort((a, b) => a.duration_ms - b.duration_ms);
}

/**
 * Milliseconds until the next scheduled departure later today.
 * @param {string[]} trips
 * @param {Date} [now]
 * @returns {number|null} ms until the soonest upcoming trip, or null if none remain.
 */
export function nextDepartureMs(trips, now = new Date()) {
  if (!Array.isArray(trips) || !trips.length) return null;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let best = Infinity;
  for (const trip of trips) {
    const tripMinutes = parseScheduleMinutes(trip);
    if (tripMinutes == null) continue;
    const diff = tripMinutes - nowMinutes;
    if (diff > 0 && diff < best) best = diff;
  }
  return best === Infinity ? null : best * 60 * 1000;
}

/**
 * Next scheduled departure (ms) per route, from a stop's schedule JSON.
 * When a route has multiple direction entries, the soonest is kept.
 * @param {{services?: Array<{no: string, origin: string, trips: string[]}>}} scheduleData
 * @param {{originStopId?: string|number|null, now?: Date}} [options]
 *   originStopId — when set, only routes that originate at this stop are included.
 * @returns {Map<string, number>} route number → ms until next departure.
 */
export function scheduleETAByRoute(
  scheduleData,
  { originStopId = null, now = new Date() } = {},
) {
  const map = new Map();
  scheduleData?.services?.forEach((s) => {
    if (originStopId != null && String(s.origin) !== String(originStopId))
      return;
    const ms = nextDepartureMs(s.trips, now);
    if (ms == null) return;
    const existing = map.get(s.no);
    if (existing == null || ms < existing) map.set(s.no, ms);
  });
  return map;
}
