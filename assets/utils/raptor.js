/**
 * Unscoped (cross-city) RAPTOR route search for all-mode `between`.
 *
 * Pure functions only — no module-level state, no DOM/Worker dependency —
 * so this can run inline on the main thread against `cityDataMap` once every
 * city is loaded (all-mode's "load all cities unconditionally" scope
 * decision), unlike single-city `dataWorker.js`'s single-transfer search
 * which stays as-is.
 *
 * Global ids are city-qualified everywhere, since raw stop/service numbers
 * are not unique across cities (see missing-features.md #20):
 *   globalStopId  = "{city}^{stopNumber}"
 *   globalRouteKey = "{city}^{service}|{destination}|{variantIdx}"
 *
 * Phase 1 scope: schedule/frequency-based cost function only,
 * no live-arrival fan-out during the search.
 *
 * Cost-function note: the search loop uses ONLY the precomputed nationwide
 * frequency index (data/all/frequency.min.json) — a synchronous, in-memory
 * lookup. An earlier version fetched each stop's real per-day schedule.json
 * mid-search; at country-wide scale (all cities loaded) the reachable set
 * balloons past round 1 via hub stops (one stop can sit on hundreds of
 * routes), which turned into hundreds of thousands of concurrent schedule
 * fetches — not viable regardless of batching. Real schedules are instead
 * fetched only for the final itinerary's boarding stops, via
 * `refineWithSchedule`, after the search has already picked a route.
 */

import fetchCache from './fetchCache';

const WALK_SPEED_MPS = 1.1; // ~4 km/h
// schedule.json has no trip_id stitched across a trip's stops
// — there's no way to know a
// specific trip's real arrival time at downstream stops, so travel time
// between consecutive stops on a route is approximated from stop-to-stop
// straight-line distance at an assumed average transit speed.
const AVG_TRANSIT_SPEED_MPS = 5.6; // ~20 km/h
const MINUTES_PER_DAY = 24 * 60;
const DEFAULT_MAX_ROUNDS = 4;
// How many distinct stop-sequence "patterns" (see patternKeyFor below) each
// stop keeps track of during the search. >1 is what lets a genuinely
// different route through the network (e.g. transferring at a different
// railway station) survive alongside the fastest option instead of being
// silently discarded the moment something a few minutes faster is found.
// Kept fairly generous (rather than the bare minimum of 2) because patterns
// are deduped strictly by route identity - two near-identical express/local
// variants of the same corridor count as separate patterns and can otherwise
// crowd out a genuinely different route (e.g. a different transfer hub)
// before it gets a chance to be considered.
const TOP_K_PATTERNS = 4;
const SCHEDULE_BASE_URL = 'https://data.transitrouter.vonter.in';
const SCHEDULE_CACHE_MINUTES = 60;

const EARTH_RADIUS_M = 6371000;

