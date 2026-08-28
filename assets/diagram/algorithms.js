import { sortServices } from '../utils/bus';

// ── Stop ID helpers ────────────────────────────────────────────────────────────

export const normalizeStopId = (stopId) => {
  const str = String(stopId);
  return { str, num: parseInt(stopId, 10) };
};

export const matchesStop = (stopId, normalized) =>
  stopId === normalized.num || String(stopId) === normalized.str;

export const findStopIndex = (sequence, stopId, norm) =>
  sequence.findIndex((id) => matchesStop(id, norm));

export const getStopName = (stopId, stopsData) =>
  stopsData[stopId]?.[2] || String(stopId);

// ── Route data helpers ─────────────────────────────────────────────────────────

export const calculateRouteTripCount = (
  routeId,
  servicesData,
  scheduleData,
) => {
  if (scheduleData?.services) {
    const totalTripCount = scheduleData.services
      .filter((s) => s.no === routeId)
      .reduce((sum, s) => sum + (s.trip_count || 0), 0);
    if (totalTripCount > 0) return totalTripCount;
  }
  const routeData = servicesData[routeId];
  if (!routeData) return 0;
  return Object.entries(routeData)
    .filter(([key]) => key !== 'name')
    .reduce((sum, [, sequences]) => sum + sequences.length, 0);
};

export const isDepotStop = (stopId, stopsData) =>
  /depot/i.test(stopsData?.[String(stopId)]?.[2] || '');

export const isDepotTripSequence = (sequence, stopsData) =>
  sequence.length > 0 &&
  (isDepotStop(sequence[0], stopsData) ||
    isDepotStop(sequence[sequence.length - 1], stopsData));

export const findRoutesForStop = (
  stopId,
  servicesData,
  stopsData,
  { includeDepotTrips = false } = {},
) => {
  const norm = normalizeStopId(stopId);
  const routes = [];
  for (const [routeId, routeData] of Object.entries(servicesData)) {
    for (const [destId, sequences] of Object.entries(routeData)) {
      if (destId === 'name') continue;
      const stopSequence = sequences.find(
        (seq) =>
          (seq.includes(norm.num) || seq.includes(norm.str)) &&
          (includeDepotTrips || !isDepotTripSequence(seq, stopsData)),
      );
      if (stopSequence) {
        routes.push({
          routeId,
          routeName: routeData.name,
          destinationStopId: destId,
          stopSequence,
        });
        break;
      }
    }
  }
  return routes;
};

export const getAllStopsFromRoutes = (routes, currentStopId) => {
  const norm = normalizeStopId(currentStopId);
  const stopPositions = new Map();

  routes.forEach((route) => {
    const currentIndex = findStopIndex(route.stopSequence, currentStopId, norm);
    const startIdx = currentIndex === -1 ? 0 : currentIndex;

    route.stopSequence.slice(startIdx).forEach((stopId, idx) => {
      const stopIdStr = String(stopId);
      if (!stopPositions.has(stopIdStr))
        stopPositions.set(stopIdStr, new Set());
      stopPositions.get(stopIdStr).add(idx);
    });
  });

  return Array.from(stopPositions.entries())
    .map(([stopId, positions]) => ({
      stopId,
      avgPosition:
        Array.from(positions).reduce((a, b) => a + b, 0) / positions.size,
    }))
    .sort((a, b) => a.avgPosition - b.avgPosition)
    .map((s) => s.stopId);
};

// ── Major stop selection ───────────────────────────────────────────────────────

export const selectMajorStops = (
  stops,
  rankingData,
  terminalStops,
  currentStopId,
  targetMajorStops,
) => {
  const stopsWithRankings = stops.map((stopId) => ({
    stopId,
    ranking: rankingData[stopId] || 0,
    isTerminal: terminalStops.has(stopId),
  }));

  stopsWithRankings.sort((a, b) => b.ranking - a.ranking);
  const maxRanking = stopsWithRankings[0]?.ranking || 0;
  const significanceThreshold = maxRanking * 0.2;
  const selectedStops = new Set();

  if (currentStopId) selectedStops.add(currentStopId);
  stopsWithRankings.forEach((stop) => {
    if (stop.isTerminal || stop.ranking >= significanceThreshold) {
      selectedStops.add(stop.stopId);
    }
  });

  for (const stop of stopsWithRankings) {
    if (
      selectedStops.size >= targetMajorStops &&
      stop.ranking < maxRanking * 0.5
    )
      break;
    selectedStops.add(stop.stopId);
  }

  const minStops = Math.min(5, stops.length);
  if (selectedStops.size < minStops) {
    for (const stop of stopsWithRankings) {
      if (selectedStops.size >= minStops) break;
      selectedStops.add(stop.stopId);
    }
  }

  return selectedStops;
};

