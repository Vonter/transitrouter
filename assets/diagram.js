import './i18n';

import { getCurrentCity } from './config';
import { h, render, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';

import fetchCache from './utils/fetchCache';
import { sortServices } from './utils/bus';
import getRoute from './utils/getRoute';

// Target number of major stops to show in the diagram (flexible, not a hard limit)
const TARGET_MAJOR_STOPS = 5;

/**
 * Find all routes that pass through a given stop
 */
function findRoutesForStop(stopId, servicesData) {
  const routes = [];
  
  // Convert stopId to both string and number for comparison
  // (sequences store stops as integers, but stopId comes in as string)
  const stopIdNum = parseInt(stopId, 10);
  const stopIdStr = String(stopId);
  
  for (const [routeId, routeData] of Object.entries(servicesData)) {
    // Check each destination in the route
    for (const [destinationStopId, stopSequences] of Object.entries(routeData)) {
      if (destinationStopId === 'name') continue; // Skip the name field
      
      // Check each stop sequence variant
      for (const stopSequence of stopSequences) {
        // Check both as number and string since data might use either format
        const hasStop = stopSequence.includes(stopIdNum) || stopSequence.includes(stopIdStr);
        
        if (hasStop) {
          routes.push({
            routeId,
            routeName: routeData.name,
            destinationStopId,
            stopSequence,
          });
          break; // Only need one sequence per destination
        }
      }
    }
  }
  
  return routes;
}

/**
 * Get all unique stops from all routes, maintaining their order and position
 * Only includes stops in the forward direction from currentStopId
 */
function getAllStopsFromRoutes(routes, currentStopId) {
  const stopPositions = new Map(); // stop_id -> Set of positions
  const currentStopStr = String(currentStopId);
  const currentStopNum = parseInt(currentStopId, 10);
  
  routes.forEach((route) => {
    // Find the index of current stop in this route
    let currentStopIndex = -1;
    for (let i = 0; i < route.stopSequence.length; i++) {
      const stopId = route.stopSequence[i];
      if (stopId === currentStopNum || String(stopId) === currentStopStr) {
        currentStopIndex = i;
        break;
      }
    }
    
    // If current stop not in route, skip this route
    if (currentStopIndex === -1) return;
    
    // Only process stops from current stop onwards (forward direction)
    route.stopSequence.slice(currentStopIndex).forEach((stopId, relativeIndex) => {
      // Normalize to string for consistent comparison
      const stopIdStr = String(stopId);
      if (!stopPositions.has(stopIdStr)) {
        stopPositions.set(stopIdStr, new Set());
      }
      // Use relative position from current stop
      stopPositions.get(stopIdStr).add(relativeIndex);
    });
  });
  
  // Calculate average position for each stop for sorting
  const stopsWithAvgPosition = Array.from(stopPositions.entries()).map(
    ([stopId, positions]) => {
      const avgPosition = Array.from(positions).reduce((a, b) => a + b, 0) / positions.size;
      return { stopId, avgPosition };
    }
  );
  
  // Sort by average position (current stop will be first with position 0)
  stopsWithAvgPosition.sort((a, b) => a.avgPosition - b.avgPosition);
  
  return stopsWithAvgPosition.map((s) => s.stopId);
}

/**
 * Filter stops to show major ones based on ranking, with ~10 stops as a target
 * The target is flexible - we include all terminal stops and high-importance stops
 */
function filterMajorStops(allStops, currentStopId, rankingData, routes) {
  // Create array of stops with their rankings
  const stopsWithRankings = allStops.map((stopId) => ({
    stopId,
    ranking: rankingData[stopId] || 0,
    isCurrent: stopId === currentStopId,
  }));
  
  // Get first and last stops from each route (always include these)
  const terminalStops = new Set();
  routes.forEach((route) => {
    if (route.stopSequence.length > 0) {
      // Normalize to string for consistent comparison
      terminalStops.add(String(route.stopSequence[0])); // First stop
      terminalStops.add(String(route.stopSequence[route.stopSequence.length - 1])); // Last stop
    }
  });
  
  // Mark terminal stops
  stopsWithRankings.forEach((stop) => {
    stop.isTerminal = terminalStops.has(stop.stopId);
  });
  
  // Sort by ranking (descending) - higher ranking = more important
  stopsWithRankings.sort((a, b) => b.ranking - a.ranking);
  
  // Calculate a significance threshold: stops with ranking > 20% of max are significant
  const maxRanking = stopsWithRankings[0]?.ranking || 0;
  const significanceThreshold = maxRanking * 0.2;
  
  // Select stops in priority order:
  // 1. Current stop (always)
  // 2. Terminal stops (always - first/last of routes)
  // 3. Highly ranked stops (ranking > significance threshold)
  // 4. Additional stops to reach approximately TARGET_MAJOR_STOPS
  const selectedStops = new Set();
  
  // Add current stop
  if (currentStopId) {
    selectedStops.add(currentStopId);
  }
  
  // Add all terminal stops (can exceed target)
  stopsWithRankings.forEach((stop) => {
    if (stop.isTerminal) {
      selectedStops.add(stop.stopId);
    }
  });
  
  // Add highly significant stops (can exceed target if important)
  stopsWithRankings.forEach((stop) => {
    if (stop.ranking >= significanceThreshold) {
      selectedStops.add(stop.stopId);
    }
  });
  
  // If we're below target, add more high-ranking stops
  for (const stop of stopsWithRankings) {
    if (selectedStops.size >= TARGET_MAJOR_STOPS) {
      // Already at target, only add if ranking is very high (> 50% of max)
      if (stop.ranking < maxRanking * 0.5) break;
    }
    selectedStops.add(stop.stopId);
  }
  
  // Ensure we have at least 5 stops (or all available if less)
  const minStops = Math.min(5, allStops.length);
  if (selectedStops.size < minStops) {
    for (const stop of stopsWithRankings) {
      if (selectedStops.size >= minStops) break;
      selectedStops.add(stop.stopId);
    }
  }
  
  // Return stops in their original order
  return allStops.filter((stopId) => selectedStops.has(stopId));
}

/**
 * Create a smart positioning map for stops based on route commonality
 * Uses stop NAMES to determine commonality so different IDs with same name align.
 * Common names get fixed positions, unique stops are positioned relative to their route sequence
 */
function createStopPositionMap(routes, orderedStops, currentStopId, stopsData) {
  const nameOccurrences = {}; // stopName -> count of routes containing this name
  const stopPositionMap = {}; // stopId -> { position, isCommon }

  // For each route, build a Set of stop names it serves (from orderedStops, excluding current)
  const routeNameSets = routes.map((route) => {
    const names = new Set();
    orderedStops.forEach((stopId) => {
      if (stopId === currentStopId) return;
      const stopIdNum = parseInt(stopId, 10);
      const inRoute = route.stopSequence.includes(stopIdNum) || route.stopSequence.includes(stopId);
      if (inRoute) {
        const name = stopsData[stopId]?.[2] || String(stopId);
        names.add(name);
      }
    });
    return names;
  });

  // Count in how many routes each stop name appears
  routeNameSets.forEach((nameSet) => {
    nameSet.forEach((name) => {
      nameOccurrences[name] = (nameOccurrences[name] || 0) + 1;
    });
  });

  // Current stop name (to exclude from common anchors)
  const currentStopName = stopsData[currentStopId]?.[2] || String(currentStopId);

  // Ordered unique list of common names as they appear in orderedStops
  const seen = new Set();
  const commonNames = [];
  orderedStops.forEach((stopId) => {
    if (stopId === currentStopId) return;
    const name = stopsData[stopId]?.[2] || String(stopId);
    if (name === currentStopName) return;
    if (!seen.has(name) && (nameOccurrences[name] || 0) >= 2) {
      seen.add(name);
      commonNames.push(name);
    }
  });

  // Assign fixed positions to common names
  const leftPadding = 5;
  const rightPadding = 10;
  const usableWidth = 100 - leftPadding - rightPadding;
  const nameToPosition = {};
  if (commonNames.length > 0) {
    commonNames.forEach((name, index) => {
      const position = leftPadding + (index / Math.max(commonNames.length - 1, 1)) * usableWidth;
      nameToPosition[name] = position;
    });
  }

  // For each route, position its stops. Common-name stops anchor to their name's position
  routes.forEach((route) => {
    const routeStops = orderedStops.filter((stopId) => {
      if (stopId === currentStopId) return false;
      const stopIdNum = parseInt(stopId, 10);
      return route.stopSequence.includes(stopIdNum) || route.stopSequence.includes(stopId);
    });

    // Position stops
    routeStops.forEach((stopId, stopIndex) => {
      const name = stopsData[stopId]?.[2] || String(stopId);
      if (nameToPosition[name] !== undefined) {
        // Common-name stop: fixed anchor
        stopPositionMap[stopId] = { position: nameToPosition[name], isCommon: true };
        return;
      }

      // Find surrounding common-name anchors by looking backward/forward for nearest stops whose names are anchors
      const findAnchorIndexBackward = () => {
        for (let i = stopIndex - 1; i >= 0; i--) {
          const n = stopsData[routeStops[i]]?.[2] || String(routeStops[i]);
          if (nameToPosition[n] !== undefined) return i;
        }
        return -1;
      };
      const findAnchorIndexForward = () => {
        for (let i = stopIndex + 1; i < routeStops.length; i++) {
          const n = stopsData[routeStops[i]]?.[2] || String(routeStops[i]);
          if (nameToPosition[n] !== undefined) return i;
        }
        return -1;
      };

      const backIdx = findAnchorIndexBackward();
      const fwdIdx = findAnchorIndexForward();
      let position;

      if (backIdx !== -1 && fwdIdx !== -1) {
        // Interpolate between two anchored names
        const startName = stopsData[routeStops[backIdx]]?.[2] || String(routeStops[backIdx]);
        const endName = stopsData[routeStops[fwdIdx]]?.[2] || String(routeStops[fwdIdx]);
        const startPos = nameToPosition[startName];
        const endPos = nameToPosition[endName];
        const progress = (stopIndex - backIdx) / (fwdIdx - backIdx);
        position = startPos + (endPos - startPos) * progress;
      } else if (backIdx !== -1) {
        // Extend after the last anchor
        const baseName = stopsData[routeStops[backIdx]]?.[2] || String(routeStops[backIdx]);
        const basePos = nameToPosition[baseName];
        const offset = (stopIndex - backIdx) * 8;
        position = Math.min(basePos + offset, 95);
      } else if (fwdIdx !== -1) {
        // Extend before the first anchor
        const baseName = stopsData[routeStops[fwdIdx]]?.[2] || String(routeStops[fwdIdx]);
        const basePos = nameToPosition[baseName];
        const offset = (fwdIdx - stopIndex) * 8;
        position = Math.max(basePos - offset, 5);
      } else {
        // No anchors in route - distribute evenly
        position = leftPadding + (stopIndex / Math.max(routeStops.length - 1, 1)) * usableWidth;
      }

      stopPositionMap[stopId] = { position, isCommon: false };
    });
  });

  return stopPositionMap;
}


/**
 * Calculate route similarity score (Jaccard similarity)
 */
function calculateRouteSimilarity(route1Stops, route2Stops) {
  const set1 = new Set(route1Stops.map(String));
  const set2 = new Set(route2Stops.map(String));
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Group routes into clusters based on stop commonality
 * Routes that share significant stops are grouped together
 */
function clusterRoutesByStops(routes, minSimilarity = 0.2) {
  if (routes.length === 0) return [];
  if (routes.length === 1) return [[routes[0]]];
  
  const clusters = [];
  const processed = new Set();
  
  routes.forEach((route, index) => {
    if (processed.has(index)) return;
    
    const cluster = [route];
    processed.add(index);
    
    // Find all routes similar to any route in this cluster
    let changed = true;
    while (changed) {
      changed = false;
      
      routes.forEach((otherRoute, otherIndex) => {
        if (processed.has(otherIndex)) return;
        
        // Check similarity with any route in the cluster
        for (const clusterRoute of cluster) {
          const a = clusterRoute.seqForGrouping || clusterRoute.stopSequence;
          const b = otherRoute.seqForGrouping || otherRoute.stopSequence;
          const similarity = calculateRouteSimilarity(a, b);
          
          if (similarity >= minSimilarity) {
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
  
  // Sort clusters by size (largest first)
  clusters.sort((a, b) => b.length - a.length);
  
  return clusters;
}

/**
 * Order routes within a cluster so that adjacent routes share many stops
 * Greedy nearest-neighbor using the similarity metric
 */
function orderClusterBySimilarity(cluster) {
  if (cluster.length <= 2) return [...cluster];
  const seqs = cluster.map(r => r.seqForGrouping || r.stopSequence);
  const sim = seqs.map(() => Array(seqs.length).fill(0));
  for (let i = 0; i < seqs.length; i++) {
    for (let j = i + 1; j < seqs.length; j++) {
      sim[i][j] = sim[j][i] = calculateRouteSimilarity(seqs[i], seqs[j]);
    }
  }
  let current = 0, bestTotal = -1;
  for (let i = 0; i < sim.length; i++) {
    const total = sim[i].reduce((a, b) => a + b, 0);
    if (total > bestTotal) { bestTotal = total; current = i; }
  }
  const used = new Set([current]);
  const order = [current];
  while (order.length < seqs.length) {
    let next = -1, best = -1;
    for (let j = 0; j < seqs.length; j++) {
      if (used.has(j)) continue;
      const s = sim[current][j];
      if (s > best || (s === best && sortServices(cluster[j]?.routeId, cluster[next]?.routeId) < 0)) {
        best = s; next = j;
      }
    }
    if (next === -1) {
      // Fallback: pick remaining with highest total similarity
      let fallback = -1, totBest = -1;
      for (let j = 0; j < seqs.length; j++) {
        if (used.has(j)) continue;
        const tot = sim[j].reduce((a, b) => a + b, 0);
        if (tot > totBest) { totBest = tot; fallback = j; }
      }
      next = fallback;
    }
    used.add(next);
    order.push(next);
    current = next;
  }
  return order.map(i => cluster[i]);
}

/**
 * Progressive grouping by common forward stops (from first to last)
 * Sort comparator: compares forward sequences lexicographically from the
 * first stop AFTER the current stop, then second, etc. Shorter prefix wins.
 */
function compareRoutesByForwardPrefix(a, b) {
  const sa = (a.seqForGrouping || a.stopSequence).map(String);
  const sb = (b.seqForGrouping || b.stopSequence).map(String);
  for (let i = 1, max = Math.max(sa.length, sb.length); i < max; i++) {
    const va = sa[i], vb = sb[i];
    if (va === vb) continue;
    if (va === undefined) return -1;
    if (vb === undefined) return 1;
    const na = Number(va), nb = Number(vb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    const cmp = String(va).localeCompare(String(vb));
    if (cmp !== 0) return cmp;
  }
  return sortServices(a.routeId, b.routeId);
}

/**
 * Build group size statistics for each forward position i >= 1
 * Returns an array where stats[i] is a Map stopName -> count at position i
 */
function buildForwardGroupStats(routes, stopsData) {
  const stats = [];
  for (const r of routes) {
    const seq = (r.seqForGrouping || r.stopSequence).map(String);
    for (let i = 1; i < seq.length; i++) {
      if (!stats[i]) stats[i] = new Map();
      const name = stopsData[seq[i]]?.[2] || seq[i];
      stats[i].set(name, (stats[i].get(name) || 0) + 1);
    }
  }
  return stats;
}

/**
 * Comparator prioritizing larger common groups at each successive stop position.
 * For the first differing position i, prefer the stop that more routes share at i.
 * Groups by stop name instead of stop ID.
 */
function createGroupSizeComparator(stats, stopsData) {
  return function compare(a, b) {
    const sa = (a.seqForGrouping || a.stopSequence).map(String);
    const sb = (b.seqForGrouping || b.stopSequence).map(String);
    for (let i = 1, max = Math.max(sa.length, sb.length); i < max; i++) {
      const na = sa[i] === undefined ? undefined : (stopsData[sa[i]]?.[2] || sa[i]);
      const nb = sb[i] === undefined ? undefined : (stopsData[sb[i]]?.[2] || sb[i]);
      if (na === nb) continue;
      const map = stats[i] || new Map();
      const ca = na === undefined ? -1 : (map.get(na) || 0);
      const cb = nb === undefined ? -1 : (map.get(nb) || 0);
      if (ca !== cb) return cb - ca;
      if (na === undefined) return 1;
      if (nb === undefined) return -1;
      const cmp = String(na).localeCompare(String(nb));
      if (cmp !== 0) return cmp;
    }
    return sortServices(a.routeId, b.routeId);
  };
}

/**
 * Get ordered stops for a specific cluster of routes
 * Only includes stops that are actually served by routes in the cluster
 */
function getOrderedStopsForCluster(cluster, currentStopId, rankingData) {
  // Get all stops from this cluster (forward direction only)
  const allStops = getAllStopsFromRoutes(cluster, currentStopId);
  
  // Filter to major stops
  const majorStops = filterMajorStops(
    allStops,
    currentStopId,
    rankingData,
    cluster
  );
  
  return majorStops;
}

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

  useEffect(() => {
    if (!currentStopId || !currentStopName) return;
    document.title = `Transit Route Diagram - ${currentStopName} (${currentStopId})`;
  }, [currentStopId, currentStopName]);

  useEffect(() => {
    // Get city from URL (supports both #12345 and #/blr/12345 formats)
    const city = getCurrentCity();
    setCurrentCity(city);
    
    const dataPath = `/data/${city}`;
    const servicesJSONPath = `${dataPath}/services.min.json`;
    const stopsJSONPath = `${dataPath}/stops.min.json`;
    const rankingJSONPath = `${dataPath}/ranking.min.json`;

    Promise.all([
      fetchCache(servicesJSONPath, 24 * 60),
      fetchCache(stopsJSONPath, 24 * 60),
      fetchCache(rankingJSONPath, 24 * 60).catch(() => ({})), // Ranking is optional
    ])
      .then(([servicesData, stopsDataLoaded, rankingDataLoaded]) => {
        setStopsData(stopsDataLoaded);
        setRankingData(rankingDataLoaded);

        window.onhashchange = () => {
          setLoading(true);
          setError(null);
          
          // Extract stop ID from hash, handling city prefix
          // Supports: #12345 or #/blr/12345
          let stopId = location.hash.slice(1);
          
          // If hash contains city prefix like #/blr/12345, extract just the stop ID
          const route = getRoute();
          if (route.path && route.path !== '/') {
            // Remove city prefix if present: /blr/12345 -> 12345
            stopId = route.path.replace(/^\/[a-z]+\//i, '');
          }
          
          // Clean up any remaining slashes
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

          // Find all routes passing through this stop
          const routesFound = findRoutesForStop(stopId, servicesData);

          if (routesFound.length === 0) {
            setError(
              `No routes found for stop ${stopId} (${stopName}). ` +
              `This stop may have infrequent service or no active routes in the dataset.`
            );
            setLoading(false);
            return;
          }

          // Build forward-only sequences from current stop for grouping
          // Store both stop IDs (for internal use) and names (for grouping)
          const currentStopStrForGroup = String(stopId);
          const currentStopNumForGroup = parseInt(stopId, 10);
          routesFound.forEach((route) => {
            let currentIndex = -1;
            for (let i = 0; i < route.stopSequence.length; i++) {
              const s = route.stopSequence[i];
              if (s === currentStopNumForGroup || String(s) === currentStopStrForGroup) {
                currentIndex = i;
                break;
              }
            }
            // Keep stop IDs in seqForGrouping (needed for other operations)
            route.seqForGrouping = currentIndex === -1
              ? route.stopSequence.map(String)
              : route.stopSequence.slice(currentIndex).map(String);
          });

          // Progressive grouping: sort routes so larger common groups appear first (top)
          // Group by stop names instead of stop IDs
          const stats = buildForwardGroupStats(routesFound, stopsDataLoaded);
          const groupComparator = createGroupSizeComparator(stats, stopsDataLoaded);
          const routesToUse = [...routesFound].sort(groupComparator);

          // For each route, identify its major stops (up to 10 per route, forward direction only)
          const allMajorStops = new Set();
          allMajorStops.add(stopId); // Always include current stop
          
          const currentStopStr = String(stopId);
          const currentStopNum = parseInt(stopId, 10);
          
          // Calculate how many routes each stop appears in
          const stopRouteCount = new Map();
          routesToUse.forEach((route) => {
            const forwardStops = [];
            let currentIndex = -1;
            for (let i = 0; i < route.stopSequence.length; i++) {
              const s = route.stopSequence[i];
              if (s === currentStopNum || String(s) === currentStopStr) {
                currentIndex = i;
                break;
              }
            }
            if (currentIndex !== -1) {
              route.stopSequence.slice(currentIndex).forEach(s => {
                const sStr = String(s);
                stopRouteCount.set(sStr, (stopRouteCount.get(sStr) || 0) + 1);
              });
            }
          });
          
          routesToUse.forEach((route) => {
            // Find current stop index in this route
            let currentIndex = -1;
            for (let i = 0; i < route.stopSequence.length; i++) {
              const s = route.stopSequence[i];
              if (s === currentStopNum || String(s) === currentStopStr) {
                currentIndex = i;
                break;
              }
            }
            
            if (currentIndex === -1) return; // Current stop not in this route
            
            // Get stops from current stop onwards (forward direction only)
            const forwardStops = route.stopSequence.slice(currentIndex).map(String);
            
            // Rank forward stops by their importance
            const forwardStopsRanked = forwardStops
              .map(s => ({ stopId: s, ranking: rankingDataLoaded[s] || 0 }))
              .sort((a, b) => b.ranking - a.ranking);
            
            // Always include the last stop (destination)
            if (forwardStops.length > 0) {
              allMajorStops.add(forwardStops[forwardStops.length - 1]);
            }
            
            // Add up to 10 highest-ranked forward stops from this route
            forwardStopsRanked.slice(0, TARGET_MAJOR_STOPS).forEach(s => {
              allMajorStops.add(s.stopId);
            });
          });
          
          // Get all unique stops and order them (forward direction only)
          const allStops = getAllStopsFromRoutes(routesToUse, stopId);
          
          // Keep only stops that are in allMajorStops and maintain their order
          const majorStops = allStops.filter(s => allMajorStops.has(s));
          
          // Store stop route counts for label positioning
          const stopCounts = {};
          majorStops.forEach(s => {
            stopCounts[s] = stopRouteCount.get(s) || 0;
          });

          setRoutes(routesToUse);
          setOrderedStops(majorStops);
          setStopRouteCounts(stopCounts);
          setLoading(false);
        };

        window.onhashchange();
      })
      .catch((err) => {
        console.error('Error loading data:', err);
        setError(`Error loading data: ${err.message}`);
        setLoading(false);
      });
  }, []);

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

  // Calculate dynamic threshold for "major" stops
  // Major stops are those in the top 50% of ranking among displayed stops
  const displayedRankings = orderedStops
    .map((stopId) => rankingData[stopId] || 0)
    .sort((a, b) => b - a);
  const medianIndex = Math.floor(displayedRankings.length / 2);
  const majorStopThreshold = displayedRankings[medianIndex] || 0;

  // Calculate required height based on number of stops
  // Each stop needs ~70px vertical space, minimum 500px
  const stopCount = orderedStops.filter(stopId => stopId !== currentStopId).length;
  const requiredHeight = Math.max(500, stopCount * 70 + 100);

  return (
    <div style={{ '--route-height': `${requiredHeight}px` }}>
      <div class="diagram-header">
        <h1>
          <b>
            <span class="stop-tag">{currentStopId}</span> {currentStopName}
          </b>
        </h1>
      </div>

      <div class="diagram-container">
        <div class="diagram-wrapper">
          {/* Build map of stop positions for connecting lines */}
          {(() => {
            // Create smart position map based on route commonality (by stop name)
            const stopPosMap = createStopPositionMap(routes, orderedStops, currentStopId, stopsData);
            
            const stopPositions = {}; // stopId -> [{ routeIndex, position }]
            
            routes.forEach((route, routeIndex) => {
              const routeStopsInOrder = orderedStops.filter((stopId) => {
                if (stopId === currentStopId) return false;
                const stopIdNum = parseInt(stopId, 10);
                return route.stopSequence.includes(stopIdNum) || route.stopSequence.includes(stopId);
              });

              routeStopsInOrder.forEach((stopId) => {
                if (!stopPositions[stopId]) stopPositions[stopId] = [];
                const posData = stopPosMap[stopId] || { position: 50 };
                stopPositions[stopId].push({
                  routeIndex,
                  position: posData.position,
                });
              });
            });

            // Build name-based aggregation: stopName -> [{ routeIndex, position }]
            const namePositions = Object.keys(stopPositions).reduce((acc, stopId) => {
              const name = stopsData[stopId]?.[2] || stopId;
              (acc[name] ||= []).push(...stopPositions[stopId]);
              return acc;
            }, {});

            // Common names are those appearing in multiple routes
            const commonNames = Object.keys(namePositions).filter(
              name => namePositions[name].length > 1
            );

            return (
              <Fragment>
                {/* Route lines */}
                <div class="route-lines">
                  {routes.map((route, routeIndex) => {
                    const { routeId, stopSequence } = route;

                    const routeStopsInOrder = orderedStops.filter((stopId) => {
                      if (stopId === currentStopId) return false;
                      const stopIdNum = parseInt(stopId, 10);
                      return stopSequence.includes(stopIdNum) || stopSequence.includes(stopId);
                    });

                    if (routeStopsInOrder.length === 0) return null;

                    return (
                      <div key={`route-${routeIndex}`} class="route-line">
                        <div class="route-label" title={route.routeName}>
                          {routeId}
                        </div>
                        <div class="route-path">
                          {/* Route line spanning only from first to last stop */}
                          {(() => {
                            if (!routeStopsInOrder.length) return null;
                            // Get position of the last stop in the route
                            const minPos = 0;
                            
                            // Find the last stop that has a marker for this route (not a common stop)
                            // Common stops don't render individual markers per route, so we need to find
                            // the last non-common stop that will actually have a marker
                            let lastStopWithMarker = null;
                            for (let i = routeStopsInOrder.length - 1; i >= 0; i--) {
                              const stopId = routeStopsInOrder[i];
                              const stopName = stopsData[stopId]?.[2] || stopId;
                              const isCommon = namePositions[stopName] && namePositions[stopName].length > 1;
                              
                              if (!isCommon) {
                                lastStopWithMarker = stopId;
                                break;
                              }
                            }
                            
                            // If no non-common stop found, fall back to last stop in route
                            const lastStopId = lastStopWithMarker || routeStopsInOrder[routeStopsInOrder.length - 1];
                            const lastStopPos = (stopPosMap[lastStopId] || { position: 50 }).position;
                            
                            if (typeof lastStopPos !== 'number' || Number.isNaN(lastStopPos)) return null;
                            const maxPos = Math.min(100, lastStopPos);
                            const width = Math.max(0, maxPos - minPos);
                            return (
                              <div class="route-path-line" style={{ left: `${minPos}%`, width: `${width}%` }}></div>
                            );
                          })()}
                          
                          {/* Stop markers only (labels rendered separately). Hide per-route marker for common stops */}
                          {routeStopsInOrder.map((stopId) => {
                            const posData = stopPosMap[stopId] || { position: 50 };
                            const stopName = stopsData[stopId]?.[2] || stopId;
                            const isCommon = namePositions[stopName] && namePositions[stopName].length > 1;

                            if (isCommon) return null;

                            return (
                              <div
                                key={`stop-${routeIndex}-${stopId}`}
                                class="route-stop"
                                style={{ 
                                  left: `${posData.position}%`,
                                }}
                                data-stop-id={stopId}
                                data-route-index={routeIndex}
                              >
                                <div
                                  class={`stop-marker`}
                                  title={`${stopName}`}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Merged common stop markers layer */}
                <div class="merged-stop-markers">
                  {commonNames.map((stopName) => {
                    const positions = namePositions[stopName];
                    if (!positions || positions.length < 2) return null;

                    // Sort by route index and build contiguous segments
                    const sorted = [...positions].sort((a, b) => a.routeIndex - b.routeIndex);
                    const x = sorted[0].position;
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

                    return segments.map(([start, end], idx) => {
                      const y1 = (start.routeIndex * 72 + 100);
                      const y2 = (end.routeIndex * 72 + 100);
                      const top = y1 - 8; // encompass circle radius
                      const height = (y2 - y1) + 16;
                      return (
                        <div
                          key={`merged-marker-${stopName}-${idx}`}
                          class="merged-stop-marker"
                          style={{
                            left: `${x}%`,
                            top: `${top}px`,
                            height: `${height}px`,
                          }}
                          title={`${stopName}`}
                          data-stop-name={stopName}
                        />
                      );
                    });
                  })}
                </div>

                {/* Shared stop labels layer */}
                <div class="stop-labels-layer">
                  {(() => {
                    // Build label entries using positions from markers
                    const entries = Object.entries(namePositions).map(([name, positions]) => {
                      const isCommon = positions.length > 1;
                      let xPosition;
                      
                      if (isCommon) {
                        // For common stops, get x position from merged-stop-marker
                        // This matches the logic used for merged-stop-marker at line 876
                        const sorted = [...positions].sort((a, b) => a.routeIndex - b.routeIndex);
                        xPosition = sorted[0].position;
                      } else {
                        // For non-common stops, get x position from stop-marker
                        // Find any stopId with this name to get position from stopPosMap
                        const stopIdForName = Object.keys(stopPositions).find(
                          stopId => (stopsData[stopId]?.[2] || stopId) === name
                        );
                        const posData = stopIdForName ? (stopPosMap[stopIdForName] || { position: 50 }) : { position: 50 };
                        xPosition = posData.position;
                      }
                      
                      const avgIdx = positions.reduce((s, p) => s + p.routeIndex, 0) / positions.length;
                      const minIdx = positions.reduce((m, p) => Math.min(m, p.routeIndex), Infinity);
                      const useIdx = positions.length > 1 ? minIdx : avgIdx;
                      return {
                        stopName: name,
                        x: xPosition,
                        topPosition: useIdx * 72 + 48,
                        isCommon: isCommon,
                      };
                    }).sort((a, b) => a.x - b.x);

                    return entries.map((e) => {
                      return (
                        <div
                          key={`label-${e.stopName}`}
                          class={`shared-stop-label ${e.isCommon ? 'common' : ''}`}
                          style={{
                            left: `${e.x}%`,
                            top: `${e.topPosition}px`
                          }}
                          data-stop-name={e.stopName}
                        >
                          {e.stopName}
                        </div>
                      );
                    });
                  })()}
                </div>
              </Fragment>
            );
          })()}
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