function haversineMeters([lng1, lat1], [lng2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function parseGlobalRouteKey(globalRouteKey) {
  const caretIdx = globalRouteKey.indexOf('^');
  if (caretIdx === -1) return null;
  const city = globalRouteKey.slice(0, caretIdx);
  const rest = globalRouteKey.slice(caretIdx + 1);
  const first = rest.indexOf('|');
  const second = rest.indexOf('|', first + 1);
  if (first === -1 || second === -1) return null;
  return {
    city,
    service: rest.slice(0, first),
    destination: rest.slice(first + 1, second),
    variantIdx: rest.slice(second + 1),
  };
}

// Rebuilding this from scratch is O(total stops/routes across every loaded
// city) — expensive, and was previously redone on *every* between search
// even when the set of loaded cities hadn't changed since the last one.
// Cached here, keyed on a sorted signature of cityDataMap's current city
// set, so it's only rebuilt when that set actually changes.
let cachedIndex = null;
let cachedSignature = null;

/**
 * Merge every loaded city's stopsData/servicesData/clustersData (from
 * `cityDataMap`) into one city-qualified route-major index RAPTOR can search
 * over. `clusters` (same-place stop groups) is assembled from each city's own
 * clustersData plus the small nationwide `crossCityClusters` leftover (see
 * globaltransfers.py) instead of one ever-growing nationwide clusters file.
 *
 * @param {Map<string,{stopsData:Object, servicesData:Object, clustersData:Object}>} cityDataMap
 * @param {Object.<string, Array<[string, number]>>} [crossCityClusters] - global clusters-cross-city.min.json
 */
export function buildGlobalRouteIndex(cityDataMap, crossCityClusters = {}) {
  const signature = [...cityDataMap.keys()].sort().join(',');
  if (cachedIndex && cachedSignature === signature) return cachedIndex;

  const stopRoutes = new Map(); // globalStopId -> globalRouteKey[]
  const routeStopSequence = new Map(); // globalRouteKey -> globalStopId[]
  // globalRouteKey -> Map(globalStopId -> index within that route's sequence)
  // — precomputed once here so the round loop's boarding-index lookup is an
  // O(1) Map.get instead of an O(route length) seq.indexOf per marked stop.
  const routeStopIndex = new Map();
  const stopMeta = new Map(); // globalStopId -> {city, number, coordinates, name}
  const clusters = {}; // globalStopId -> [[globalNeighborId, distanceM], ...]

  for (const [city, cityData] of cityDataMap) {
    const { stopsData, servicesData, clustersData } = cityData;

    if (clustersData) {
      for (const number in clustersData) {
        const globalStopId = `${city}^${number}`;
        const sameCity = clustersData[number].map(([n, d]) => [`${city}^${n}`, d]);
        const cross = crossCityClusters[globalStopId] || [];
        if (sameCity.length || cross.length) clusters[globalStopId] = [...sameCity, ...cross];
      }
    }

    for (const number in stopsData) {
      const stop = stopsData[number];
      const globalStopId = `${city}^${number}`;
      stopMeta.set(globalStopId, {
        city,
        number,
        coordinates: stop.coordinates,
        name: stop.name,
      });
      stopRoutes.set(
        globalStopId,
        (stop.routes || []).map((routeKey) => `${city}^${routeKey}`),
      );
    }

    for (const service in servicesData) {
      const serviceEntry = servicesData[service];
      for (const destination in serviceEntry) {
        if (destination === 'name') continue;
        const variants = serviceEntry[destination];
        variants.forEach((stopSeq, variantIdx) => {
          const globalRouteKey = `${city}^${service}|${destination}|${variantIdx}`;
          const globalStopSeq = stopSeq.map((n) => `${city}^${n}`);
          routeStopSequence.set(globalRouteKey, globalStopSeq);
          const stopIndex = new Map();
          globalStopSeq.forEach((stopId, i) => {
            // A route can legitimately revisit the same stop id (a loop
            // service); keep the *first* occurrence, matching indexOf's
            // behavior exactly so this is a drop-in replacement.
            if (!stopIndex.has(stopId)) stopIndex.set(stopId, i);
          });
          routeStopIndex.set(globalRouteKey, stopIndex);
        });
      }
    }
  }

  cachedIndex = { stopRoutes, routeStopSequence, routeStopIndex, stopMeta, clusters };
  cachedSignature = signature;
  return cachedIndex;
}

function parseTripMinutes(timeStr) {
  const colonIdx = timeStr.indexOf(':');
  if (colonIdx === -1) return null;
  const hours = parseInt(timeStr.slice(0, colonIdx), 10);
  const minutes = parseInt(timeStr.slice(colonIdx + 1), 10);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

// schedule.json's "HH:MM" trip strings are local wall-clock times, but
// boardTime/alightTime are absolute epoch-minute timestamps — the same
// representation `formatEpochMinutes` in BetweenRoutes.js reads via
// `new Date(mins * 60000).getHours()/.getMinutes()` (local getters). Taking
// `epochMinutes % 1440` instead assumes the local UTC offset is a whole
// multiple of a day, which is false almost everywhere (e.g. IST is UTC+5:30)
// — that mismatch is what made refineWithSchedule match against the wrong
// time-of-day and produce nonsensical (earlier/unrelated) departure times.
function localMinuteOfDay(epochMinutes) {
  const d = new Date(epochMinutes * 60000);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Earliest boarding time (absolute minutes) catchable at a stop for a given
 * service, at or after `afterMinutes` — a pure, synchronous expected-wait
 * estimate from the precomputed nationwide frequency index (no network
 * calls). Mirrors the existing client-side `staticFrequency` heuristic.
 *
 * @param {Object.<string, Object.<string, number>>} frequencyIndex - data/all/frequency.min.json
 * @returns {number|null} null if this stop/service has no frequency data
 */
function estimateBoardingTime(stopId, service, afterMinutes, frequencyIndex) {
  const dailyTripCount = frequencyIndex[stopId]?.[service];
  if (!dailyTripCount) return null;
  return afterMinutes + MINUTES_PER_DAY / dailyTripCount / 2;
}

function cumulativeDistances(stopSeq, stopMeta) {
  const cum = [0];
  for (let i = 1; i < stopSeq.length; i++) {
    const a = stopMeta.get(stopSeq[i - 1]);
    const b = stopMeta.get(stopSeq[i]);
    const d = a && b ? haversineMeters(a.coordinates, b.coordinates) : 0;
    cum.push(cum[i - 1] + d);
  }
  return cum;
}

// Extends a label's pattern identity by the leg just taken. Deliberately
// keyed on the *route* (which, via its variantIdx, already captures the full
// stop-by-stop sequence a given trip follows - see buildGlobalRouteIndex)
// rather than just the resulting stop id, so two express/local variants of
// the same service that happen to share the same board/alight stops still
// count as genuinely different patterns, not duplicates of each other.
// Walk legs deliberately do NOT extend the pattern - walking to a different
// nearby stop before/after riding the exact same service (e.g. boarding at
// whichever of two close-together platforms, or alighting one stop earlier
// and walking the rest of the way) isn't a meaningfully different journey,
// just a trivial last-mile variation. Only riding a genuinely different
// service (a different routeKey, which - via variantIdx - already captures
// express/local variants distinctly) advances the pattern.
function patternKeyFor(parentPatternKey, edge) {
  if (edge.kind !== 'ride') return parentPatternKey;
  return `${parentPatternKey}>R:${edge.route}`;
}

// Walks a label's direct parent-label chain (no map lookups needed - each
// label already holds a live reference to the label it was built from) into
// the same {startId, endId, legs} shape the rest of the codebase expects.
function reconstructFromLabel(label) {
  const hops = [];
  let cur = label;
  while (cur.parent) {
    hops.push({ ...cur.edge, to: cur.stopId });
    cur = cur.parent;
  }
  hops.reverse();
  return { startId: cur.stopId, endId: label.stopId, legs: hops };
}

// Inserts/updates a candidate label at a stop, deduped by patternKey (same
// pattern reached twice - keep whichever arrives earlier) and capped to the
// TOP_K_PATTERNS best-arriving *distinct* patterns. Returns whether the
// candidate actually made it into the kept set, so callers know whether to
// mark this stop for further exploration this round.
function upsertLabel(map, stopId, candidate) {
  const existing = map.get(stopId) || [];
  const dupIdx = existing.findIndex((l) => l.patternKey === candidate.patternKey);
  if (dupIdx !== -1 && candidate.arrival >= existing[dupIdx].arrival) return false;

  let next = dupIdx !== -1
    ? existing.map((l, i) => (i === dupIdx ? candidate : l))
    : [...existing, candidate];
  next.sort((a, b) => a.arrival - b.arrival);
  if (next.length > TOP_K_PATTERNS) next = next.slice(0, TOP_K_PATTERNS);

  map.set(stopId, next);
  return next.includes(candidate);
}

/**
 * Round-based multi-transfer RAPTOR over a global (cross-city) route index.
 * Fully synchronous — the frequency-based cost function is an in-memory
 * lookup, so no round involves network I/O.
 *
 * @param {Object} opts
 * @param {ReturnType<typeof buildGlobalRouteIndex>} opts.globalIndex
 * @param {Object.<string, Array<[string, number]>>} opts.transfers - global transfers.min.json
 * @param {Object.<string, Object.<string, number>>} opts.frequencyIndex - global frequency.min.json
 * @param {string} [opts.startId] - global stop id (single-origin search)
 * @param {string} [opts.endId] - global stop id (single-destination search)
 * @param {string[]} [opts.startIds] - global stop ids to search from simultaneously
 *   (e.g. a location's nearby-stop cluster) - takes precedence over `startId` if given
 * @param {string[]} [opts.endIds] - global stop ids that all count as "arrived" -
 *   takes precedence over `endId` if given
 * @param {Date} [opts.departureTime]
 * @param {number} [opts.maxRounds]
 * @returns {{itineraries: Array<{startId, endId, legs}>}}
 */
export function computeRaptorRoute({
  globalIndex,
  transfers,
  clusters = {},
  frequencyIndex,
  startId,
  endId,
  startIds,
  endIds,
  departureTime = new Date(),
  maxRounds = DEFAULT_MAX_ROUNDS,
}) {
  const { stopRoutes, routeStopSequence, routeStopIndex, stopMeta } = globalIndex;
  const origins = (startIds?.length ? startIds : [startId]).filter((id) => stopMeta.has(id));
  const destinations = new Set((endIds?.length ? endIds : [endId]).filter((id) => stopMeta.has(id)));
  if (!origins.length || !destinations.size) {
    return { itineraries: [] };
  }

  const routeDistanceCache = new Map(); // globalRouteKey -> cumulative distance array
  const startMinutes = Math.floor(departureTime.getTime() / 60000);

  // Each stop maps to up to TOP_K_PATTERNS labels - {stopId, arrival,
  // patternKey, edge, parent}, where `parent` is a direct reference to the
  // label it was extended from (or null at the start), so reconstruction
  // never needs a separate lookup map and is immune to a label being pruned
  // from some *other* stop's top-K list later on. Seeding every origin at
  // time 0 (rather than searching each separately and merging) lets RAPTOR's
  // own round structure naturally find the fastest one — a location with
  // several nearby stops is just a search with several starting points.
  let prevLabels = new Map(
    origins.map((id) => [id, [{ stopId: id, arrival: startMinutes, patternKey: id, edge: null, parent: null }]]),
  );
  let markedStops = new Set(origins);

  let fewestTransfersItinerary = null;

  for (let round = 1; round <= maxRounds && markedStops.size; round++) {
    const thisRoundLabels = new Map(prevLabels);
    const newlyMarked = new Set();
    // Labels newly added/improved by *this round's ride scan* specifically -
    // as opposed to `thisRoundLabels.get(stopId)`, which also contains any
    // older labels already sitting at that stop (e.g. a walk-derived label
    // from a previous round). Footpath relaxation below must only extend
    // these, or an already-walked-to stop that later happens to *also* pick
    // up an unrelated new ride this round would get its old, already-used
    // walk label walked *again* - silently chaining redundant walk hops
    // onto what should be a single transfer.
    const newRideLabels = []; // {stopId, label}

    // Gather the earliest marked boarding index per candidate route.
    const routesToScan = new Map(); // globalRouteKey -> boardIdx
    for (const stopId of markedStops) {
      for (const routeKey of stopRoutes.get(stopId) || []) {
        const idx = routeStopIndex.get(routeKey)?.get(stopId);
        if (idx === undefined) continue;
        if (!routesToScan.has(routeKey) || idx < routesToScan.get(routeKey)) {
          routesToScan.set(routeKey, idx);
        }
      }
    }

    for (const [routeKey, boardIdx] of routesToScan) {
      const seq = routeStopSequence.get(routeKey);
      const parsed = parseGlobalRouteKey(routeKey);
      if (!parsed) continue;

      if (!routeDistanceCache.has(routeKey)) {
        routeDistanceCache.set(routeKey, cumulativeDistances(seq, stopMeta));
      }
      const cumDist = routeDistanceCache.get(routeKey);
      const arrivalIfRiding = (b, i) =>
        b.time + Math.round(((cumDist[i] - cumDist[b.boardIdx]) / AVG_TRANSIT_SPEED_MPS) / 60);

      // Up to TOP_K_PATTERNS concurrently-ridden boarding states for this
      // route scan - one per distinct incoming pattern, instead of RAPTOR's
      // usual single `boarded` state, so a genuinely different way of
      // reaching this route can ride alongside the fastest one rather than
      // being overwritten by it.
      let boarded = []; // {stopId, boardIdx, time, patternKey, parentLabel}

      for (let i = boardIdx; i < seq.length; i++) {
        const stopId = seq[i];

        for (const prevLabel of prevLabels.get(stopId) || []) {
          const newBoardTime = estimateBoardingTime(
            stopId,
            parsed.service,
            prevLabel.arrival,
            frequencyIndex,
          );
          if (newBoardTime === null) continue;

          const candidate = { stopId, boardIdx: i, time: newBoardTime, patternKey: prevLabel.patternKey, parentLabel: prevLabel };
          const dupIdx = boarded.findIndex((b) => b.patternKey === candidate.patternKey);
          if (dupIdx !== -1) {
            if (candidate.time < boarded[dupIdx].time) boarded[dupIdx] = candidate;
          } else {
            boarded.push(candidate);
          }
        }

        // Bound this scan's cost: keep only the best-projected-arrival
        // TOP_K_PATTERNS boarding states from here on.
        if (boarded.length > TOP_K_PATTERNS) {
          boarded.sort((a, b) => arrivalIfRiding(a, i) - arrivalIfRiding(b, i));
          boarded = boarded.slice(0, TOP_K_PATTERNS);
        }

        for (const b of boarded) {
          if (i <= b.boardIdx) continue;
          const arrival = arrivalIfRiding(b, i);
          const edge = {
            fromStop: b.stopId,
            kind: 'ride',
            route: routeKey,
            service: parsed.service,
            // Same service number can run multiple directions through a stop
            // (e.g. a route's outbound/inbound branches) with entirely
            // different trip times — schedule.json disambiguates per-stop
            // entries by final destination, so this has to travel with the
            // leg for refineWithSchedule to match the correct direction's
            // trips instead of merging both directions' times together.
            destination: parsed.destination,
            boardTime: b.time,
            alightTime: arrival,
          };
          const label = {
            stopId,
            arrival,
            patternKey: patternKeyFor(b.patternKey, edge),
            edge,
            parent: b.parentLabel,
          };
          if (upsertLabel(thisRoundLabels, stopId, label)) {
            newlyMarked.add(stopId);
            newRideLabels.push({ stopId, label });
          }
        }
      }
    }

    // Footpath transfer relaxation - strictly from labels this round's ride
    // scan just added, never from a stop's pre-existing (e.g. walk-derived)
    // labels (see newRideLabels above). Two distinct edge sets, both from the
    // same Voronoi computation (see transfers.py): `clusters` are same-place
    // stops (different stop ids at the same physical station/junction) and
    // `transfers` are genuine walks to a different, nearby place. Both cost
    // real (if often small) walking time, so they're relaxed identically.
    for (const { stopId, label } of newRideLabels) {
      const footpaths = [...(clusters[stopId] || []), ...(transfers[stopId] || [])];
      for (const [neighborId, distM] of footpaths) {
        const walkMinutes = Math.ceil(distM / WALK_SPEED_MPS / 60);
        const edge = { fromStop: stopId, kind: 'walk', distanceMeters: distM, alightTime: label.arrival + walkMinutes };
        const walkLabel = {
          stopId: neighborId,
          arrival: label.arrival + walkMinutes,
          patternKey: patternKeyFor(label.patternKey, edge),
          edge,
          parent: label,
        };
        if (upsertLabel(thisRoundLabels, neighborId, walkLabel)) newlyMarked.add(neighborId);
      }
    }

    if (!fewestTransfersItinerary) {
      let best = null;
      for (const destId of destinations) {
        const endLabels = thisRoundLabels.get(destId);
        if (!endLabels?.length) continue;
        const candidate = endLabels.reduce((a, b) => (a.arrival <= b.arrival ? a : b));
        if (!best || candidate.arrival < best.arrival) best = candidate;
      }
      if (best) fewestTransfersItinerary = reconstructFromLabel(best);
    }

    prevLabels = thisRoundLabels;
    markedStops = newlyMarked;
  }

  // Every destination candidate's labels pooled together — a location with
  // several nearby stops is "arrived" once any one of them is reached.
  const endLabels = [];
  for (const destId of destinations) {
    const labels = prevLabels.get(destId);
    if (labels?.length) endLabels.push(...labels);
  }
  if (!endLabels.length) return { itineraries: [] };

  // Every distinct pattern the search kept for the destination, best arrival
  // first - this is what surfaces a genuinely different route (e.g. via a
  // different railway station) instead of just the single fastest option.
  const itineraries = endLabels
    .slice()
    .sort((a, b) => a.arrival - b.arrival)
    .map(reconstructFromLabel);

  // Also keep the fewest-transfers itinerary, if it isn't already equivalent
  // (by leg count) to one of the patterns already surfaced above.
  if (
    fewestTransfersItinerary &&
    !itineraries.some((it) => it.legs.length === fewestTransfersItinerary.legs.length)
  ) {
    itineraries.push(fewestTransfersItinerary);
  }

  return { itineraries };
}

function defaultFetchSchedule(city, stopNumber) {
  return fetchCache(
    `${SCHEDULE_BASE_URL}/${city}/schedule/${stopNumber}.json`,
    SCHEDULE_CACHE_MINUTES,
  );
}

// How many "Alternatively, take X at HH:MM" suggestions to show per leg.
const MAX_LEG_ALTERNATES = 3;

/**
 * Every distinct (service, destination) pair whose route covers the exact
 * same board->alight segment as `leg` (fromStop before `leg.to`, in the same
 * route's stop sequence) - including the leg's own service. Pure lookup
 * against the same in-memory route index the search already built; no
 * network I/O. This is deliberately just the same-stop case (not stops
 * within walking distance of fromStop/leg.to) - a cheap, exact notion of
 * "another way to cover this specific part of the journey".
 */
function findLegAlternateRoutes(leg, globalIndex) {
  const { stopRoutes, routeStopIndex } = globalIndex;
  const seen = new Set();
  const candidates = [];
  for (const routeKey of stopRoutes.get(leg.fromStop) || []) {
    const stopIndex = routeStopIndex.get(routeKey);
    if (!stopIndex) continue;
    const boardIdx = stopIndex.get(leg.fromStop);
    const alightIdx = stopIndex.get(leg.to);
    if (boardIdx === undefined || alightIdx === undefined || alightIdx <= boardIdx) continue;

    const parsed = parseGlobalRouteKey(routeKey);
    if (!parsed) continue;
    const key = `${parsed.service}|${parsed.destination}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ service: parsed.service, destination: parsed.destination });
  }
  return candidates;
}

/**
 * Best-effort display enrichment: fetches the real per-day schedule for each
 * itinerary's ride-leg boarding stops (a handful per itinerary, not every
 * stop touched during the search) and attaches a `realBoardTime` ("HH:MM")
 * to legs where a matching scheduled departure is found.
 *
 * Also attaches `leg.alternates` - up to MAX_LEG_ALTERNATES upcoming
 * departures (any service covering the same board->alight segment, excluding
 * the one actually chosen for this leg) around this leg's actual boarding
 * time, for a "Alternatively, take X at HH:MM" hint in the UI. Reuses the
 * same already-fetched schedule.json response as the realBoardTime
 * refinement above - no extra network calls.
 *
 * Mutates `itineraries` in place - including re-sorting it by real final
 * arrival time. `computeRaptorRoute`'s own ordering (fastest by its
 * frequency-based cost estimate) is only a rough proxy, and can be badly
 * wrong for low-frequency services - once real schedules are known here, an
 * itinerary that looked fastest during the search can turn out to need an
 * overnight wait, while a different top-K alternative (same earlier legs,
 * different final service) gets there hours sooner. Since this is the only
 * place real times are known, this is also the only place that can correct
 * the ranking.
 *
 * @param {Array<{legs: Array}>} itineraries
 * @param {ReturnType<typeof buildGlobalRouteIndex>} globalIndex
 * @param {(city:string, stopNumber:string) => Promise<Object>} [fetchSchedule]
 */
export async function refineWithSchedule(itineraries, globalIndex, fetchSchedule = defaultFetchSchedule) {
  const scheduleCache = new Map(); // "city^number" -> Promise<scheduleJson|null>
  const getSchedule = (city, number) => {
    const key = `${city}^${number}`;
    if (!scheduleCache.has(key)) {
      scheduleCache.set(key, fetchSchedule(city, number).catch(() => null));
    }
    return scheduleCache.get(key);
  };

  const rideLegs = itineraries.flatMap((it) => it.legs.filter((l) => l.kind === 'ride'));
  await Promise.all(
    rideLegs.map((leg) => {
      const [city, number] = leg.fromStop.split('^');
      return getSchedule(city, number);
    }),
  );

  // Real per-day trip-time list (sorted minute-of-day) for one ride leg,
  // matched by both service number and destination — the same service
  // number can run opposite directions through a stop (see leg.destination
  // in computeRaptorRoute above), each with its own unrelated set of trip
  // times, so matching on number alone can hand back a time for the wrong
  // direction entirely. Returns null if no real schedule match exists, in
  // which case the leg keeps RAPTOR's own frequency-based estimate.
  const resolveTripMinutes = async (leg) => {
    const [city, number] = leg.fromStop.split('^');
    const scheduleData = await getSchedule(city, number);
    let entries = (scheduleData?.services || []).filter(
      (s) => String(s.no) === String(leg.service) && String(s.destination) === String(leg.destination),
    );
    // Fall back to number-only matching for legs from before `destination`
    // was captured (or routes whose schedule entry omits it) rather than
    // silently dropping the refinement.
    if (!entries.length && leg.destination == null) {
      entries = (scheduleData?.services || []).filter((s) => String(s.no) === String(leg.service));
    }
    if (!entries.length) return null;
    const tripMinutes = entries
      .flatMap((s) => s.trips || [])
      .map(parseTripMinutes)
      .filter((m) => m !== null)
      .sort((a, b) => a - b);
    return tripMinutes.length ? tripMinutes : null;
  };

  function localMidnightEpochMinutes(epochMinutes) {
    const d = new Date(epochMinutes * 60000);
    return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 60000);
  }

  // Latest valid occurrence of one of `tripMinutes` (a real per-day trip-time
  // list) that still lands in [floorAbsolute, deadlineAbsolute] - i.e. the
  // latest trip on this route that both (a) isn't earlier than the earliest
  // this leg could ever board (`floorAbsolute`, so this pass only ever delays,
  // never advances a leg), and (b) still boards in time to make the fixed
  // downstream connection. Returns null if no trip fits that window.
  function latestTripInWindow(tripMinutes, floorAbsolute, deadlineAbsolute) {
    if (deadlineAbsolute < floorAbsolute) return null;
    const dayStart = localMidnightEpochMinutes(deadlineAbsolute);
    let best = null;
    for (let dayOffset = 0; dayOffset >= -1; dayOffset--) {
      for (const m of tripMinutes) {
        const t = dayStart + dayOffset * MINUTES_PER_DAY + m;
        if (t >= floorAbsolute && t <= deadlineAbsolute && (best === null || t > best)) {
          best = t;
        }
      }
    }
    return best;
  }

  for (const itinerary of itineraries) {
    const legs = itinerary.legs;
    const rideIdxs = legs.reduce((acc, l, i) => (l.kind === 'ride' ? [...acc, i] : acc), []);
    if (!rideIdxs.length) continue;

    // RAPTOR's estimated ride/walk durations - fixed regardless of which real
    // trip ends up chosen for a leg (only *when* it boards changes, not how
    // long it takes), so snapshot them before anything gets mutated.
    // `waitEstimate` is RAPTOR's own estimated wait before boarding (relative
    // to the *previous* leg's original arrival) - the fallback for legs with
    // no real schedule match, so it isn't collapsed to zero wait below.
    const rideDuration = new Map(); // legIdx -> minutes
    const walkDuration = new Map(); // legIdx -> minutes
    const waitEstimate = new Map(); // legIdx (ride) -> minutes
    legs.forEach((leg, i) => {
      if (leg.kind === 'ride') {
        rideDuration.set(i, leg.alightTime - leg.boardTime);
        waitEstimate.set(i, i > 0 ? leg.boardTime - legs[i - 1].alightTime : 0);
      } else {
        walkDuration.set(i, Math.ceil(leg.distanceMeters / WALK_SPEED_MPS / 60));
      }
    });

    const tripMinutesByIdx = new Map();
    for (const i of rideIdxs) {
      tripMinutesByIdx.set(i, await resolveTripMinutes(legs[i]));
    }

    // Forward pass: greedily board the earliest catchable real trip at every
    // leg. This is the earliest possible arrival for this fixed sequence of
    // routes (provably optimal - boarding any later trip on an earlier leg
    // can only push every downstream boarding later-or-equal, never earlier),
    // so it's the anchor for "keep the end time the same" below.
    const out = legs.map((leg) => ({ ...leg }));
    let arrival = null; // epoch minutes at the current stop
    out.forEach((leg, i) => {
      if (leg.kind === 'walk') {
        if (arrival != null) leg.alightTime = arrival + walkDuration.get(i);
        arrival = leg.alightTime;
        return;
      }
      const priorArrival = arrival != null ? arrival : leg.boardTime;
      const tripMinutes = tripMinutesByIdx.get(i);
      let board = priorArrival + waitEstimate.get(i);
      if (tripMinutes) {
        const dayMinute = localMinuteOfDay(priorArrival);
        const next = tripMinutes.find((m) => m >= dayMinute) ?? tripMinutes[0];
        let delta = next - dayMinute;
        if (delta < 0) delta += MINUTES_PER_DAY;
        board = priorArrival + delta;
        const boardDayMinute = localMinuteOfDay(board);
        const h = String(Math.floor(boardDayMinute / 60)).padStart(2, '0');
        const m = String(boardDayMinute % 60).padStart(2, '0');
        leg.realBoardTime = `${h}:${m}`;
      }
      leg.boardTime = board;
      leg.alightTime = board + rideDuration.get(i);
      arrival = leg.alightTime;
    });

    // Backward pass: compute, for every ride leg but the last, the latest
    // board time it could theoretically take (`latestAllowed`) and still
    // make the *last* leg's (forward, earliest-possible) board time - the
    // fixed deadline the itinerary's actual end time isn't allowed to move
    // past. This walks backward assuming every later leg also takes its own
    // latest option, so it's optimistic - it doesn't yet know whether an
    // earlier leg can actually *reach* this leg in time for that.
    const lastRideIdx = rideIdxs[rideIdxs.length - 1];
    const latestAllowed = new Map(); // legIdx -> epoch minutes
    let deadline = out[lastRideIdx].boardTime;
    for (let k = rideIdxs.length - 2; k >= 0; k--) {
      const idx = rideIdxs[k];
      const nextIdx = rideIdxs[k + 1];
      const tripMinutes = tripMinutesByIdx.get(idx);

      // How much of `deadline` this leg actually gets to use, after
      // subtracting any walk-transfer time between it and the next ride leg,
      // and its own ride duration (this is the latest *board* time, not arrival).
      let requiredArrivalBy = deadline;
      for (let j = idx + 1; j < nextIdx; j++) {
        if (out[j].kind === 'walk') requiredArrivalBy -= walkDuration.get(j);
      }
      requiredArrivalBy -= rideDuration.get(idx);

      const floor = out[idx].boardTime; // never move earlier than the forward pass
      const latest = tripMinutes ? latestTripInWindow(tripMinutes, floor, requiredArrivalBy) : null;
      const cap = latest !== null ? latest : floor;
      latestAllowed.set(idx, cap);
      deadline = cap;
    }

    // Forward confirmation pass: re-walk the chain using *actual* running
    // arrival times (so it's always feasible, unlike the optimistic backward
    // pass above) and, at each leg but the last, prefer the latest real trip
    // that both (a) is catchable given the real arrival here and (b) still
    // fits under that leg's `latestAllowed` cap - relocating waiting toward
    // the origin instead of a later transfer stop. Falls back to the normal
    // earliest-catchable trip wherever the cap turns out infeasible once
    // actual (rather than optimistic) arrival times are known, so this can
    // only ever degrade gracefully to the plain forward pass, never break it.
    arrival = null;
    out.forEach((leg, i) => {
      if (leg.kind === 'walk') {
        if (arrival != null) leg.alightTime = arrival + walkDuration.get(i);
        arrival = leg.alightTime;
        return;
      }

      const priorArrival = arrival != null ? arrival : leg.boardTime;
      const tripMinutes = tripMinutesByIdx.get(i);
      let board = leg.boardTime; // last leg (or no schedule match): keep as-is

      if (tripMinutes && i !== lastRideIdx) {
        const cap = latestAllowed.get(i);
        const preferred = latestTripInWindow(tripMinutes, priorArrival, cap);
        if (preferred !== null) {
          board = preferred;
        } else {
          const dayMinute = localMinuteOfDay(priorArrival);
          const next = tripMinutes.find((m) => m >= dayMinute) ?? tripMinutes[0];
          let delta = next - dayMinute;
          if (delta < 0) delta += MINUTES_PER_DAY;
          board = priorArrival + delta;
        }
      } else if (i === lastRideIdx) {
        board = Math.max(priorArrival, leg.boardTime);
      }

      if (tripMinutes) {
        const dayMinute = localMinuteOfDay(board);
        const h = String(Math.floor(dayMinute / 60)).padStart(2, '0');
        const m = String(dayMinute % 60).padStart(2, '0');
        leg.realBoardTime = `${h}:${m}`;
      }
      leg.boardTime = board;
      leg.alightTime = board + rideDuration.get(i);
      arrival = leg.alightTime;
    });

    // "Alternatively, take X at HH:MM" - up to MAX_LEG_ALTERNATES upcoming
    // departures (any service covering this exact board->alight segment,
    // excluding the one actually chosen - it's already shown as the main
    // leg) around each ride leg's real boarding time. Purely additive
    // display info - never changes boardTime/alightTime/realBoardTime above.
    if (globalIndex) {
      for (const leg of out) {
        if (leg.kind !== 'ride') continue;

        const candidates = findLegAlternateRoutes(leg, globalIndex);
        if (!candidates.length) continue;

        const [city, number] = leg.fromStop.split('^');
        const scheduleData = await getSchedule(city, number);
        const combined = [];
        for (const cand of candidates) {
          const entries = (scheduleData?.services || []).filter(
            (s) => String(s.no) === String(cand.service) && String(s.destination) === String(cand.destination),
          );
          for (const m of entries.flatMap((s) => s.trips || []).map(parseTripMinutes).filter((m) => m !== null)) {
            combined.push({ service: cand.service, minute: m });
          }
        }
        if (!combined.length) continue;
        combined.sort((a, b) => a.minute - b.minute);

        // Drop the exact (service, minute) that was actually chosen for this
        // leg - it's already shown as the main departure, repeating it here
        // would be redundant. Only the *other* real departures (same service
        // at a different time, or a different service entirely) are useful
        // as alternatives.
        const dayMinute = localMinuteOfDay(leg.boardTime);
        const chosenIdx = combined.findIndex((c) => c.service === leg.service && c.minute === dayMinute);
        if (chosenIdx !== -1) combined.splice(chosenIdx, 1);
        if (!combined.length) continue;

        // Rotate the remaining list so it starts at/after this leg's actual
        // boarding time - i.e. "what else was/is around now", not literally
        // the start of the day.
        const startIdx = combined.findIndex((c) => c.minute >= dayMinute);
        const ordered = startIdx === -1 ? combined : [...combined.slice(startIdx), ...combined.slice(0, startIdx)];

        leg.alternates = ordered.slice(0, MAX_LEG_ALTERNATES).map((c) => ({
          service: c.service,
          time: `${String(Math.floor(c.minute / 60)).padStart(2, '0')}:${String(c.minute % 60).padStart(2, '0')}`,
        }));
      }
    }

    itinerary.legs = out;
  }

  // Re-rank by *real* arrival time now that every itinerary has been refined
  // against actual schedules. computeRaptorRoute's own ordering comes from
  // the search's frequency-based cost estimate, which is a poor proxy for
  // low-frequency (e.g. once-a-day) services - it can rank an itinerary that
  // turns out to require an overnight wait ahead of one that, once real
  // timetables are applied, gets there hours sooner using the exact same
  // earlier legs. Sorting here (rather than during the search) is what
  // actually fixes selection, since only refineWithSchedule knows real times.
  itineraries.sort((a, b) => {
    const endA = a.legs[a.legs.length - 1]?.alightTime ?? Infinity;
    const endB = b.legs[b.legs.length - 1]?.alightTime ?? Infinity;
    return endA - endB;
  });
}