export const isLastMajorStopInRoute = (
  route,
  selectedStopId,
  rankingData,
  targetMajorStops,
) => {
  const norm = normalizeStopId(selectedStopId);
  const currentIndex = findStopIndex(route.stopSequence, selectedStopId, norm);
  if (currentIndex === -1) return false;

  const forwardStops = route.stopSequence.slice(currentIndex + 1);
  if (forwardStops.length === 0) return true;

  const lastStopInRoute = String(
    route.stopSequence[route.stopSequence.length - 1],
  );
  const forwardStopsWithRankings = forwardStops.map((stopId) => ({
    stopId: String(stopId),
    ranking: rankingData[String(stopId)] || 0,
    isTerminal: String(stopId) === lastStopInRoute,
  }));

  forwardStopsWithRankings.sort((a, b) => b.ranking - a.ranking);
  const majorStopsAfter = selectMajorStops(
    forwardStopsWithRankings.map((s) => s.stopId),
    Object.fromEntries(
      forwardStopsWithRankings.map((s) => [s.stopId, s.ranking]),
    ),
    new Set(
      forwardStopsWithRankings.filter((s) => s.isTerminal).map((s) => s.stopId),
    ),
    null,
    targetMajorStops,
  );

  return majorStopsAfter.size === 0;
};

// ── Stop position mapping ──────────────────────────────────────────────────────

// Assigns each stop an equally-spaced position across the route line.
// maxStepPct caps the gap between adjacent stops (as a percentage of the
// diagram width) so stops never appear too far apart when there are few of them.
// Stops are ordered by their index in orderedStops; all clusters share the same
// x-position for each stop, keeping shared stops vertically aligned.
export const createStopPositionMap = (
  routes,
  orderedStops,
  currentStopId,
  _stopsData,
  maxStepPct = 100,
) => {
  const stopPositionMap = {};
  const nonCurrentStops = orderedStops.filter((id) => id !== currentStopId);
  const n = nonCurrentStops.length;
  if (n === 0) return stopPositionMap;

  // Equal step, capped at maxStepPct so stops don't spread across the full width
  // when there are only a handful of them.
  const step = n === 1 ? 0 : Math.min(100 / (n - 1), maxStepPct);

  // Pre-build forward stop sets per route for isCommon detection
  const forwardStopSets = routes.map((route) => {
    const norm = normalizeStopId(currentStopId);
    const curIdx = route.stopSequence.findIndex((id) => matchesStop(id, norm));
    const forward =
      curIdx >= 0 ? route.stopSequence.slice(curIdx) : route.stopSequence;
    return new Set(forward.map(String));
  });

  nonCurrentStops.forEach((stopId, idx) => {
    const position = n === 1 ? 0 : idx * step;
    const sidStr = String(stopId);
    const routeCount = forwardStopSets.filter((s) => s.has(sidStr)).length;
    stopPositionMap[stopId] = { position, isCommon: routeCount > 1 };
  });

  return stopPositionMap;
};

// ── Route grouping by common forward stops ───────────────────────────────────

// The stops a route still calls at from the current stop onwards, limited to
// the stops the diagram displays.
export const forwardStopsForRoute = (route, currentStopId, orderedSet) => {
  const norm = normalizeStopId(currentStopId);
  const curIdx = findStopIndex(route.stopSequence, currentStopId, norm);
  const startIdx = curIdx === -1 ? 0 : curIdx;
  return route.stopSequence
    .slice(startIdx)
    .map(String)
    .filter((s) => orderedSet.has(s));
};

// Groups routes that share identical forward major-stop sequences into a single
// "route group".  Each group is rendered as one horizontal line in the diagram.
// Returns an array of { key, routes, forwardStops } sorted by size (largest first).
export const groupRoutesByForwardStops = (
  routes,
  currentStopId,
  orderedStops,
) => {
  const orderedSet = new Set(orderedStops);
  const routeForwardStops = routes.map((route) =>
    forwardStopsForRoute(route, currentStopId, orderedSet),
  );

  const groupMap = new Map();
  routes.forEach((route, i) => {
    const key = routeForwardStops[i].join(',');
    if (!groupMap.has(key)) {
      groupMap.set(key, { routes: [], forwardStops: routeForwardStops[i] });
    }
    groupMap.get(key).routes.push(route);
  });

  const groups = Array.from(groupMap.values()).sort(
    (a, b) => b.routes.length - a.routes.length,
  );
  groups.forEach((g) => {
    g.key = g.routes[0].routeId;
  });
  return groups;
};

