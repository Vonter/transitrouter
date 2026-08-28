import fetchCache from '../utils/fetchCache';
import { fetchPois } from '../utils/parsePoisCsv';
import {
  normalizeStopId,
  findStopIndex,
  findRoutesForStop,
  getAllStopsFromRoutes,
  calculateRouteTripCount,
  isLastMajorStopInRoute,
  buildForwardGroupStats,
  createGroupSizeComparator,
  groupRoutesByForwardStops,
  getStopName,
} from './algorithms';

const SCHEDULE_BASE_URL = 'https://data.transitrouter.vonter.in';

const loadOptionalJson = (url) =>
  fetch(url)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

export const loadCityData = (city) => {
  const dataPath = `/data/${city}`;
  return Promise.all([
    fetchCache(`${dataPath}/services.min.json`, 24 * 60),
    fetchCache(`${dataPath}/stops.min.json`, 24 * 60),
    fetchCache(`${dataPath}/ranking.min.json`, 24 * 60).catch(() => ({})),
    fetchPois(city),
    loadOptionalJson(`${dataPath}/rail.json`),
  ]).then(([servicesData, stopsData, rankingData, poisData, railData]) => ({
    servicesData,
    stopsData,
    rankingData,
    poisData,
    railData,
  }));
};

export const loadScheduleData = (city, stopId) =>
  fetchCache(
    `${SCHEDULE_BASE_URL}/${city}/schedule/${stopId}.json`,
    60 * 60,
  ).catch(() => null);

export const computeStopsForRoutes = (
  routes,
  stopId,
  rankingData,
  targetMajorStops,
) => {
  return selectStopsForDiagram(
    routes,
    stopId,
    rankingData,
    targetMajorStops,
  ).orderedStops;
};

function selectStopsForDiagram(
  routes,
  stopId,
  rankingData,
  targetMajorStops,
) {
  const norm = normalizeStopId(stopId);
  const allMajorStops = new Set([stopId]);
  const protectedStops = new Set([stopId]);
  const terminalStops = new Set();
  const stopRouteCount = new Map();

  routes.forEach((route) => {
    const currentIndex = findStopIndex(route.stopSequence, stopId, norm);
    const startIdx = currentIndex === -1 ? 0 : currentIndex;

    const forwardStops = route.stopSequence.slice(startIdx).map(String);
    forwardStops.forEach((s) =>
      stopRouteCount.set(s, (stopRouteCount.get(s) || 0) + 1),
    );

    const forwardStopsRanked = forwardStops
      .map((s) => ({ stopId: s, ranking: rankingData[s] || 0 }))
      .sort((a, b) => b.ranking - a.ranking);

    // The first calling point after the selected stop must be the first marker
    // on that route. Ranking alone used to skip it and made labels appear to be
    // attached to the following bar.
    if (forwardStops.length > 1) {
      allMajorStops.add(forwardStops[1]);
      protectedStops.add(forwardStops[1]);
    }
    if (forwardStops.length > 0) {
      const terminal = forwardStops[forwardStops.length - 1];
      allMajorStops.add(terminal);
      protectedStops.add(terminal);
      terminalStops.add(terminal);
    }
    forwardStopsRanked
      .slice(0, targetMajorStops)
      .forEach((s) => allMajorStops.add(s.stopId));
  });

  const allStops = getAllStopsFromRoutes(routes, stopId);

  // Keep a global, coverage-aware cap. This retains branch and terminal stops
  // while avoiding the old per-route union growing without bound. The larger
  // budget also follows the amount of detail in the printed diagram more
  // closely than the previous routes+stops cap.
  const maxMajorStops =
    1 + terminalStops.size + targetMajorStops + routes.length;
  if (allMajorStops.size > maxMajorStops) {
    const candidates = [...allMajorStops]
      .filter((s) => !protectedStops.has(s))
      .sort((a, b) => {
        const coverage =
          (stopRouteCount.get(a) || 0) - (stopRouteCount.get(b) || 0);
        if (coverage !== 0) return coverage;
        return (rankingData[a] || 0) - (rankingData[b] || 0);
      });
    while (allMajorStops.size > maxMajorStops && candidates.length) {
      allMajorStops.delete(candidates.shift());
    }
  }

  const orderedStops = allStops.filter((s) => allMajorStops.has(s));
  const stopRouteCounts = {};
  orderedStops.forEach((s) => {
    stopRouteCounts[s] = stopRouteCount.get(s) || 0;
  });
  return { orderedStops, stopRouteCounts };
}

export const computeDiagramData = (
  stopId,
  servicesData,
  stopsData,
  rankingData,
  scheduleData,
  { targetMajorStops, countMajorRoutes, includeDepotTrips = false },
) => {
  const routesFound = findRoutesForStop(stopId, servicesData, stopsData, {
    includeDepotTrips,
  });
  if (routesFound.length === 0) return null;

  const routesWithTripCounts = routesFound.map((route) => ({
    ...route,
    tripCount: calculateRouteTripCount(
      route.routeId,
      servicesData,
      scheduleData,
    ),
    destinationRanking: rankingData[route.destinationStopId] || 0,
  }));

  routesWithTripCounts.sort((a, b) => {
    if (a.tripCount !== b.tripCount) return b.tripCount - a.tripCount;
    return b.destinationRanking - a.destinationRanking;
  });

  const norm = normalizeStopId(stopId);

  const filteredRoutes = routesWithTripCounts.filter(
    (route) =>
      !isLastMajorStopInRoute(route, stopId, rankingData, targetMajorStops),
  );

  const topRoutes = filteredRoutes.slice(0, countMajorRoutes);

  topRoutes.forEach((route) => {
    const currentIndex = findStopIndex(route.stopSequence, stopId, norm);
    route.seqForGrouping =
      currentIndex === -1
        ? route.stopSequence.map(String)
        : route.stopSequence.slice(currentIndex).map(String);
  });

  const stats = buildForwardGroupStats(topRoutes, stopsData);
  const groupComparator = createGroupSizeComparator(stats, stopsData);
  const routes = [...topRoutes].sort(groupComparator);

  const { orderedStops, stopRouteCounts } = selectStopsForDiagram(
    routes,
    stopId,
    rankingData,
    targetMajorStops,
  );

  const routeGroups = groupRoutesByForwardStops(routes, stopId, orderedStops);

  return { routes, orderedStops, stopRouteCounts, routeGroups };
};
