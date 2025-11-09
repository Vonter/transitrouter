import './i18n';
import { getCurrentCity } from './config';
import { h, render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import * as d3 from 'd3';
import fetchCache from './utils/fetchCache';
import { sortServices } from './utils/bus';
import getRoute from './utils/getRoute';

// Constants
const DEFAULT_TARGET_MAJOR_STOPS = 5;
const DEFAULT_COUNT_MAJOR_ROUTES = 8;
const MIN_SPACING_PERCENT = 15;
const MIN_SPACING_INDEPENDENT = 5;
const MIN_POSITION_DIFF = 2;
const LEFT_PADDING = 5;
const RIGHT_PADDING = 10;
const ROUTE_LABEL_WIDTH = 80;
const ROUTE_HEIGHT = 96;
const ROUTE_START_Y = 100;
const MARKER_RADIUS = 8;
const LABEL_ROTATION = -20;
const BASE_VERTICAL_OFFSET = 18;
const VERTICAL_SCALE_FACTOR = 1.6;
const MAX_DRIFT_PERCENT = 15;

// Helper functions
const normalizeStopId = (stopId) => {
  const str = String(stopId);
  return { str, num: parseInt(stopId, 10) };
};

const matchesStop = (stopId, normalized) =>
  stopId === normalized.num || String(stopId) === normalized.str;

const findStopIndex = (sequence, stopId, norm) =>
  sequence.findIndex((id) => matchesStop(id, norm));

const getStopName = (stopId, stopsData) => stopsData[stopId]?.[2] || String(stopId);

const calculateRouteTripCount = (routeId, servicesData, scheduleData) => {
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

const findRoutesForStop = (stopId, servicesData) => {
  const norm = normalizeStopId(stopId);
  const routes = [];
  for (const [routeId, routeData] of Object.entries(servicesData)) {
    for (const [destId, sequences] of Object.entries(routeData)) {
      if (destId === 'name') continue;
      if (sequences.some((seq) => seq.includes(norm.num) || seq.includes(norm.str))) {
        routes.push({
          routeId,
          routeName: routeData.name,
          destinationStopId: destId,
          stopSequence: sequences[0],
        });
        break;
      }
    }
  }
  return routes;
};

const getAllStopsFromRoutes = (routes, currentStopId) => {
  const norm = normalizeStopId(currentStopId);
  const stopPositions = new Map();

  routes.forEach((route) => {
    const currentIndex = findStopIndex(route.stopSequence, currentStopId, norm);
    if (currentIndex === -1) return;

    route.stopSequence.slice(currentIndex).forEach((stopId, idx) => {
      const stopIdStr = String(stopId);
      if (!stopPositions.has(stopIdStr)) stopPositions.set(stopIdStr, new Set());
      stopPositions.get(stopIdStr).add(idx);
    });
  });

  return Array.from(stopPositions.entries())
    .map(([stopId, positions]) => ({
      stopId,
      avgPosition: Array.from(positions).reduce((a, b) => a + b, 0) / positions.size,
    }))
    .sort((a, b) => a.avgPosition - b.avgPosition)
    .map((s) => s.stopId);
};

const selectMajorStops = (stops, rankingData, terminalStops, currentStopId, targetMajorStops) => {
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
    if (stop.isTerminal || stop.ranking >= significanceThreshold) selectedStops.add(stop.stopId);
  });

  for (const stop of stopsWithRankings) {
    if (selectedStops.size >= targetMajorStops && stop.ranking < maxRanking * 0.5) break;
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

const isLastMajorStopInRoute = (route, selectedStopId, rankingData, targetMajorStops) => {
  const norm = normalizeStopId(selectedStopId);
  const currentIndex = findStopIndex(route.stopSequence, selectedStopId, norm);
  if (currentIndex === -1) return false;

  const forwardStops = route.stopSequence.slice(currentIndex + 1);
  if (forwardStops.length === 0) return true;

  const lastStopInRoute = String(route.stopSequence[route.stopSequence.length - 1]);
  const forwardStopsWithRankings = forwardStops.map((stopId) => ({
    stopId: String(stopId),
    ranking: rankingData[String(stopId)] || 0,
    isTerminal: String(stopId) === lastStopInRoute,
  }));

  forwardStopsWithRankings.sort((a, b) => b.ranking - a.ranking);
  const maxRanking = forwardStopsWithRankings[0]?.ranking || 0;
  const majorStopsAfter = selectMajorStops(
    forwardStopsWithRankings.map((s) => s.stopId),
    Object.fromEntries(forwardStopsWithRankings.map((s) => [s.stopId, s.ranking])),
    new Set(forwardStopsWithRankings.filter((s) => s.isTerminal).map((s) => s.stopId)),
    null,
    targetMajorStops,
  );

  return majorStopsAfter.size === 0;
};

const filterMajorStops = (allStops, currentStopId, rankingData, routes, targetMajorStops) => {
  const terminalStops = new Set();
  routes.forEach((route) => {
    if (route.stopSequence.length > 0) {
      terminalStops.add(String(route.stopSequence[0]));
      terminalStops.add(String(route.stopSequence[route.stopSequence.length - 1]));
    }
  });

  const selectedStops = selectMajorStops(
    allStops,
    rankingData,
    terminalStops,
    currentStopId,
    targetMajorStops,
  );

  return allStops.filter((stopId) => selectedStops.has(stopId));
};

const findAvailablePosition = (desiredPos, usedPositions) => {
  let pos = desiredPos;
  for (const existingPos of usedPositions) {
    if (Math.abs(pos - existingPos) < MIN_POSITION_DIFF) {
      pos = existingPos + MIN_POSITION_DIFF;
      if (pos > 100 - RIGHT_PADDING) {
        pos = 100 - RIGHT_PADDING;
        break;
      }
    }
  }
  return pos;
};

const createStopPositionMap = (routes, orderedStops, currentStopId, stopsData) => {
  const stopPositionMap = {};
  const stopIdToName = {};
  const nameToRoutes = {};

  // Build name mappings
  orderedStops.forEach((stopId) => {
    if (stopId === currentStopId) return;
    const name = getStopName(stopId, stopsData);
    stopIdToName[stopId] = name;
    if (!nameToRoutes[name]) nameToRoutes[name] = new Set();
    routes.forEach((route, routeIndex) => {
      const norm = normalizeStopId(stopId);
      if (route.stopSequence.some((id) => matchesStop(id, norm))) {
        nameToRoutes[name].add(routeIndex);
      }
    });
  });

  // Find universal and cross-group stops
  const universalStops = new Set();
  Object.entries(nameToRoutes).forEach(([name, routeSet]) => {
    if (routeSet.size === routes.length) universalStops.add(name);
  });

  // Find independent route groups
  const routeGroups = (() => {
    const groups = routes.map((_, idx) => new Set([idx]));
    Object.entries(nameToRoutes).forEach(([name, routeSet]) => {
      if (routeSet.size < 2 || universalStops.has(name)) return;
      const routeIndices = Array.from(routeSet);
      const groupsToMerge = [];
      groups.forEach((group, groupIdx) => {
        if (group !== null && routeIndices.some((routeIdx) => group.has(routeIdx))) {
          groupsToMerge.push(groupIdx);
        }
      });
      if (groupsToMerge.length > 1) {
        const targetGroup = groups[groupsToMerge[0]];
        for (let i = 1; i < groupsToMerge.length; i++) {
          const groupToMerge = groups[groupsToMerge[i]];
          if (groupToMerge !== null) {
            groupToMerge.forEach((routeIdx) => targetGroup.add(routeIdx));
            groups[groupsToMerge[i]] = null;
          }
        }
      }
    });
    return groups.filter((g) => g !== null);
  })();

  // Identify cross-group stops
  const crossGroupStops = new Set(universalStops);
  Object.entries(nameToRoutes).forEach(([name, routeSet]) => {
    if (routeSet.size < 2 || universalStops.has(name)) return;
    const routeIndices = Array.from(routeSet);
    const involvedGroups = new Set();
    routeIndices.forEach((routeIdx) => {
      routeGroups.forEach((group) => {
        if (group.has(routeIdx)) involvedGroups.add(group);
      });
    });
    if (involvedGroups.size > 1) crossGroupStops.add(name);
  });

  // Position calculation
  const usableWidth = 100 - LEFT_PADDING - RIGHT_PADDING;
  const globalPositionMap = new Map();
  const positionToNames = new Map();
  const crossGroupNameToPosition = {};
  const orderedCrossGroupNames = [];

  orderedStops.forEach((stopId) => {
    if (stopId === currentStopId) return;
    const name = stopIdToName[stopId];
    if (crossGroupStops.has(name) && !orderedCrossGroupNames.includes(name)) {
      orderedCrossGroupNames.push(name);
    }
  });

  // Assign positions to cross-group stops
  if (orderedCrossGroupNames.length > 0) {
    const requiredWidth = orderedCrossGroupNames.length * MIN_SPACING_PERCENT;
    const usedPositions = new Set();
    orderedCrossGroupNames.forEach((name, idx) => {
      const desiredPos =
        requiredWidth <= usableWidth
          ? LEFT_PADDING + idx * MIN_SPACING_PERCENT
          : LEFT_PADDING + (idx / Math.max(orderedCrossGroupNames.length - 1, 1)) * usableWidth;
      const pos = findAvailablePosition(desiredPos, usedPositions);
      crossGroupNameToPosition[name] = pos;
      globalPositionMap.set(name, pos);
      usedPositions.add(pos);
      if (!positionToNames.has(pos)) positionToNames.set(pos, new Set());
      positionToNames.get(pos).add(name);
    });
  }

  // Calculate positions for independent groups
  const groupNameToPosition = new Map();
  const crossGroupPositions = new Set(Array.from(globalPositionMap.values()));
  const lastCrossGroupPosition =
    orderedCrossGroupNames.length > 0
      ? crossGroupNameToPosition[orderedCrossGroupNames[orderedCrossGroupNames.length - 1]] ||
        LEFT_PADDING
      : LEFT_PADDING;
  const independentGroupStartPos = Math.min(
    lastCrossGroupPosition + MIN_SPACING_PERCENT,
    100 - RIGHT_PADDING,
  );
  const positionByRelativeIndex = new Map();

  routeGroups.forEach((group) => {
    const nameToPosition = {};
    const groupCommonNames = [];
    orderedStops.forEach((stopId) => {
      if (stopId === currentStopId) return;
      const name = stopIdToName[stopId];
      const routeSet = nameToRoutes[name];
      if (routeSet && routeSet.size >= 2 && !crossGroupStops.has(name)) {
        const routeIndices = Array.from(routeSet);
        if (routeIndices.every((idx) => group.has(idx)) && !groupCommonNames.includes(name)) {
          groupCommonNames.push(name);
        }
      }
    });

    if (groupCommonNames.length > 0) {
      groupCommonNames.forEach((name, idx) => {
        const desiredPos = positionByRelativeIndex.has(idx)
          ? positionByRelativeIndex.get(idx)
          : (() => {
              const requiredWidth = groupCommonNames.length * MIN_SPACING_PERCENT;
              return requiredWidth <= usableWidth
                ? independentGroupStartPos + idx * MIN_SPACING_PERCENT
                : independentGroupStartPos +
                  (idx / Math.max(groupCommonNames.length - 1, 1)) *
                    (100 - RIGHT_PADDING - independentGroupStartPos);
            })();
        const pos = findAvailablePosition(desiredPos, crossGroupPositions);
        nameToPosition[name] = pos;
        globalPositionMap.set(name, pos);
        positionByRelativeIndex.set(idx, pos);
        if (!positionToNames.has(pos)) positionToNames.set(pos, new Set());
        positionToNames.get(pos).add(name);
      });
    }
    groupNameToPosition.set(group, nameToPosition);
  });

  // Calculate positions for all stops in each route
  routes.forEach((route, routeIndex) => {
    const routeStops = orderedStops.filter((stopId) => {
      if (stopId === currentStopId) return false;
      const norm = normalizeStopId(stopId);
      return route.stopSequence.some((id) => matchesStop(id, norm));
    });

    const routeGroup = routeGroups.find((group) => group.has(routeIndex));
    const groupPositions = routeGroup ? groupNameToPosition.get(routeGroup) : {};

    routeStops.forEach((stopId, stopIndex) => {
      const name = stopIdToName[stopId];
      if (stopPositionMap[stopId]) return;

      let position;
      if (crossGroupNameToPosition[name] !== undefined) {
        position = crossGroupNameToPosition[name];
        stopPositionMap[stopId] = { position, isCommon: true };
        return;
      }

      if (groupPositions[name] !== undefined) {
        position = groupPositions[name];
        stopPositionMap[stopId] = { position, isCommon: true };
        return;
      }

      // Find anchors for non-common stops
      const findAnchor = (dir) => {
        const start = dir === 'back' ? stopIndex - 1 : stopIndex + 1;
        const end = dir === 'back' ? -1 : routeStops.length;
        const step = dir === 'back' ? -1 : 1;
        for (let i = start; i !== end; i += step) {
          const n = stopIdToName[routeStops[i]];
          if (groupPositions[n] !== undefined || crossGroupNameToPosition[n] !== undefined) {
            return i;
          }
        }
        return -1;
      };

      const backIdx = findAnchor('back');
      const fwdIdx = findAnchor('forward');
      const getPosition = (stopId) => {
        const n = stopIdToName[stopId];
        return groupPositions[n] !== undefined ? groupPositions[n] : crossGroupNameToPosition[n];
      };

      let desiredPosition;
      if (backIdx !== -1 && fwdIdx !== -1) {
        const startPos = getPosition(routeStops[backIdx]);
        const endPos = getPosition(routeStops[fwdIdx]);
        const progress = (stopIndex - backIdx) / (fwdIdx - backIdx);
        desiredPosition = startPos + (endPos - startPos) * progress;
      } else if (backIdx !== -1) {
        const basePos = getPosition(routeStops[backIdx]);
        desiredPosition = Math.min(
          basePos + (stopIndex - backIdx) * MIN_SPACING_INDEPENDENT,
          95,
        );
      } else if (fwdIdx !== -1) {
        const basePos = getPosition(routeStops[fwdIdx]);
        desiredPosition = Math.max(
          basePos - (fwdIdx - stopIndex) * MIN_SPACING_INDEPENDENT,
          LEFT_PADDING,
        );
      } else {
        const requiredWidth = routeStops.length * MIN_SPACING_INDEPENDENT;
        desiredPosition =
          requiredWidth <= usableWidth
            ? LEFT_PADDING + stopIndex * MIN_SPACING_INDEPENDENT
            : LEFT_PADDING + (stopIndex / Math.max(routeStops.length - 1, 1)) * usableWidth;
      }

      const allUsedPositions = Array.from(globalPositionMap.values());
      position = findAvailablePosition(desiredPosition, allUsedPositions);
      globalPositionMap.set(name, position);
      if (!positionToNames.has(position)) positionToNames.set(position, new Set());
      positionToNames.get(position).add(name);
      stopPositionMap[stopId] = { position, isCommon: false };
    });
  });

  // Normalize positions
  const allPositions = Object.values(stopPositionMap).map((p) => p.position);
  if (allPositions.length > 0) {
    const minPosition = Math.min(...allPositions);
    if (minPosition > LEFT_PADDING) {
      const shift = LEFT_PADDING - minPosition;
      Object.keys(stopPositionMap).forEach((stopId) => {
        stopPositionMap[stopId].position += shift;
      });
    }

    const maxPosition = Math.max(...allPositions);
    const availableWidth = 100 - RIGHT_PADDING;
    if (maxPosition < availableWidth && maxPosition > LEFT_PADDING) {
      const scaleFactor = (availableWidth - LEFT_PADDING) / (maxPosition - LEFT_PADDING);
      Object.keys(stopPositionMap).forEach((stopId) => {
        const currentPos = stopPositionMap[stopId].position;
        stopPositionMap[stopId].position = LEFT_PADDING + (currentPos - LEFT_PADDING) * scaleFactor;
      });
    }
  }

  return stopPositionMap;
};

const calculateRouteSimilarity = (route1Stops, route2Stops) => {
  const set1 = new Set(route1Stops.map(String));
  const set2 = new Set(route2Stops.map(String));
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return union.size === 0 ? 0 : intersection.size / union.size;
};

const getSequence = (route) => route.seqForGrouping || route.stopSequence;

const clusterRoutesByStops = (routes, minSimilarity = 0.2) => {
  if (routes.length <= 1) return routes.length === 0 ? [] : [[routes[0]]];

  const clusters = [];
  const processed = new Set();

  routes.forEach((route, index) => {
    if (processed.has(index)) return;
    const cluster = [route];
    processed.add(index);

    let changed = true;
    while (changed) {
      changed = false;
      routes.forEach((otherRoute, otherIndex) => {
        if (processed.has(otherIndex)) return;
        for (const clusterRoute of cluster) {
          if (
            calculateRouteSimilarity(getSequence(clusterRoute), getSequence(otherRoute)) >=
            minSimilarity
          ) {
            cluster.push(otherRoute);
            processed.add(otherIndex);
            changed = true;
            break;
          }
        }
      });
    }
    clusters.push(cluster);
  });

  return clusters.sort((a, b) => b.length - a.length);
};

const orderClusterBySimilarity = (cluster) => {
  if (cluster.length <= 2) return [...cluster];
  const seqs = cluster.map((r) => getSequence(r));
  const sim = seqs.map(() => Array(seqs.length).fill(0));

  for (let i = 0; i < seqs.length; i++) {
    for (let j = i + 1; j < seqs.length; j++) {
      sim[i][j] = sim[j][i] = calculateRouteSimilarity(seqs[i], seqs[j]);
    }
  }

  let current = 0;
  let bestTotal = -1;
  for (let i = 0; i < sim.length; i++) {
    const total = sim[i].reduce((a, b) => a + b, 0);
    if (total > bestTotal) {
      bestTotal = total;
      current = i;
    }
  }

  const used = new Set([current]);
  const order = [current];

  while (order.length < seqs.length) {
    let next = -1;
    let best = -1;
    for (let j = 0; j < seqs.length; j++) {
      if (used.has(j)) continue;
      const s = sim[current][j];
      if (s > best || (s === best && sortServices(cluster[j]?.routeId, cluster[next]?.routeId) < 0)) {
        best = s;
        next = j;
      }
    }
    if (next === -1) {
      let fallback = -1;
      let totBest = -1;
      for (let j = 0; j < seqs.length; j++) {
        if (used.has(j)) continue;
        const tot = sim[j].reduce((a, b) => a + b, 0);
        if (tot > totBest) {
          totBest = tot;
          fallback = j;
        }
      }
      next = fallback;
    }
    used.add(next);
    order.push(next);
    current = next;
  }

  return order.map((i) => cluster[i]);
};

const compareRoutesByForwardPrefix = (a, b) => {
  const sa = getSequence(a).map(String);
  const sb = getSequence(b).map(String);
  for (let i = 1, max = Math.max(sa.length, sb.length); i < max; i++) {
    const va = sa[i];
    const vb = sb[i];
    if (va === vb) continue;
    if (va === undefined) return -1;
    if (vb === undefined) return 1;
    const na = Number(va);
    const nb = Number(vb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    const cmp = String(va).localeCompare(String(vb));
    if (cmp !== 0) return cmp;
  }
  return sortServices(a.routeId, b.routeId);
};

const buildForwardGroupStats = (routes, stopsData) => {
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

const createGroupSizeComparator = (stats, stopsData) => {
  return function compare(a, b) {
    const sa = getSequence(a).map(String);
    const sb = getSequence(b).map(String);
    for (let i = 1, max = Math.max(sa.length, sb.length); i < max; i++) {
      const na = sa[i] === undefined ? undefined : getStopName(sa[i], stopsData);
      const nb = sb[i] === undefined ? undefined : getStopName(sb[i], stopsData);
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

function BusDiagram() {
  const { t } = useTranslation();
  const [currentStopId, setCurrentStopId] = useState(null);
  const [currentStopName, setCurrentStopName] = useState(null);
  const [currentCity, setCurrentCity] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [orderedStops, setOrderedStops] = useState([]);
  const [stopsData, setStopsData] = useState({});
  const [rankingData, setRankingData] = useState({});
  const [stopRouteCounts, setStopRouteCounts] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [targetMajorStops, setTargetMajorStops] = useState(DEFAULT_TARGET_MAJOR_STOPS);
  const [countMajorRoutes, setCountMajorRoutes] = useState(DEFAULT_COUNT_MAJOR_ROUTES);
  const [servicesData, setServicesData] = useState(null);
  const [scheduleData, setScheduleData] = useState(null);
  const targetMajorStopsRef = useRef(targetMajorStops);
  const countMajorRoutesRef = useRef(countMajorRoutes);
  const svgContainerRef = useRef(null);
  const diagramContainerRef = useRef(null);
  const svgNodeRef = useRef(null);

  useEffect(() => {
    targetMajorStopsRef.current = targetMajorStops;
    countMajorRoutesRef.current = countMajorRoutes;
  }, [targetMajorStops, countMajorRoutes]);

  useEffect(() => {
    if (currentStopId && currentStopName) {
      document.title = `Transit Route Diagram - ${currentStopName} (${currentStopId})`;
    }
  }, [currentStopId, currentStopName]);

  const processRoutes = (
    routesWithTripCounts,
    stopId,
    stopName,
    stopsDataLoaded,
    rankingDataLoaded,
    servicesDataLoaded,
  ) => {
    const filteredRoutes = routesWithTripCounts.filter(
      (route) =>
        !isLastMajorStopInRoute(route, stopId, rankingDataLoaded, targetMajorStopsRef.current),
    );

    const topRoutes = filteredRoutes.slice(0, countMajorRoutesRef.current);
    const norm = normalizeStopId(stopId);

    topRoutes.forEach((route) => {
      const currentIndex = findStopIndex(route.stopSequence, stopId, norm);
      route.seqForGrouping =
        currentIndex === -1
          ? route.stopSequence.map(String)
          : route.stopSequence.slice(currentIndex).map(String);
    });

    const stats = buildForwardGroupStats(topRoutes, stopsDataLoaded);
    const groupComparator = createGroupSizeComparator(stats, stopsDataLoaded);
    const routesToUse = [...topRoutes].sort(groupComparator);

    const allMajorStops = new Set([stopId]);
    const stopRouteCount = new Map();

    routesToUse.forEach((route) => {
      const currentIndex = findStopIndex(route.stopSequence, stopId, norm);
      if (currentIndex === -1) return;

      const forwardStops = route.stopSequence.slice(currentIndex).map(String);
      forwardStops.forEach((sStr) => {
        stopRouteCount.set(sStr, (stopRouteCount.get(sStr) || 0) + 1);
      });

      const forwardStopsRanked = forwardStops
        .map((s) => ({ stopId: s, ranking: rankingDataLoaded[s] || 0 }))
        .sort((a, b) => b.ranking - a.ranking);

      if (forwardStops.length > 0) allMajorStops.add(forwardStops[forwardStops.length - 1]);
      forwardStopsRanked.slice(0, targetMajorStopsRef.current).forEach((s) =>
        allMajorStops.add(s.stopId),
      );
    });

    const allStops = getAllStopsFromRoutes(routesToUse, stopId);
    const majorStops = allStops.filter((s) => allMajorStops.has(s));
    const stopCounts = {};
    majorStops.forEach((s) => {
      stopCounts[s] = stopRouteCount.get(s) || 0;
    });

    setRoutes(routesToUse);
    setOrderedStops(majorStops);
    setStopRouteCounts(stopCounts);
    setLoading(false);
  };

  useEffect(() => {
    const city = getCurrentCity();
    setCurrentCity(city);
    const dataPath = `/data/${city}`;
    const scheduleJSONPath = `https://data.transitrouter.vonter.in/${city}/schedule`;

    Promise.all([
      fetchCache(`${dataPath}/services.min.json`, 24 * 60),
      fetchCache(`${dataPath}/stops.min.json`, 24 * 60),
      fetchCache(`${dataPath}/ranking.min.json`, 24 * 60).catch(() => ({})),
    ])
      .then(([servicesDataLoaded, stopsDataLoaded, rankingDataLoaded]) => {
        setServicesData(servicesDataLoaded);
        setStopsData(stopsDataLoaded);
        setRankingData(rankingDataLoaded);

        const handleHashChange = () => {
          setLoading(true);
          setError(null);

          let stopId = location.hash.slice(1);
          const route = getRoute();
          if (route.path && route.path !== '/') {
            stopId = route.path.replace(/^\/[a-z]+\//i, '');
          }
          stopId = stopId.replace(/^\/+|\/+$/g, '');

          if (!stopId) {
            setError('No stop ID provided in URL');
            setLoading(false);
            return;
          }

          if (!stopsDataLoaded[stopId]) {
            setError(`Stop ${stopId} not found`);
            setLoading(false);
            return;
          }

          const stopName = stopsDataLoaded[stopId][2];
          setCurrentStopId(stopId);
          setCurrentStopName(stopName);

          const processRoutesData = (scheduleDataLoaded) => {
            setScheduleData(scheduleDataLoaded);
            const routesFound = findRoutesForStop(stopId, servicesDataLoaded);
            if (routesFound.length === 0) {
              setError(
                `No routes found for stop ${stopId} (${stopName}). This stop may have infrequent service or no active routes in the dataset.`,
              );
              setLoading(false);
              return;
            }

            const routesWithTripCounts = routesFound.map((route) => ({
              ...route,
              tripCount: calculateRouteTripCount(route.routeId, servicesDataLoaded, scheduleDataLoaded),
              destinationRanking: rankingDataLoaded[route.destinationStopId] || 0,
            }));

            routesWithTripCounts.sort((a, b) => {
              if (a.tripCount !== b.tripCount) return b.tripCount - a.tripCount;
              return b.destinationRanking - a.destinationRanking;
            });

            processRoutes(
              routesWithTripCounts,
              stopId,
              stopName,
              stopsDataLoaded,
              rankingDataLoaded,
              servicesDataLoaded,
            );
          };

          fetchCache(`${scheduleJSONPath}/${stopId}.json`, 60 * 60)
            .then(processRoutesData)
            .catch(() => {
              console.warn('Failed to fetch schedule data, using fallback');
              processRoutesData(null);
            });
        };

        window.onhashchange = handleHashChange;
        handleHashChange();
      })
      .catch((err) => {
        console.error('Error loading data:', err);
        setError(`Error loading data: ${err.message}`);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (servicesData && currentStopId) {
      window.onhashchange();
    }
  }, [targetMajorStops, countMajorRoutes, servicesData, currentStopId]);

  useEffect(() => {
    if (!svgContainerRef.current || !routes.length || !orderedStops.length) return;

    const container = svgContainerRef.current;
    const containerWidth = diagramContainerRef.current?.clientWidth || 1200;
    d3.select(container).selectAll('svg').remove();

    const diagramWidth = containerWidth - ROUTE_LABEL_WIDTH;
    const diagramHeight = Math.max(500, routes.length * ROUTE_HEIGHT + 100);

    const clipRouteName = (routeId, maxLength = 8) =>
      !routeId || routeId.length <= maxLength ? routeId : routeId.substring(0, maxLength) + '…';

    const svg = d3
      .select(container)
      .append('svg')
      .attr('width', containerWidth)
      .attr('height', diagramHeight)
      .attr('viewBox', `0 0 ${containerWidth} ${diagramHeight}`)
      .attr('preserveAspectRatio', 'xMinYMin meet')
      .style(
        'font-family',
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif',
      );

    const defs = svg.append('defs');
    const routeGradient = defs
      .append('linearGradient')
      .attr('id', 'routeGradient')
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', ROUTE_LABEL_WIDTH)
      .attr('x2', containerWidth);
    routeGradient.append('stop').attr('offset', '0%').attr('stop-color', '#1a1a1a');
    routeGradient.append('stop').attr('offset', '100%').attr('stop-color', '#666666');

    const filter = defs
      .append('filter')
      .attr('id', 'dropShadow')
      .attr('x', '-50%')
      .attr('y', '-50%')
      .attr('width', '200%')
      .attr('height', '200%');
    filter.append('feGaussianBlur').attr('in', 'SourceAlpha').attr('stdDeviation', 2);
    filter.append('feOffset').attr('dx', 1).attr('dy', 1).attr('result', 'offsetblur');
    filter.append('feComponentTransfer').append('feFuncA').attr('type', 'linear').attr('slope', 0.3);
    const feMerge = filter.append('feMerge');
    feMerge.append('feMergeNode');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    const routeLinesGroup = svg.append('g').attr('class', 'route-lines');
    const markersGroup = svg.append('g').attr('class', 'stop-markers');
    const mergedMarkersGroup = svg.append('g').attr('class', 'merged-markers');
    const labelsGroup = svg.append('g').attr('class', 'stop-labels');

    const stopPosMap = createStopPositionMap(routes, orderedStops, currentStopId, stopsData);

    // Build stop positions map
    const stopPositions = {};
    const namePositions = {};
    routes.forEach((route, routeIndex) => {
      const routeStopsInOrder = orderedStops.filter((stopId) => {
        if (stopId === currentStopId) return false;
        const norm = normalizeStopId(stopId);
        return route.stopSequence.some((id) => matchesStop(id, norm));
      });

      routeStopsInOrder.forEach((stopId) => {
        if (!stopPositions[stopId]) stopPositions[stopId] = [];
        const posData = stopPosMap[stopId] || { position: 50 };
        stopPositions[stopId].push({ routeIndex, position: posData.position });
        const name = getStopName(stopId, stopsData);
        if (!namePositions[name]) namePositions[name] = [];
        namePositions[name].push({ routeIndex, position: posData.position });
      });
    });

    const commonNames = Object.keys(namePositions).filter((name) => namePositions[name].length > 1);
    const xScale = (percent) => ROUTE_LABEL_WIDTH + (percent / 100) * diagramWidth;

    // Draw route labels
    routes.forEach((route, routeIndex) => {
      const y = ROUTE_START_Y + routeIndex * ROUTE_HEIGHT;
      routeLinesGroup
        .append('rect')
        .attr('x', 0)
        .attr('y', y - 20)
        .attr('width', ROUTE_LABEL_WIDTH)
        .attr('height', 40)
        .attr('rx', 6)
        .attr('fill', '#1a1a1a')
        .attr('filter', 'url(#dropShadow)');

      routeLinesGroup
        .append('text')
        .attr('x', ROUTE_LABEL_WIDTH / 2)
        .attr('y', y)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('fill', '#ffffff')
        .attr('font-size', '11px')
        .attr('font-weight', '600')
        .text(clipRouteName(route.routeId))
        .append('title')
        .text(route.routeName || route.routeId);
    });

    // Build segments helper
    const buildSegments = (positions) => {
      const sorted = [...positions].sort((a, b) => a.routeIndex - b.routeIndex);
      const segments = [];
      let segStart = sorted[0];
      let prev = sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i];
        if (cur.routeIndex === prev.routeIndex + 1) {
          prev = cur;
        } else {
          segments.push([segStart, prev]);
          segStart = cur;
          prev = cur;
        }
      }
      segments.push([segStart, prev]);
      return { segments, sorted };
    };

    const findMergedStopPosition = (stopName, routeIndex) => {
      const positions = namePositions[stopName];
      if (!positions || positions.length < 2) return null;
      const { segments } = buildSegments(positions);
      for (const [start, end] of segments) {
        if (routeIndex >= start.routeIndex && routeIndex <= end.routeIndex) {
          return start.position;
        }
      }
      return null;
    };

    // Draw route lines and markers
    routes.forEach((route, routeIndex) => {
      const { stopSequence } = route;
      const y = ROUTE_START_Y + routeIndex * ROUTE_HEIGHT;

      const routeStopsInOrder = orderedStops.filter((stopId) => {
        if (stopId === currentStopId) return false;
        const norm = normalizeStopId(stopId);
        return stopSequence.some((id) => matchesStop(id, norm));
      });

      if (routeStopsInOrder.length === 0) return;

      // Find last stop position
      let lastStopPos = null;
      for (let i = routeStopsInOrder.length - 1; i >= 0; i--) {
        const stopId = routeStopsInOrder[i];
        const stopName = getStopName(stopId, stopsData);
        const isCommon = namePositions[stopName] && namePositions[stopName].length > 1;

        if (!isCommon) {
          lastStopPos = (stopPosMap[stopId] || { position: 50 }).position;
          break;
        } else {
          const mergedPos = findMergedStopPosition(stopName, routeIndex);
          if (mergedPos !== null) {
            lastStopPos = mergedPos;
            break;
          }
        }
      }

      if (!lastStopPos) {
        const lastStopId = routeStopsInOrder[routeStopsInOrder.length - 1];
        const lastStopName = getStopName(lastStopId, stopsData);
        const lastStopIsCommon = namePositions[lastStopName] && namePositions[lastStopName].length > 1;
        if (lastStopIsCommon) {
          const mergedPos = findMergedStopPosition(lastStopName, routeIndex);
          lastStopPos =
            mergedPos !== null ? mergedPos : (stopPosMap[lastStopId] || { position: 50 }).position;
        } else {
          lastStopPos = (stopPosMap[lastStopId] || { position: 50 }).position;
        }
      }

      const startX = ROUTE_LABEL_WIDTH;
      const endX =
        typeof lastStopPos === 'number' && !Number.isNaN(lastStopPos)
          ? xScale(Math.min(100, lastStopPos))
          : xScale(50);

      const lineLength = endX - startX;
      if (lineLength > 0) {
        routeLinesGroup
          .append('line')
          .attr('x1', startX)
          .attr('y1', y)
          .attr('x2', endX)
          .attr('y2', y)
          .attr('stroke', '#000000')
          .attr('stroke-width', 8)
          .attr('stroke-linecap', 'round')
          .attr('opacity', 0.8);
      }

      // Draw individual markers
      routeStopsInOrder.forEach((stopId) => {
        const posData = stopPosMap[stopId] || { position: 50 };
        const stopName = getStopName(stopId, stopsData);
        const isCommon = namePositions[stopName] && namePositions[stopName].length > 1;

        if (isCommon) return;

        const x = xScale(posData.position);
        markersGroup
          .append('circle')
          .attr('cx', x)
          .attr('cy', y)
          .attr('r', MARKER_RADIUS)
          .attr('fill', '#ffffff')
          .attr('stroke', '#1a1a1a')
          .attr('stroke-width', 3)
          .attr('filter', 'url(#dropShadow)')
          .append('title')
          .text(stopName);
      });
    });

    // Draw merged markers for common stops
    commonNames.forEach((stopName) => {
      const positions = namePositions[stopName];
      if (!positions || positions.length < 2) return;

      const { segments, sorted } = buildSegments(positions);
      const x = xScale(sorted[0].position);

      segments.forEach(([start, end]) => {
        const y1 = ROUTE_START_Y + start.routeIndex * ROUTE_HEIGHT - MARKER_RADIUS;
        const y2 = ROUTE_START_Y + end.routeIndex * ROUTE_HEIGHT + MARKER_RADIUS;
        const height = y2 - y1;

        mergedMarkersGroup
          .append('rect')
          .attr('x', x - MARKER_RADIUS)
          .attr('y', y1)
          .attr('width', MARKER_RADIUS * 2)
          .attr('height', height)
          .attr('rx', MARKER_RADIUS)
          .attr('fill', '#ffffff')
          .attr('stroke', '#1a1a1a')
          .attr('stroke-width', 3)
          .attr('filter', 'url(#dropShadow)')
          .append('title')
          .text(stopName);
      });
    });

    // Build label data
    const ROTATION_RAD = (LABEL_ROTATION * Math.PI) / 180;
    const labelData = [];
    Object.entries(namePositions).forEach(([name, positions]) => {
      const isCommon = positions.length > 1;

      if (isCommon) {
        const { segments } = buildSegments(positions);
        segments.forEach(([start, end]) => {
          const topRouteIndex = start.routeIndex;
          const markerTopY = ROUTE_START_Y + topRouteIndex * ROUTE_HEIGHT - MARKER_RADIUS;
          const verticalOffset =
            BASE_VERTICAL_OFFSET + name.length * VERTICAL_SCALE_FACTOR * Math.abs(Math.sin(ROTATION_RAD));
          const labelY = markerTopY - verticalOffset;

          labelData.push({
            text: name,
            x: start.position,
            originalX: start.position,
            y: labelY,
            isCommon: true,
            segmentStart: start.routeIndex,
            segmentEnd: end.routeIndex,
          });
        });
      } else {
        const stopIdForName = Object.keys(stopPositions).find(
          (stopId) => getStopName(stopId, stopsData) === name,
        );
        const posData = stopIdForName
          ? stopPosMap[stopIdForName] || { position: 50 }
          : { position: 50 };
        const xPosition = posData.position;
        const useIdx = positions.reduce((s, p) => s + p.routeIndex, 0) / positions.length;
        const topRouteIndex = Math.floor(useIdx);
        const markerTopY = ROUTE_START_Y + topRouteIndex * ROUTE_HEIGHT - MARKER_RADIUS;
        const verticalOffset =
          BASE_VERTICAL_OFFSET + name.length * VERTICAL_SCALE_FACTOR * Math.abs(Math.sin(ROTATION_RAD));
        const labelY = markerTopY - verticalOffset;

        labelData.push({
          text: name,
          x: xPosition,
          originalX: xPosition,
          y: labelY,
          isCommon: false,
        });
      }
    });

    labelData.sort((a, b) => a.x - b.x);

    // Resolve label overlaps
    const estimateWidth = (text) => text.length * 6 + 24;
    const getHorizontalProjection = (width) => width * Math.cos(ROTATION_RAD);
    const labelWidths = new Map();
    const minSpacing = 1;

    for (let i = 0; i < labelData.length - 1; i++) {
      const current = labelData[i];
      const next = labelData[i + 1];

      if (!labelWidths.has(current.text)) labelWidths.set(current.text, estimateWidth(current.text));
      if (!labelWidths.has(next.text)) labelWidths.set(next.text, estimateWidth(next.text));

      const currentOriginalWidth = labelWidths.get(current.text);
      const nextOriginalWidth = labelWidths.get(next.text);
      const currentWidth = getHorizontalProjection(currentOriginalWidth);
      const nextWidth = getHorizontalProjection(nextOriginalWidth);

      const currentRight = xScale(current.x) + currentWidth / 2;
      const nextLeft = xScale(next.x) - nextWidth / 2;

      if (currentRight + minSpacing > nextLeft) {
        const overlap = currentRight + minSpacing - nextLeft;
        const proposedX = next.x + (overlap / diagramWidth) * 100;
        const maxX = Math.min(next.originalX + MAX_DRIFT_PERCENT, 100);
        const minX = Math.max(next.originalX - MAX_DRIFT_PERCENT, 0);
        next.x = Math.min(maxX, Math.max(minX, proposedX));
      }
    }

    labelData.sort((a, b) => {
      if (Math.abs(a.x - b.x) < 5) return a.y - b.y;
      return a.x - b.x;
    });

    // Resolve vertical overlaps
    const verticalSpacing = 1;
    for (let i = 0; i < labelData.length - 1; i++) {
      const current = labelData[i];
      const next = labelData[i + 1];
      if (Math.abs(current.x - next.x) < 5 && Math.abs(current.y - next.y) < verticalSpacing) {
        next.y = Math.max(next.y, current.y + verticalSpacing);
      }
    }

    labelData.sort((a, b) => a.x - b.x);

    // Build marker positions map
    const markerPositionsMap = new Map();
    routes.forEach((route, routeIndex) => {
      const routeStopsInOrder = orderedStops.filter((stopId) => {
        if (stopId === currentStopId) return false;
        const norm = normalizeStopId(stopId);
        return route.stopSequence.some((id) => matchesStop(id, norm));
      });

      routeStopsInOrder.forEach((stopId) => {
        const posData = stopPosMap[stopId] || { position: 50 };
        const stopName = getStopName(stopId, stopsData);
        const isCommon = namePositions[stopName] && namePositions[stopName].length > 1;

        if (!isCommon) {
          const markerX = xScale(posData.position);
          const markerY = ROUTE_START_Y + routeIndex * ROUTE_HEIGHT;
          if (!markerPositionsMap.has(stopName)) {
            markerPositionsMap.set(stopName, {
              x: markerX,
              y: markerY,
              percentage: posData.position,
            });
          }
        }
      });
    });

    commonNames.forEach((stopName) => {
      const positions = namePositions[stopName];
      if (!positions || positions.length < 2) return;
      const { segments } = buildSegments(positions);
      segments.forEach(([start, end]) => {
        const markerX = xScale(start.position);
        const markerY = ROUTE_START_Y + start.routeIndex * ROUTE_HEIGHT - MARKER_RADIUS;
        const segmentKey = `${stopName}-${start.routeIndex}`;
        markerPositionsMap.set(segmentKey, {
          x: markerX,
          y: markerY,
          percentage: start.position,
        });
      });
    });

    // Draw labels
    const LABEL_HORIZONTAL_OFFSET = -4;
    labelData.forEach((label) => {
      const markerKey =
        label.isCommon && label.segmentStart !== undefined
          ? `${label.text}-${label.segmentStart}`
          : label.text;
      const markerPos = markerPositionsMap.get(markerKey);
      const labelX = markerPos ? markerPos.x : xScale(label.x);
      const labelY = label.y;

      const labelGroup = labelsGroup
        .append('g')
        .attr('transform', `translate(${labelX}, ${labelY}) rotate(${LABEL_ROTATION})`);

      labelGroup
        .append('text')
        .attr('x', LABEL_HORIZONTAL_OFFSET)
        .attr('y', 0)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('font-size', '11px')
        .attr('font-weight', '500')
        .attr('fill', '#1a1a1a')
        .text(label.text);
    });

    svgNodeRef.current = svg.node();
  }, [routes, orderedStops, currentStopId, stopsData]);

  if (loading) {
    return (
      <div class="loading">
        <p class="placeholder">Loading diagram...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div class="error-message">
        <h2>Error</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!routes.length || !orderedStops.length) {
    return (
      <div class="error-message">
        <h2>No data available</h2>
        <p>No routes found for this stop.</p>
      </div>
    );
  }

  const stopCount = orderedStops.filter((stopId) => stopId !== currentStopId).length;
  const requiredHeight = Math.max(500, stopCount * 70 + 100);

  return (
    <div style={{ '--route-height': `${requiredHeight}px` }}>
      <div class="diagram-header">
        <h1>
          <b>
            <span class="stop-tag">{currentStopId}</span> {currentStopName}
          </b>
        </h1>
        <div class="diagram-controls">
          <label class="control-group">
            <span class="control-label">Number of Routes</span>
            <input
              type="number"
              min="1"
              max="100"
              value={countMajorRoutes}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10);
                if (!Number.isNaN(value) && value > 0 && value <= 100) {
                  setCountMajorRoutes(value);
                }
              }}
              onBlur={(e) => {
                const value = parseInt(e.target.value, 10);
                if (Number.isNaN(value) || value < 1) {
                  setCountMajorRoutes(DEFAULT_COUNT_MAJOR_ROUTES);
                } else if (value > 100) {
                  setCountMajorRoutes(100);
                }
              }}
              class="control-input"
            />
          </label>
          <label class="control-group">
            <span class="control-label">Number of Major Stops</span>
            <input
              type="number"
              min="1"
              max="50"
              value={targetMajorStops}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10);
                if (!Number.isNaN(value) && value > 0 && value <= 50) {
                  setTargetMajorStops(value);
                }
              }}
              onBlur={(e) => {
                const value = parseInt(e.target.value, 10);
                if (Number.isNaN(value) || value < 1) {
                  setTargetMajorStops(DEFAULT_TARGET_MAJOR_STOPS);
                } else if (value > 50) {
                  setTargetMajorStops(50);
                }
              }}
              class="control-input"
            />
          </label>
          <button
            class="export-button"
            onClick={() => {
              const svg = svgNodeRef.current || svgContainerRef.current?.querySelector('svg');
              if (!svg) return;
              const svgData = new XMLSerializer().serializeToString(svg);
              const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
              const svgUrl = URL.createObjectURL(svgBlob);
              const downloadLink = document.createElement('a');
              downloadLink.href = svgUrl;
              downloadLink.download = `transit-diagram-${currentStopId}-${Date.now()}.svg`;
              document.body.appendChild(downloadLink);
              downloadLink.click();
              document.body.removeChild(downloadLink);
              URL.revokeObjectURL(svgUrl);
            }}
            title="Export diagram as SVG"
          >
            Export SVG
          </button>
        </div>
      </div>

      <div class="diagram-container" ref={diagramContainerRef}>
        <div class="diagram-wrapper" ref={svgContainerRef}>
          {/* SVG diagram rendered by D3 */}
        </div>
      </div>

      <div class="footer">
        <p>
          <a href="/">TransitRouter</a>
        </p>
      </div>
    </div>
  );
}

const $diagram = document.getElementById('diagram');
render(<BusDiagram />, $diagram);