// Reassigns routes to the tracks the editor dropped them on. A track is
// identified by the route that led it in the automatic grouping, so the key
// survives every move; an empty target means "give this route its own track".
// The moved routes make their new track serve the union of their stops.
export const applyTrackOverrides = (
  routeGroups,
  trackOverrides,
  currentStopId,
  orderedStops,
) => {
  if (!trackOverrides || trackOverrides.size === 0) return routeGroups;

  const groups = routeGroups.map((g) => ({
    key: g.key,
    routes: [...g.routes],
  }));
  const solo = [];

  for (const [routeId, targetKey] of trackOverrides) {
    let moved = null;
    for (const group of groups) {
      const idx = group.routes.findIndex((r) => r.routeId === routeId);
      if (idx === -1) continue;
      [moved] = group.routes.splice(idx, 1);
      break;
    }
    if (!moved) continue;
    const target = targetKey && groups.find((g) => g.key === targetKey);
    if (target) target.routes.push(moved);
    else solo.push({ key: routeId, routes: [moved] });
  }

  const orderedSet = new Set(orderedStops);
  return [...groups, ...solo]
    .filter((g) => g.routes.length > 0)
    .map((g) => {
      const stops = new Set();
      g.routes.forEach((route) => {
        forwardStopsForRoute(route, currentStopId, orderedSet).forEach((s) =>
          stops.add(s),
        );
      });
      return {
        key: g.key,
        routes: g.routes,
        forwardStops: orderedStops.filter((s) => stops.has(s)),
      };
    });
};

export const orderGroupsBySimilarity = (routeGroups) => {
  if (routeGroups.length <= 2) return routeGroups;

  const stopSets = routeGroups.map((g) => new Set(g.forwardStops));
  const similarity = (a, b) => {
    let shared = 0;
    for (const s of a) if (b.has(s)) shared++;
    return shared;
  };

  const used = new Set();
  const ordered = [];
  const idxOf = [];

  let best = 0;
  for (let i = 1; i < routeGroups.length; i++) {
    if (routeGroups[i].routes.length > routeGroups[best].routes.length)
      best = i;
  }
  ordered.push(routeGroups[best]);
  idxOf.push(best);
  used.add(best);

  while (ordered.length < routeGroups.length) {
    const lastSet = stopSets[idxOf[idxOf.length - 1]];
    let nextIdx = -1;
    let maxSim = -1;
    for (let i = 0; i < routeGroups.length; i++) {
      if (used.has(i)) continue;
      const sim = similarity(lastSet, stopSets[i]);
      if (
        sim > maxSim ||
        (sim === maxSim &&
          routeGroups[i].routes.length > routeGroups[nextIdx].routes.length)
      ) {
        maxSim = sim;
        nextIdx = i;
      }
    }
    ordered.push(routeGroups[nextIdx]);
    idxOf.push(nextIdx);
    used.add(nextIdx);
  }

  return ordered;
};

// ── Route ordering helpers ──────────────────────────────────────────────────────

export const getSequence = (route) =>
  route.seqForGrouping || route.stopSequence;

export const buildForwardGroupStats = (routes, stopsData) => {
  const stats = [];
  routes.forEach((r) => {
    const seq = getSequence(r).map(String);
    for (let i = 1; i < seq.length; i++) {
      if (!stats[i]) stats[i] = new Map();
      const name = getStopName(seq[i], stopsData);
      stats[i].set(name, (stats[i].get(name) || 0) + 1);
    }
  });
  return stats;
};

export const createGroupSizeComparator = (stats, stopsData) => {
  return function compare(a, b) {
    const sa = getSequence(a).map(String);
    const sb = getSequence(b).map(String);
    for (let i = 1, max = Math.max(sa.length, sb.length); i < max; i++) {
      const na =
        sa[i] === undefined ? undefined : getStopName(sa[i], stopsData);
      const nb =
        sb[i] === undefined ? undefined : getStopName(sb[i], stopsData);
      if (na === nb) continue;
      const map = stats[i] || new Map();
      const ca = na === undefined ? -1 : map.get(na) || 0;
      const cb = nb === undefined ? -1 : map.get(nb) || 0;
      if (ca !== cb) return cb - ca;
      if (na === undefined) return 1;
      if (nb === undefined) return -1;
      const cmp = String(na).localeCompare(String(nb));
      if (cmp !== 0) return cmp;
    }
    return sortServices(a.routeId, b.routeId);
  };
};
