import fetchCache from '../utils/fetchCache';
import {
  normalizeStopId,
  findStopIndex,
  findRoutesForStop,
  getAllStopsFromRoutes,
  calculateRouteTripCount,
  isLastMajorStopInRoute,
  buildForwardGroupStats,
  createGroupSizeComparator,
  getStopName,
} from './algorithms';

const SCHEDULE_BASE_URL = 'https://data.transitrouter.vonter.in';

export const loadCityData = (city) => {
  const dataPath = `/data/${city}`;
  return Promise.all([
    fetchCache(`${dataPath}/services.min.json`, 24 * 60),
    fetchCache(`${dataPath}/stops.min.json`, 24 * 60),
    fetchCache(`${dataPath}/ranking.min.json`, 24 * 60).catch(() => ({})),
  ]).then(([servicesData, stopsData, rankingData]) => ({
    servicesData,
    stopsData,
    rankingData,
  }));
};

export const loadScheduleData = (city, stopId) =>
  fetchCache(
    `${SCHEDULE_BASE_URL}/${city}/schedule/${stopId}.json`,
    60 * 60,
  ).catch(() => null);

export const computeDiagramData = (
  stopId,
  servicesData,
  stopsData,
  rankingData,
  scheduleData,
  { targetMajorStops, countMajorRoutes },
) => {
  const routesFound = findRoutesForStop(stopId, servicesData);
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

  const allMajorStops = new Set([stopId]);
  const stopRouteCount = new Map();

  routes.forEach((route) => {
    const currentIndex = findStopIndex(route.stopSequence, stopId, norm);
    if (currentIndex === -1) return;

    const forwardStops = route.stopSequence.slice(currentIndex).map(String);
    forwardStops.forEach((sStr) => {
      stopRouteCount.set(sStr, (stopRouteCount.get(sStr) || 0) + 1);
    });

    const forwardStopsRanked = forwardStops
      .map((s) => ({ stopId: s, ranking: rankingData[s] || 0 }))
      .sort((a, b) => b.ranking - a.ranking);

    if (forwardStops.length > 0)
      allMajorStops.add(forwardStops[forwardStops.length - 1]);
    forwardStopsRanked
      .slice(0, targetMajorStops)
      .forEach((s) => allMajorStops.add(s.stopId));
  });

  const allStops = getAllStopsFromRoutes(routes, stopId);
  const orderedStops = allStops.filter((s) => allMajorStops.has(s));

  const stopRouteCounts = {};
  orderedStops.forEach((s) => {
    stopRouteCounts[s] = stopRouteCount.get(s) || 0;
  });

  return { routes, orderedStops, stopRouteCounts };
};
