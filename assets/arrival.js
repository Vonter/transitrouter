import './i18n';

import { getCurrentCity } from './config';
import { getConfigForCity, getApiUrl } from './city-config';
import { normalizeName } from './utils/normalizeNames';
import {
  pointDistance,
  closestPointOnSegment,
  findClosestPointOnPolyline,
  cropPolylineFromPoint,
  decodePolylineCached,
} from './utils/geometry';
import { h, render, Fragment } from 'preact';
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
} from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import maplibregl from 'maplibre-gl';
import { toGeoJSON } from '@mapbox/polyline';

import Fuse from 'fuse.js';
import { encode } from './utils/specialID';
import fetchCache from './utils/fetchCache';
import { filterStaleArrivalsFromService } from './utils/fetchArrivals';
import setIcon from '../utils/setIcon';
import { stopMetrics } from './utils/metricsPage';

import ArrivalTimeText from './components/ArrivalTimeText';
import stopImagePath from './images/stop.png';
import stopEndImagePath from './images/stop-end.png';
import busSingleImagePath from './images/bus-single.svg';
import busDoubleImagePath from './images/bus-double.svg';
import busBendyImagePath from './images/bus-bendy.svg';
import busTinyImagePath from './images/bus-tiny-map.png';

// Constants
const city = getCurrentCity();
const cityConfig = getConfigForCity(city);
const dataPath = `/data/${city}`;
const DATA_PATHS = {
  stops: `${dataPath}/stops.min.json`,
  routes: `${dataPath}/routes.min.json`,
  services: `${dataPath}/services.min.json`,
  schedule: `https://data.transitrouter.vonter.in/${city}/schedule`,
};

const BUSES = {
  sd: { alt: 'Single deck bus', src: busSingleImagePath, width: 20 },
  dd: { alt: 'Double deck bus', src: busDoubleImagePath, width: 20 },
  bd: { alt: 'Bendy bus', src: busBendyImagePath, width: 26 },
};

const THRESHOLDS = {
  polylineMatch: 0.002, // ~222m
  stopProximity: 0.0045, // ~500m
  busAnimation: 3, // minutes
};

let routesDataCache = null;
let busIdCounter = 1;

// Capture the browser's install prompt as early as possible.
// We defer it so the bookmark button can trigger it later.
let _installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _installPrompt = e;
});

// Helper to decode polylines with caching
const decodePolyline = (encoded) => decodePolylineCached(encoded, toGeoJSON);

// Service utilities
const getServiceNo = (p) => (p && typeof p === 'object' ? p.serviceNo : p);
const toServiceNoStr = (no) => String(no);

// Use Set for O(1) lookup instead of O(n) array.some()
const getPinnedServiceNumbers = (pinnedServices) =>
  new Set(pinnedServices.map(getServiceNo).filter(Boolean).map(toServiceNoStr));

// Optimized isPinned that accepts pre-computed Set for O(1) lookup
const isPinnedSet = (no, pinnedSet) => pinnedSet.has(toServiceNoStr(no));

// Legacy isPinned for backward compatibility (O(n))
const isPinned = (no, pinnedServices) => {
  const noStr = toServiceNoStr(no);
  return pinnedServices.some((p) => toServiceNoStr(getServiceNo(p)) === noStr);
};

// Map utilities
const clearMapSource = (map, sourceId) => {
  const source = map?.getSource(sourceId);
  if (source) source.setData({ type: 'FeatureCollection', features: [] });
};

// Bus matching
const isSameBus = (b1, b2) =>
  b1.feature === b2.feature &&
  b1.type === b2.type &&
  b1.visit_number === b2.visit_number &&
  b1.origin_code === b2.origin_code &&
  b1.destination_code === b2.destination_code;

const isSameBuses = (b1, b2) =>
  b1.map((b) => b._id).join() === b2.map((b) => b._id).join();

// Display thresholds for progressive disclosure
const DISPLAY_LIMITS = {
  maxVisible: 6, // Maximum visible items before "+N more"
};

// Get max arrival time from city config (defaults to 24 hours)
const maxArrivalTime = cityConfig?.maxArrivalTime;

// Components
const Bus = ({
  maxPx,
  index,
  duration_ms,
  type,
  load,
  _ghost,
  _id,
  maxDuration_ms,
  isFirstFetch,
}) => {
  const busImage = BUSES[type.toLowerCase()];
  const prevPx = useRef();
  const scaleFactor =
    maxDuration_ms && maxDuration_ms > 0
      ? (maxPx - 30) / (maxDuration_ms / 1000 / 60)
      : duration_ms > 0
        ? 10
        : 2.5;
  const px = (duration_ms / 1000 / 60) * scaleFactor;
  const busTooFar = px > maxPx - 30;
  const pxFar = 90 + index * 2;
  const shouldAnimate = !isFirstFetch && prevPx.current !== undefined;

  useEffect(() => {
    prevPx.current = px;
  }, [px]);

  return (
    <span
      id={_id ? `bus-${_id}` : null}
      class={`bus ${_ghost ? 'ghost' : ''}`}
      style={{
        marginLeft: busTooFar ? pxFar + '%' : px.toFixed(1) + 'px',
        transitionDuration: shouldAnimate ? '1s' : '0s',
      }}
    >
      <span class="bus-float">
        <img {...busImage} />
        <br />
        <span class={`time time-${load.toLowerCase()}`}>
          <ArrivalTimeText ms={duration_ms} />
        </span>
      </span>
    </span>
  );
};

// "+N more" indicator component
const MoreIndicator = ({ count, expanded, onToggle }) => {
  if (count <= 0 && !expanded) return null;

  return (
    <span class="more-indicator" onClick={onToggle}>
      {expanded ? (
        <span class="more-collapse">−</span>
      ) : (
        <span class="more-count">+{count}</span>
      )}
    </span>
  );
};

const BusLane = ({ index, no, buses, maxDuration_ms, isFirstFetch }) => {
  const prevNo = useRef();
  const prevBuses = useRef();
  const busLaneRef = useRef();
  const [busLaneWidth, setBusLaneWidth] = useState(0);
  const [expanded, setExpanded] = useState(false);

  // Filter buses within maxArrivalTime
  const nextBuses = buses.filter(
    (nb) =>
      typeof nb?.duration_ms === 'number' && nb.duration_ms <= maxArrivalTime,
  );

  // Match buses with previous state for smooth transitions
  if (prevNo.current === no && !isSameBuses(prevBuses.current, nextBuses)) {
    nextBuses.forEach((nb) => delete nb._id);
    prevBuses.current
      .filter((b) => !b._ghost)
      .forEach((b, i) => {
        const latestNextBus = nextBuses.find((nb) => {
          if (nb._id || !isSameBus(b, nb)) return false;
          const d = (nb.duration_ms - b.duration_ms) / 1000 / 60;
          return d > -THRESHOLDS.busAnimation && d < THRESHOLDS.busAnimation;
        });
        if (latestNextBus) {
          latestNextBus._id = b._id;
        } else {
          b._ghost = true;
          nextBuses.splice(i, 0, b);
        }
      });
  }

  nextBuses.forEach((nb) => {
    if (!nb._id) nb._id = busIdCounter++;
  });

  useEffect(() => {
    prevNo.current = no;
    // Shallow copy is sufficient since we only need to compare bus properties
    // This is more efficient than structuredClone for simple objects
    prevBuses.current = nextBuses.map((bus) => ({ ...bus }));
  }, [no, nextBuses]);

  useLayoutEffect(() => {
    const el = busLaneRef.current;
    if (!el) return;
    const update = () => {
      const w = el.offsetWidth;
      if (w > 0) setBusLaneWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Filter out ghost buses for counting
  const visibleBuses = nextBuses.filter((b) => !b._ghost);
  const totalCount = visibleBuses.length;

  // Determine which buses to show (limit to maxVisible unless expanded)
  const hiddenCount = expanded
    ? 0
    : Math.max(0, totalCount - DISPLAY_LIMITS.maxVisible);
  const displayBuses = expanded
    ? nextBuses
    : nextBuses.slice(0, nextBuses.length - hiddenCount);

  const handleToggleExpand = (e) => {
    e.stopPropagation();
    setExpanded(!expanded);
  };

  return (
    <div
      class={`bus-lane ${expanded ? 'bus-lane-expanded' : ''}`}
      ref={busLaneRef}
    >
      {displayBuses.map((b, i) => (
        <Bus
          key={b._id}
          index={i}
          {...b}
          maxPx={busLaneWidth}
          maxDuration_ms={maxDuration_ms}
          isFirstFetch={isFirstFetch}
        />
      ))}
      {(hiddenCount > 0 || expanded) && (
        <MoreIndicator
          count={hiddenCount}
          expanded={expanded}
          onToggle={handleToggleExpand}
        />
      )}
      {index && <span class="visit-number">{index}</span>}
    </div>
  );
};

// Data conversion
const convertScheduleToArrival = (scheduleData) => {
  if (!scheduleData?.services) return [];

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const createTrip = (duration_ms, origin, destination) => ({
    duration_ms,
    type: 'SD',
    load: 'SEA',
    feature: 'WAB',
    visit_number: 1,
    origin_code: origin,
    destination_code: destination,
  });

  const allUpcomingTrips = [];
  scheduleData.services.forEach((service) => {
    const { no, origin, destination, trips } = service;
    trips.forEach((timeStr) => {
      // Optimized time parsing - avoid split/map for better performance
      const colonIdx = timeStr.indexOf(':');
      const hours = parseInt(timeStr.substring(0, colonIdx), 10);
      const minutes = parseInt(timeStr.substring(colonIdx + 1), 10);
      const tripMinutes = hours * 60 + minutes;
      const duration_ms = (tripMinutes - currentMinutes) * 60 * 1000;
      if (duration_ms > 0) {
        allUpcomingTrips.push({
          no,
          origin,
          destination,
          minutes: tripMinutes,
          duration_ms,
        });
      }
    });
  });

  const next50Trips = allUpcomingTrips
    .sort((a, b) => a.duration_ms - b.duration_ms)
    .slice(0, 50);
  const serviceMap = new Map();

  next50Trips.forEach((trip) => {
    const key = `${trip.no}-${trip.destination}`;
    if (!serviceMap.has(key)) {
      serviceMap.set(key, {
        no: trip.no,
        destination: trip.destination,
        trips: [],
      });
    }
    serviceMap.get(key).trips.push(trip);
  });

  return Array.from(serviceMap.values())
    .map((service) => {
      const sortedTrips = service.trips.sort((a, b) => a.minutes - b.minutes);
      // For static schedule mode, show next 10 arrivals
      const tripsToShow = sortedTrips.slice(0, 10);
      const result = {
        no: service.no,
        destination: service.destination,
        frequency: sortedTrips.length,
        arrivals: tripsToShow.map((trip) =>
          createTrip(trip.duration_ms, trip.origin, trip.destination),
        ),
      };
      return result;
    })
    .sort((a, b) => b.frequency - a.frequency);
};

// API functions
const fetchLiveArrivalData = async (stationId, signal) => {
  try {
    const response = await fetch(
      `${getApiUrl(cityConfig?.liveArrivals?.apiPath)}?stationid=${stationId}`,
      { signal },
    );
    if (!response.ok) {
      console.error(`Live arrival API error for ${city}:`, response.status);
      return null;
    }
    const result = await response.json();
    return result.services?.length > 0 ? result.services : null;
  } catch (error) {
    // Don't log AbortError (user cancellation)
    if (error.name !== 'AbortError') {
      console.error(`Live arrival API error for ${city}:`, error);
    }
    return null;
  }
};

// Route matching and rendering
// Find polylines passing through a stop and match by route name
const findMatchingPolyline = (
  serviceRoutes,
  stopCoords,
  routeName,
  servicesData,
  serviceNo,
  destinationCoords = null,
) => {
  if (!stopCoords || !routeName || !servicesData || !serviceNo) {
    return { bestPolyline: null, bestMatchIndex: -1 };
  }

  // Verify route name matches
  const serviceData = servicesData[serviceNo];
  if (!serviceData || serviceData.name !== routeName) {
    return { bestPolyline: null, bestMatchIndex: -1 };
  }

  const candidates = [];
  const allCandidates = []; // Track all polylines, even if outside threshold

  for (let index = 0; index < serviceRoutes.length; index++) {
    try {
      const geometry = decodePolyline(serviceRoutes[index]);
      if (geometry.type !== 'LineString' || !geometry.coordinates?.length)
        continue;

      const coords = geometry.coordinates;

      // Check if polyline passes through the current stop
      const closest = findClosestPointOnPolyline(stopCoords, coords);

      // Check direction: the destination should appear after the current stop
      // along the polyline (higher segment index = downstream).
      let isCorrectDirection = true;
      if (destinationCoords) {
        const destClosest = findClosestPointOnPolyline(
          destinationCoords,
          coords,
        );
        isCorrectDirection = destClosest.segmentIndex >= closest.segmentIndex;
      }

      const candidate = {
        index,
        geometry,
        distance: closest.distance,
        isCorrectDirection,
      };
      allCandidates.push(candidate);

      if (closest.distance < THRESHOLDS.stopProximity) {
        candidates.push(candidate);
      }
    } catch (e) {
      // Skip invalid polyline
    }
  }

  // Pick the best candidate: prefer correct direction, then smallest distance.
  const pickBest = (pool) => {
    const directional = pool.filter((c) => c.isCorrectDirection);
    const source = directional.length > 0 ? directional : pool;
    return source.reduce((best, current) =>
      current.distance < best.distance ? current : best,
    );
  };

  // Prefer polylines within proximity threshold
  if (candidates.length > 0) {
    const best = pickBest(candidates);
    return { bestPolyline: best.geometry, bestMatchIndex: best.index };
  }

  // Fallback: return closest polyline even if outside threshold
  if (allCandidates.length > 0) {
    const best = pickBest(allCandidates);
    return { bestPolyline: best.geometry, bestMatchIndex: best.index };
  }

  return { bestPolyline: null, bestMatchIndex: -1 };
};

const createRouteFeature = (serviceNo, destination, geometry, index) => ({
  type: 'Feature',
  id: encode(`${serviceNo}-${destination || ''}-${index}`),
  properties: { service: serviceNo, ...(destination && { destination }) },
  geometry,
});

// Create a point feature for a stop on a pinned route
const createStopFeature = (stopCode, coords, name, serviceNo) => ({
  type: 'Feature',
  id: encode(`stop-${serviceNo}-${stopCode}`),
  properties: { code: stopCode, name, service: serviceNo },
  geometry: { type: 'Point', coordinates: coords },
});

const renderPinnedRoutes = async (
  activePinnedServices,
  busStop,
  servicesData,
  stopsData,
) => {
  if (!routesDataCache) {
    routesDataCache = await fetchCache(DATA_PATHS.routes, 24 * 60);
  }

  const features = [];
  const currentStopCode = busStop?.code;
  const stopCoords = busStop ? [busStop.lng, busStop.lat] : null;

  for (const pinned of activePinnedServices) {
    const serviceNo = getServiceNo(pinned);
    const destination = pinned.destination;
    const serviceRoutes = routesDataCache?.[serviceNo];

    if (!Array.isArray(serviceRoutes) || serviceRoutes.length === 0) continue;

    // If destination and stop available, find matching polyline
    if (
      destination &&
      currentStopCode &&
      servicesData &&
      stopsData &&
      stopCoords
    ) {
      const serviceData = servicesData[serviceNo];
      if (!serviceData) {
        // Fallback: render all routes if service not found
        serviceRoutes.forEach((enc, index) => {
          features.push(
            createRouteFeature(serviceNo, null, decodePolyline(enc), index),
          );
        });
        continue;
      }

      // Try to find destination by ID first, then by name
      let destinationCode = destination;
      let destinationData = serviceData[destination];

      // If not found by ID, try to find by name
      if (!destinationData) {
        for (const [code, stopData] of Object.entries(stopsData)) {
          if (stopData?.[2] === destination) {
            destinationCode = code;
            destinationData = serviceData[code];
            break;
          }
        }
      }

      const routeVariations = Array.isArray(destinationData)
        ? destinationData
        : null;

      // Helper function to try route name matching
      const tryRouteNameMatching = () => {
        if (!serviceData.name) return false;

        // Resolve destination coordinates so findMatchingPolyline can prefer
        // the polyline whose shape goes *toward* the destination from this stop.
        const destStopData = destinationCode
          ? stopsData?.[destinationCode]
          : null;
        const destinationCoords = destStopData
          ? [destStopData[0], destStopData[1]]
          : null;

        const { bestPolyline, bestMatchIndex } = findMatchingPolyline(
          serviceRoutes,
          stopCoords,
          serviceData.name,
          servicesData,
          serviceNo,
          destinationCoords,
        );

        if (bestPolyline?.coordinates && bestMatchIndex >= 0) {
          const closest = findClosestPointOnPolyline(
            stopCoords,
            bestPolyline.coordinates,
          );

          if (closest.distance < THRESHOLDS.stopProximity) {
            const croppedCoordinates = cropPolylineFromPoint(
              bestPolyline.coordinates,
              closest.point,
              closest.segmentIndex,
            );

            if (croppedCoordinates.length >= 2) {
              features.push(
                createRouteFeature(
                  serviceNo,
                  destination,
                  {
                    type: 'LineString',
                    coordinates: croppedCoordinates,
                  },
                  bestMatchIndex,
                ),
              );
              return true;
            }
          } else {
            // Stop is too far from polyline, but still render the full polyline
            features.push(
              createRouteFeature(
                serviceNo,
                destination,
                bestPolyline,
                bestMatchIndex,
              ),
            );
            return true;
          }
        }
        return false;
      };

      if (routeVariations) {
        // Static schedule: destination found in servicesData with route variations
        // Use route name matching to find polyline passing through stop
        if (!tryRouteNameMatching()) {
          // No polyline found passing through stop - render all routes
          serviceRoutes.forEach((enc, index) => {
            features.push(
              createRouteFeature(serviceNo, null, decodePolyline(enc), index),
            );
          });
        }
      } else if (serviceData.name) {
        // Destination found but no route variations, or destination not found in servicesData
        // Try route name matching as fallback
        if (!tryRouteNameMatching()) {
          // No polyline found passing through stop - render all routes
          serviceRoutes.forEach((enc, index) => {
            features.push(
              createRouteFeature(serviceNo, null, decodePolyline(enc), index),
            );
          });
        }
      } else {
        // Fallback: render all routes if destination not found and no route name
        serviceRoutes.forEach((enc, index) => {
          features.push(
            createRouteFeature(serviceNo, null, decodePolyline(enc), index),
          );
        });
      }
    } else {
      // No destination/stop - render all routes
      serviceRoutes.forEach((enc, index) => {
        features.push(
          createRouteFeature(serviceNo, null, decodePolyline(enc), index),
        );
      });
    }
  }

  return features;
};

// Extract stop locations for pinned routes
const extractPinnedRouteStops = (
  activePinnedServices,
  busStop,
  servicesData,
  stopsData,
) => {
  const stopFeatures = [];
  const currentStopCode = busStop?.code;
  const addedStops = new Set(); // Avoid duplicate stops

  for (const pinned of activePinnedServices) {
    const serviceNo = getServiceNo(pinned);
    const destination = pinned.destination;
    const serviceData = servicesData?.[serviceNo];

    if (!serviceData) continue;

    // Try to find destination by ID first, then by name
    let destinationCode = destination;
    let destinationData = serviceData[destination];

    // If not found by ID, try to find by name
    if (!destinationData && stopsData) {
      for (const [code, stopData] of Object.entries(stopsData)) {
        if (stopData?.[2] === destination) {
          destinationCode = code;
          destinationData = serviceData[code];
          break;
        }
      }
    }

    // Get the route variations (array of stop code arrays)
    // destinationData is directly an array of route variations, not an object with a 'routes' property
    const routeVariations = Array.isArray(destinationData)
      ? destinationData
      : null;

    if (!routeVariations || !Array.isArray(routeVariations)) continue;

    // Find the route variation that contains the current stop
    let stopSequence = null;
    for (const variation of routeVariations) {
      if (Array.isArray(variation) && variation.includes(currentStopCode)) {
        stopSequence = variation;
        break;
      }
    }

    // If no variation contains current stop, use the first variation
    if (!stopSequence && routeVariations.length > 0) {
      stopSequence = routeVariations[0];
    }

    if (!Array.isArray(stopSequence)) continue;

    // Find the index of current stop and get stops from there onwards
    const currentStopIndex = stopSequence.indexOf(currentStopCode);
    const stopsToRender =
      currentStopIndex >= 0
        ? stopSequence.slice(currentStopIndex + 1) // Skip current stop, render remaining
        : stopSequence;

    // Create features for each stop
    for (const stopCode of stopsToRender) {
      const stopKey = `${serviceNo}-${stopCode}`;
      if (addedStops.has(stopKey)) continue;

      const stopData = stopsData?.[stopCode];
      if (!stopData) continue;

      const [lng, lat, name] = stopData;
      if (typeof lng !== 'number' || typeof lat !== 'number') continue;

      addedStops.add(stopKey);
      stopFeatures.push(
        createStopFeature(stopCode, [lng, lat], name, serviceNo),
      );
    }
  }

  return stopFeatures;
};

// Vehicle extraction
const extractVehicleLocation = (trip) => {
  let location =
    trip.location ||
    (trip.lat !== undefined && trip.lng !== undefined
      ? { lat: trip.lat, lng: trip.lng }
      : null);
  if (!location) return null;

  let lat, lng;
  if (Array.isArray(location)) {
    [lng, lat] = location;
  } else if (typeof location === 'object' && location !== null) {
    ({ lat, lng } = location);
  } else {
    return null;
  }

  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    isNaN(lat) ||
    isNaN(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180 ||
    (lat === 0 && lng === 0)
  ) {
    return null;
  }
  return { lat, lng };
};

const extractVehicles = (services, pinnedServiceNumbers) => {
  const vehicles = [];

  services.forEach((service) => {
    const serviceNoStr = toServiceNoStr(service.no);
    if (!pinnedServiceNumbers.has(serviceNoStr)) return;

    // Support both old format (next, next2, next3) and new format (arrivals array)
    const trips = service.arrivals || [
      service.next,
      service.next2,
      service.next3,
    ];
    trips.forEach((trip) => {
      if (!trip) return;
      const location = extractVehicleLocation(trip);
      if (!location) return;

      vehicles.push({
        vehicleId:
          trip.vehicle_id ||
          trip.vehicleId ||
          `vehicle-${serviceNoStr}-${trip.duration_ms}`,
        vehicleNumber:
          trip.bus_no || trip.busNo || trip.vehicleNumber || serviceNoStr,
        routeNo: serviceNoStr,
        location,
        heading: trip.heading || null,
      });
    });
  });

  return vehicles.map((vehicle, index) => ({
    type: 'Feature',
    id: vehicle.vehicleId || `vehicle-${index}`,
    properties: {
      vehicleNumber: vehicle.vehicleNumber,
      vehicleId: vehicle.vehicleId,
      routeNo: vehicle.routeNo,
      heading: vehicle.heading,
    },
    geometry: {
      type: 'Point',
      coordinates: [vehicle.location.lng, vehicle.location.lat],
    },
  }));
};

// Browser detection for install instructions
const detectBrowser = () => {
  const ua = navigator.userAgent;
  if (/Firefox/i.test(ua)) return 'firefox';
  if (
    /CriOS/i.test(ua) ||
    (/Chrome/i.test(ua) && !/Edg|SamsungBrowser/i.test(ua))
  )
    return 'chrome';
  if (/Safari/i.test(ua)) return 'safari';
  return 'chrome';
};

// Main component
function ArrivalTimes() {
  const { t, i18n } = useTranslation();
  const [busStop, setBusStop] = useState(null);
  const [stopsData, setStopsData] = useState(null);
  const [fetchServicesStatus, setFetchServicesStatus] = useState(null);
  const [fetchServicesError, setFetchServicesError] = useState(false);
  const [services, setServices] = useState(null);
  const [servicesData, setServicesData] = useState(null);
  const [pinnedServices, setPinnedServices] = useState(() => {
    try {
      const stored = localStorage.getItem(
        'transitrouter.arrival.pinnedServices',
      );
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => (typeof item === 'string' ? { serviceNo: item } : item))
        .filter(
          (item) => item?.serviceNo || (typeof item === 'object' && item),
        );
    } catch (e) {
      console.warn('Failed to parse pinned services from localStorage:', e);
      return [];
    }
  });
  const [followedVehicleId, setFollowedVehicleId] = useState(null);
  const [destFilter, setDestFilter] = useState(
    () => new URLSearchParams(window.location.search).get('dest') ?? '',
  );
  const [destFilterExact, setDestFilterExact] = useState(
    () => new URLSearchParams(window.location.search).get('destExact') === '1',
  );
  const [mapLoaded, setMapLoaded] = useState(false);
  const [showInstallSheet, setShowInstallSheet] = useState(false);
  const [installBrowser, setInstallBrowser] = useState(detectBrowser);
  const [isInstalled, setIsInstalled] = useState(
    () =>
      window.navigator.standalone ||
      window.matchMedia('(display-mode: standalone)').matches,
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    if (destFilter) {
      url.searchParams.set('dest', destFilter);
      if (destFilterExact) {
        url.searchParams.set('destExact', '1');
      } else {
        url.searchParams.delete('destExact');
      }
    } else {
      url.searchParams.delete('dest');
      url.searchParams.delete('destExact');
    }
    history.replaceState(null, '', url);
  }, [destFilter, destFilterExact]);

  // Sync destFilter into the uncontrolled input when it changes externally
  // (e.g. clicking a stop match header). Skip when the input is focused so
  // we don't overwrite what the user is currently typing.
  useEffect(() => {
    const input = destFilterInputRef.current;
    if (input && document.activeElement !== input) {
      input.value = destFilter;
    }
  }, [destFilter]);

  // When a stop loads, update the manifest link and page title for per-stop PWA install.
  // This runs whenever the stop or filter changes so the installed app opens to the right view.
  useEffect(() => {
    if (!busStop) return;
    const { code, name } = busStop;

    document.title = name;
    const appleTitle = document.querySelector(
      'meta[name="apple-mobile-web-app-title"]',
    );
    if (appleTitle) appleTitle.content = name;

    const params = new URLSearchParams({ name, code, city });
    if (destFilter) params.set('dest', destFilter);
    if (destFilterExact) params.set('destExact', '1');

    let manifestLink = document.querySelector('link[rel="manifest"]');
    if (!manifestLink) {
      manifestLink = document.createElement('link');
      manifestLink.rel = 'manifest';
      document.head.appendChild(manifestLink);
    }
    manifestLink.href = `/arrival/manifest.json?${params.toString()}`;
  }, [busStop, destFilter, destFilterExact]);

  // Track when the PWA is installed so we can update the button state.
  useEffect(() => {
    const onInstalled = () => {
      setIsInstalled(true);
      _installPrompt = null;
    };
    window.addEventListener('appinstalled', onInstalled);
    return () => window.removeEventListener('appinstalled', onInstalled);
  }, []);

  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const isFirstFetchRef = useRef(true);
  const vehicleLocationCache = useRef(new Map());
  const arrivalsTimeoutRef = useRef(null);
  const arrivalsRAFRef = useRef(null);
  const fetchAbortControllerRef = useRef(null);
  const destFilterInputRef = useRef(null);

  // On iOS, the keyboard overlaps content rather than resizing the viewport.
  // Use visualViewport to detect keyboard height and add matching padding-bottom
  // so the sticky header and table rows stay accessible above the keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const keyboardHeight = Math.max(
        0,
        window.innerHeight - vv.height - vv.offsetTop,
      );
      document.querySelector('main').style.paddingBottom =
        keyboardHeight > 0 ? `${keyboardHeight}px` : '';
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  // Load initial data
  useEffect(() => {
    (async () => {
      const [stops, services] = await Promise.all([
        fetchCache(DATA_PATHS.stops, 24 * 60),
        fetchCache(DATA_PATHS.services, 24 * 60),
      ]);
      setServicesData(services);
      setStopsData(stops);

      window.onhashchange = () => {
        let code = location.hash.replace(/^#/, '');
        const cityMatch = code.match(/^\/[A-Za-z]+\/(.+)$/);
        if (cityMatch) code = cityMatch[1];

        // Find stop using normalized name comparison if enabled
        const findStopCode = (searchCode) => {
          if (!searchCode) return null;
          // First try exact match
          if (stops[searchCode]) return searchCode;
          // Try normalized comparison
          const normalizedSearch = normalizeName(searchCode, city);
          for (const stopCode of Object.keys(stops)) {
            if (normalizeName(stopCode, city) === normalizedSearch) {
              return stopCode;
            }
          }
          return null;
        };

        const actualCode = findStopCode(code);
        if (actualCode) {
          const [lng, lat, name] = stops[actualCode];
          setBusStop({ code: actualCode, name, lat, lng });
          setIcon(actualCode);
          stopMetrics(city, actualCode, 'arrival');
        } else if (code) {
          alert(t('arrivals.invalidBusStopCode'));
        } else {
          setBusStop(null);
        }
      };
      window.onhashchange();
    })();
  }, [t]);

  // Update document title
  useEffect(() => {
    const cityConfig = getConfigForCity(city);
    const disableStopID = cityConfig?.disableStopID || false;

    const title = busStop?.code
      ? disableStopID
        ? t('arrivals.titleStop', {
            stopNumber:
              busStop.name + (busStop.suffix ? ` ${busStop.suffix}` : ''),
            stopName: '',
          }).replace(': ', '') // Remove the colon and space when no stopName
        : t('arrivals.titleStop', {
            stopNumber: busStop.code,
            stopName: busStop.name,
          })
      : t('arrivals.title');
    document.title = title;
    document
      .querySelector('[name="apple-mobile-web-app-title"]')
      ?.setAttribute('content', title);
  }, [busStop, i18n.resolvedLanguage, t]);

  // Fetch services with timeout fallback
  const scheduleRetry = (id, delay = 30000) => {
    arrivalsTimeoutRef.current = setTimeout(() => {
      // Skip polling when tab is hidden to save resources
      if (document.hidden) {
        // Reschedule for when tab becomes visible again
        const visibilityHandler = () => {
          if (!document.hidden) {
            document.removeEventListener('visibilitychange', visibilityHandler);
            arrivalsRAFRef.current = requestAnimationFrame(() =>
              fetchServices(id),
            );
          }
        };
        document.addEventListener('visibilitychange', visibilityHandler);
        return;
      }
      arrivalsRAFRef.current = requestAnimationFrame(() => fetchServices(id));
    }, delay);
  };

  const fetchScheduleFallback = (id) => {
    return fetchCache(`${DATA_PATHS.schedule}/${id}.json`, 60)
      .then((scheduleData) => {
        const convertedServices = convertScheduleToArrival(scheduleData);
        setFetchServicesStatus(
          convertedServices.length > 0 ? 'static' : 'error',
        );
        setServices(convertedServices.length > 0 ? convertedServices : []);
        isFirstFetchRef.current = false;
        scheduleRetry(id, 30000);
      })
      .catch((error) => {
        console.error('Fallback schedule fetch failed:', error);
        setFetchServicesStatus('error');
        setServices([]);
        isFirstFetchRef.current = false;
        scheduleRetry(id, 3000);
      });
  };

  const fetchServices = (id) => {
    if (!id || window._PAUSED) return;
    setFetchServicesStatus('loading');
    setFetchServicesError(false);

    // Abort any ongoing fetch
    if (fetchAbortControllerRef.current) {
      fetchAbortControllerRef.current.abort();
    }
    fetchAbortControllerRef.current = new AbortController();

    if (!cityConfig?.liveArrivals?.enabled) {
      fetchScheduleFallback(id);
      return;
    }

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT')), 10000);
    });

    const liveApiPromise = fetchLiveArrivalData(
      id,
      fetchAbortControllerRef.current.signal,
    );

    Promise.race([liveApiPromise, timeoutPromise])
      .then((liveServices) => {
        if (liveServices?.length > 0) {
          const filtered = liveServices
            .map(filterStaleArrivalsFromService)
            .filter((s) => s.next || (s.arrivals && s.arrivals.length > 0));
          setFetchServicesStatus('online');
          setFetchServicesError(false);
          setServices(filtered.length > 0 ? filtered : liveServices);
          isFirstFetchRef.current = false;
          scheduleRetry(id);
        } else {
          console.log('Live API returned no data');
          setFetchServicesError(false);
        }
      })
      .catch((error) => {
        if (error.name === 'AbortError') {
          setFetchServicesStatus(null);
          setFetchServicesError(false);
          return;
        }
        if (error.message === 'TIMEOUT') {
          console.log('Live API timeout (1s), falling back to static schedule');
        } else {
          console.log('Live API error, falling back to static schedule');
        }
        setFetchServicesError(true);
        fetchScheduleFallback(id);

        // Continue waiting for live API in background
        liveApiPromise
          .then((liveServices) => {
            if (liveServices?.length > 0) {
              console.log(
                'Live API response received, updating with live data',
              );
              setFetchServicesStatus('online');
              setFetchServicesError(false);
              setServices(liveServices);
              isFirstFetchRef.current = false;
              scheduleRetry(id);
            }
          })
          .catch(() => {});
      });
  };

  useEffect(() => {
    if (busStop) {
      isFirstFetchRef.current = true;
      fetchServices(busStop.code);
    }
    return () => {
      if (arrivalsTimeoutRef.current) clearTimeout(arrivalsTimeoutRef.current);
      if (arrivalsRAFRef.current) cancelAnimationFrame(arrivalsRAFRef.current);
    };
  }, [busStop]);

  // Initialize map
  useEffect(() => {
    if (!busStop || !mapContainer.current || mapRef.current) return;

    const { lat, lng, code } = busStop;
    const supportsTouch =
      'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: '/data/style.json',
      center: [lng, lat],
      zoom: 13,
      renderWorldCopies: false,
      boxZoom: false,
      attributionControl: false,
      dragRotate: false,
      touchPitch: false,
      pitchWithRotate: false,
      // Performance optimizations
      maxTileCacheSize: 50, // Smaller cache for arrival page (less map interaction)
      fadeDuration: supportsTouch ? 0 : 300, // Disable fade on touch devices
    });

    mapRef.current = map;
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-left',
    );

    map.on('load', () => {
      Promise.all([
        map
          .loadImage(stopImagePath)
          .then((img) => map.addImage('stop', img.data)),
        map
          .loadImage(stopEndImagePath)
          .then((img) => map.addImage('stop-end', img.data)),
        map
          .loadImage(busTinyImagePath)
          .then((img) => map.addImage('bus-tiny', img.data))
          .catch(() => {}),
      ]).then(() => {
        // Stop highlight
        map.addSource('stop-highlight', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                id: encode(code),
                properties: { number: code, name: busStop.name },
                geometry: { type: 'Point', coordinates: [lng, lat] },
              },
            ],
          },
        });

        map.addLayer({
          id: 'stop-highlight-icon',
          type: 'symbol',
          source: 'stop-highlight',
          layout: {
            'icon-image': 'stop-end',
            'icon-size': 0.5,
            'icon-anchor': 'bottom',
            'icon-allow-overlap': true,
            'text-field': ['format', ['get', 'name'], {}],
            'text-size': 14,
            'text-anchor': 'left',
            'text-offset': [1, 0],
            'text-font': ['Noto Sans Regular'],
            'text-optional': true,
          },
          paint: {
            'text-color': '#f01b48',
            'text-halo-width': 1,
            'text-halo-color': '#fff',
          },
        });

        // Pinned routes
        map.addSource('routes-pinned', {
          type: 'geojson',
          lineMetrics: true,
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addLayer(
          {
            id: 'routes-pinned',
            type: 'line',
            source: 'routes-pinned',
            layout: { 'line-cap': 'round' },
            paint: {
              'line-color': '#1a1a1a',
              'line-gradient': [
                'interpolate',
                ['linear'],
                ['line-progress'],
                0,
                '#1a1a1a',
                0.5,
                '#666666',
                1,
                '#1a1a1a',
              ],
              'line-opacity': [
                'interpolate',
                ['linear'],
                ['zoom'],
                12,
                0.9,
                16,
                0.4,
              ],
              'line-width': [
                'interpolate',
                ['linear'],
                ['zoom'],
                12,
                2,
                16,
                5,
                22,
                10,
              ],
            },
          },
          'stop-highlight-icon',
        );

        // Route stops (stops along pinned routes)
        map.addSource('route-stops', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addLayer(
          {
            id: 'route-stops',
            type: 'circle',
            source: 'route-stops',
            paint: {
              'circle-radius': [
                'interpolate',
                ['linear'],
                ['zoom'],
                12,
                3,
                16,
                5,
                20,
                8,
              ],
              'circle-color': '#1a1a1a',
              'circle-stroke-width': [
                'interpolate',
                ['linear'],
                ['zoom'],
                12,
                1,
                16,
                1.5,
              ],
              'circle-stroke-color': '#ffffff',
            },
          },
          'stop-highlight-icon',
        );

        // Route stop labels (shown at high zoom levels)
        map.addLayer(
          {
            id: 'route-stops-labels',
            type: 'symbol',
            source: 'route-stops',
            minzoom: 15,
            layout: {
              'text-field': ['get', 'name'],
              'text-size': 12,
              'text-font': ['Noto Sans Regular'],
              'text-anchor': 'left',
              'text-offset': [0.8, 0],
              'text-optional': true,
              'text-max-width': 10,
            },
            paint: {
              'text-color': '#1a1a1a',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.5,
            },
          },
          'stop-highlight-icon',
        );

        // Vehicles
        map.addSource('buses-service', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addLayer({
          id: 'buses-service',
          type: 'symbol',
          source: 'buses-service',
          minzoom: 4,
          layout: {
            'icon-image': 'bus-tiny',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-size': ['step', ['zoom'], 0.5, 14, 0.6, 15, 0.7, 16, 0.8],
            'text-field': ['get', 'vehicleNumber'],
            'text-optional': true,
            'text-size': [
              'interpolate',
              ['linear'],
              ['zoom'],
              12,
              12,
              14,
              14,
              16,
              16,
            ],
            'text-font': ['Noto Sans Regular'],
            'text-variable-anchor': ['left', 'right', 'bottom', 'top'],
            'text-justify': 'auto',
            'text-offset': [0.5, 1],
            'text-padding': 4,
          },
          paint: {
            'text-color': '#000',
            'text-halo-color': '#fff',
            'text-halo-width': 2,
          },
        });

        map.on('click', 'buses-service', (e) => {
          const feat = e.features?.[0];
          const vid = feat?.id || feat?.properties?.vehicleId;
          if (vid) {
            setFollowedVehicleId(vid);
            const [lng, lat] = feat.geometry.coordinates;
            map.easeTo({ center: [lng, lat], duration: 600 });
          }
        });

        setMapLoaded(true);
      });
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      setMapLoaded(false);
    };
  }, [busStop]);

  // Render pinned routes and stops
  useEffect(() => {
    const map = mapRef.current;
    const routesSource = map?.getSource('routes-pinned');
    const stopsSource = map?.getSource('route-stops');
    if (!map || !routesSource) return;

    (async () => {
      try {
        const activePinnedServices = (pinnedServices || []).filter((pinned) => {
          const serviceNoStr = toServiceNoStr(getServiceNo(pinned));
          return services?.some((s) => toServiceNoStr(s.no) === serviceNoStr);
        });

        if (!activePinnedServices.length) {
          clearMapSource(map, 'routes-pinned');
          if (stopsSource) clearMapSource(map, 'route-stops');
          return;
        }

        const features = await renderPinnedRoutes(
          activePinnedServices,
          busStop,
          servicesData,
          stopsData,
        );
        routesSource.setData({ type: 'FeatureCollection', features });

        // Render stops along pinned routes
        if (stopsSource && servicesData && stopsData) {
          const stopFeatures = extractPinnedRouteStops(
            activePinnedServices,
            busStop,
            servicesData,
            stopsData,
          );
          stopsSource.setData({
            type: 'FeatureCollection',
            features: stopFeatures,
          });
        }
      } catch (e) {
        console.error('Failed to render pinned routes', e);
        clearMapSource(map, 'routes-pinned');
        if (stopsSource) clearMapSource(map, 'route-stops');
      }
    })();
  }, [pinnedServices, services, busStop, servicesData, stopsData, mapLoaded]);

  // Render vehicles
  useEffect(() => {
    const map = mapRef.current;
    const vehiclesSource = map?.getSource('buses-service');
    if (!map || !vehiclesSource || !services || !pinnedServices?.length) {
      if (map && vehiclesSource) clearMapSource(map, 'buses-service');
      return;
    }

    const pinnedServiceNumbers = getPinnedServiceNumbers(pinnedServices);
    const features = extractVehicles(services, pinnedServiceNumbers);
    vehiclesSource.setData({ type: 'FeatureCollection', features });

    // Clean up vehicle cache
    for (const [vehicleId] of vehicleLocationCache.current.entries()) {
      const belongsToPinned = Array.from(pinnedServiceNumbers).some(
        (serviceNo) =>
          vehicleId.includes(serviceNo) ||
          vehicleId.startsWith(`vehicle-${serviceNo}-`),
      );
      if (!belongsToPinned) {
        vehicleLocationCache.current.delete(vehicleId);
      }
    }
  }, [pinnedServices, services, mapLoaded]);

  // Follow vehicle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !followedVehicleId || !services) return;

    let vehicleLocation = null;
    for (const service of services) {
      // Support both old format (next, next2, next3) and new format (arrivals array)
      const trips = service.arrivals || [
        service.next,
        service.next2,
        service.next3,
      ];
      for (const trip of trips) {
        if (!trip?.location) continue;
        const tripVehicleId =
          trip.vehicle_id ||
          trip.vehicleId ||
          `vehicle-${service.no}-${trip.duration_ms}`;
        if (
          tripVehicleId === followedVehicleId ||
          `vehicle-${tripVehicleId}` === followedVehicleId
        ) {
          vehicleLocation = trip.location;
          break;
        }
      }
      if (vehicleLocation) break;
    }

    if (
      vehicleLocation?.lng &&
      typeof vehicleLocation.lng === 'number' &&
      typeof vehicleLocation.lat === 'number'
    ) {
      map.easeTo({
        center: [vehicleLocation.lng, vehicleLocation.lat],
        duration: 800,
      });
    }
  }, [followedVehicleId, services]);

  // Toggle pin
  const togglePin = (no, destination = null) => {
    if (!destination && services) {
      const service = services.find((s) => s.no === no);
      destination =
        service?.destination || service?.next?.destination_code || null;
    }

    const serviceNoStr = toServiceNoStr(no);
    const pinnedIndex = pinnedServices.findIndex(
      (p) => toServiceNoStr(getServiceNo(p)) === serviceNoStr,
    );
    const updatedPinned =
      pinnedIndex >= 0
        ? pinnedServices.filter((_, i) => i !== pinnedIndex)
        : [...pinnedServices, { serviceNo: no, destination }];

    if (pinnedIndex >= 0) {
      for (const [vehicleId] of vehicleLocationCache.current.entries()) {
        if (
          vehicleId.includes(serviceNoStr) ||
          vehicleId.startsWith(`vehicle-${serviceNoStr}-`)
        ) {
          vehicleLocationCache.current.delete(vehicleId);
        }
      }
    }

    setPinnedServices(updatedPinned);
    try {
      localStorage.setItem(
        'transitrouter.arrival.pinnedServices',
        JSON.stringify(updatedPinned),
      );
    } catch (e) {}
  };

  // Pre-compute pinned set for O(1) lookups during sorting
  const pinnedSet = useMemo(
    () => getPinnedServiceNumbers(pinnedServices),
    [pinnedServices],
  );

  // Group services - separated grouping from sorting for better performance
  const { groupedServices, maxDuration_ms } = useMemo(() => {
    if (!services) return { groupedServices: [], maxDuration_ms: 0 };

    const groups = {};
    let maxDuration = 0;

    services.forEach((service) => {
      // Support both old format (next, next2, next3) and new format (arrivals array)
      const arrivals = service.arrivals || [
        service.next,
        service.next2,
        service.next3,
      ];
      const firstArrival = arrivals.find(Boolean);
      const key = `${service.no}-${service.destination || firstArrival?.destination_code || ''}`;
      if (!groups[key]) {
        groups[key] = {
          no: service.no,
          destination: service.destination || firstArrival?.destination_code,
          frequency: 0,
          buses: [],
        };
      }
      arrivals.filter(Boolean).forEach((bus) => {
        groups[key].buses.push(bus);
        if (bus.duration_ms && bus.duration_ms > maxDuration) {
          maxDuration = bus.duration_ms;
        }
      });
      groups[key].frequency += service.frequency || 0;
    });

    // Use pre-computed Set for O(1) isPinned checks
    const sorted = Object.values(groups).sort((a, b) => {
      const aPinned = isPinnedSet(a.no, pinnedSet);
      const bPinned = isPinnedSet(b.no, pinnedSet);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return b.frequency - a.frequency;
    });

    return { groupedServices: sorted, maxDuration_ms: maxDuration };
  }, [services, pinnedSet]);

  // Build a Fuse index over all downstream stop names for this stop.
  // Rebuilt only when the set of routes or stop data changes (not on every filter keystroke).
  const destFuse = useMemo(() => {
    if (!servicesData || !busStop || !stopsData) return null;
    const names = new Set();
    groupedServices.forEach(({ no, destination }) => {
      const serviceData = servicesData[no];
      if (!serviceData) return;
      let downstreamStops = null;
      const exactVariations = destination ? serviceData[destination] : null;
      if (exactVariations) {
        for (const route of exactVariations) {
          const idx = route.indexOf(busStop.code);
          if (idx !== -1) {
            downstreamStops = route.slice(idx + 1);
            break;
          }
        }
      }
      if (!downstreamStops) {
        outer: for (const [destCode, variations] of Object.entries(
          serviceData,
        )) {
          if (destCode === 'name' || !Array.isArray(variations)) continue;
          for (const route of variations) {
            const idx = route.indexOf(busStop.code);
            if (idx !== -1) {
              downstreamStops = route.slice(idx + 1);
              break outer;
            }
          }
        }
      }
      if (!downstreamStops) return;
      downstreamStops.forEach((stopId) => {
        const n = stopsData[stopId]?.[2];
        if (n) names.add(n);
      });
    });
    return new Fuse(Array.from(names), { threshold: 0.35 });
  }, [groupedServices, servicesData, stopsData, busStop]);

  // When filter is active: groups arrival rows by which downstream stop name matched.
  // Each row may appear under multiple matching stop names.
  // Returns { matchingStopGroups: [...] } when filter active, or { flatGroups: [...] } otherwise.
  const filteredGroupedServices = useMemo(() => {
    if (
      !destFilter.trim() ||
      !servicesData ||
      !busStop ||
      !stopsData ||
      !destFuse
    ) {
      return { matchingStopGroups: null, flatGroups: groupedServices };
    }

    const fuzzyMatches = destFilterExact
      ? new Set([destFilter.trim()])
      : new Set(destFuse.search(destFilter).map((r) => r.item));
    if (fuzzyMatches.size === 0) {
      return { matchingStopGroups: [], flatGroups: null };
    }

    const stopNameToGroups = new Map();

    groupedServices.forEach((group) => {
      const { no, destination } = group;
      const serviceData = servicesData[no];
      if (!serviceData) return;
      // Step 1: Try exact destination key
      let downstreamStops = null;
      const exactVariations = destination ? serviceData[destination] : null;
      if (exactVariations) {
        for (const route of exactVariations) {
          const idx = route.indexOf(busStop.code);
          if (idx !== -1) {
            downstreamStops = route.slice(idx + 1);
            break;
          }
        }
      }

      // Step 2: Fallback — scan all destinations for a route containing busStop.code
      if (!downstreamStops) {
        outer: for (const [destCode, variations] of Object.entries(
          serviceData,
        )) {
          if (destCode === 'name' || !Array.isArray(variations)) continue;
          for (const route of variations) {
            const idx = route.indexOf(busStop.code);
            if (idx !== -1) {
              downstreamStops = route.slice(idx + 1);
              break outer;
            }
          }
        }
      }

      if (!downstreamStops || downstreamStops.length === 0) return;

      const matchedStopNames = new Set();
      downstreamStops.forEach((stopId) => {
        const stopName = stopsData[stopId]?.[2];
        if (
          stopName &&
          fuzzyMatches.has(stopName) &&
          !matchedStopNames.has(stopName)
        ) {
          matchedStopNames.add(stopName);
          if (!stopNameToGroups.has(stopName)) {
            stopNameToGroups.set(stopName, []);
          }
          stopNameToGroups.get(stopName).push(group);
        }
      });
    });

    return {
      matchingStopGroups: Array.from(stopNameToGroups.entries())
        .map(([stopName, groups]) => ({ stopName, groups }))
        .sort((a, b) => b.groups.length - a.groups.length),
      flatGroups: null,
    };
  }, [
    groupedServices,
    destFilter,
    destFilterExact,
    servicesData,
    stopsData,
    busStop,
    destFuse,
  ]);

  if (!busStop) {
    if (stopsData) {
      return (
        <ul class="stops-list">
          {Object.keys(stopsData).map((stop) => (
            <li key={stop}>
              <a href={`#${stop}`}>{stopsData[stop][2]}</a>
            </li>
          ))}
        </ul>
      );
    }
    return null;
  }

  const { code, name } = busStop;

  const handleInstall = () => {
    if (_installPrompt) {
      _installPrompt.prompt();
      _installPrompt.userChoice.then((choice) => {
        if (choice.outcome === 'accepted') setIsInstalled(true);
        _installPrompt = null;
      });
    } else {
      setShowInstallSheet(true);
    }
  };

  return (
    <div>
      <div id="bus-stop-map" ref={mapContainer}></div>
      <h1>
        <div class="stop-heading-row">
          <span class="stop-heading-name">
            {t('arrivals.preHeading')}
            <b id="bus-stop-name">
              {(() => {
                const cityConfig = getConfigForCity(city);
                const disableStopID = cityConfig?.disableStopID || false;

                if (disableStopID) {
                  return (
                    <>
                      {name}
                      {busStop.suffix && (
                        <span class="stop-suffix"> {busStop.suffix}</span>
                      )}
                    </>
                  );
                } else {
                  return (
                    <>
                      <span class={`stop-tag ${fetchServicesStatus}`}>
                        {code}
                      </span>{' '}
                      {name}
                    </>
                  );
                }
              })()}
            </b>
          </span>
          <span class="stop-heading-controls">
            {(fetchServicesStatus === 'loading' || fetchServicesError) && (
              <span
                class={`live-data-loading-container ${fetchServicesError ? 'error' : ''}`}
                title={
                  fetchServicesError
                    ? 'Live data unavailable. Estimated based on timetable schedule.'
                    : 'Fetching live information'
                }
                onClick={(e) => {
                  e.stopPropagation();
                  const container = e.currentTarget;
                  container.classList.toggle('show-tooltip');
                  const closeTooltip = (event) => {
                    if (!container.contains(event.target)) {
                      container.classList.remove('show-tooltip');
                      document.removeEventListener('click', closeTooltip);
                    }
                  };
                  setTimeout(() => {
                    document.addEventListener('click', closeTooltip);
                  }, 0);
                }}
              >
                {fetchServicesError ? (
                  <span class="live-data-warning">⚠</span>
                ) : (
                  <span class="live-data-loading" />
                )}
              </span>
            )}
            <button
              class={`bookmark-btn${isInstalled ? ' installed' : ''}`}
              onClick={handleInstall}
              title="Add to Home Screen"
            >
              {isInstalled ? (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
              )}
            </button>
          </span>
        </div>
        <div class="dest-filter-row">
          <svg
            class="dest-filter-icon"
            viewBox="0 0 20 20"
            fill="currentColor"
            width="16"
            height="16"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
              clip-rule="evenodd"
            />
          </svg>
          <div class="dest-filter-input-wrapper">
            <input
              type="search"
              class="dest-filter"
              placeholder="Search for stop…"
              ref={destFilterInputRef}
              defaultValue={destFilter}
              onInput={(e) => {
                setDestFilter(e.target.value);
                setDestFilterExact(false);
              }}
            />
            {destFilter && (
              <button
                class="dest-filter-clear"
                onClick={() => {
                  setDestFilter('');
                  setDestFilterExact(false);
                }}
                aria-label="Clear search"
              >
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  width="16"
                  height="16"
                >
                  <path
                    fill-rule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clip-rule="evenodd"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </h1>
      {showInstallSheet && (
        <div
          class="install-sheet-backdrop"
          onClick={() => setShowInstallSheet(false)}
        >
          <div class="install-sheet" onClick={(e) => e.stopPropagation()}>
            <p class="install-sheet-title">
              Save live tracking for <strong>{name}</strong> to Home Screen
            </p>
            <div class="install-browser-tabs">
              {['chrome', 'safari', 'firefox'].map((b) => (
                <button
                  key={b}
                  class={`install-browser-tab${installBrowser === b ? ' active' : ''}`}
                  onClick={() => setInstallBrowser(b)}
                >
                  {b.charAt(0).toUpperCase() + b.slice(1)}
                </button>
              ))}
            </div>
            {installBrowser === 'safari' && (
              <ol class="install-sheet-steps">
                <li>
                  Tap the <strong>Share</strong> button{' '}
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    width="16"
                    height="16"
                    style="vertical-align: middle"
                  >
                    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                    <polyline points="16 6 12 2 8 6" />
                    <line x1="12" y1="2" x2="12" y2="15" />
                  </svg>{' '}
                  at the bottom of the screen
                </li>
                <li>
                  Tap <strong>Add to Home Screen</strong>
                </li>
                <li>
                  Tap <strong>Add</strong>
                </li>
              </ol>
            )}
            {installBrowser === 'chrome' && (
              <ol class="install-sheet-steps">
                <li>
                  Tap the <strong>⋮</strong>
                </li>
                <li>
                  Tap <strong>Add to Home Screen</strong>
                </li>
                <li>
                  Tap <strong>Add</strong>
                </li>
              </ol>
            )}
            {installBrowser === 'firefox' && (
              <ol class="install-sheet-steps">
                <li>
                  Tap the <strong>⋮</strong>
                </li>
                <li>
                  Tap <strong>Install</strong>
                </li>
                <li>
                  Tap <strong>Add</strong>
                </li>
              </ol>
            )}
            <button
              class="install-sheet-close"
              onClick={() => setShowInstallSheet(false)}
            >
              Done
            </button>
          </div>
        </div>
      )}
      <table>
        {services ? (
          (() => {
            const renderGroupRow = (group) => {
              const { no, destination, buses } = group;
              const pinned = isPinned(no, pinnedServices);
              const sortedBuses = [...buses].sort(
                (a, b) => a.duration_ms - b.duration_ms,
              );
              const buses1 = sortedBuses.filter((b) => b?.visit_number === 1);
              const buses2 = sortedBuses.filter((b) => b?.visit_number === 2);
              return (
                <Fragment key={`${no}-${destination}`}>
                  <tr
                    class={pinned ? 'pin' : ''}
                    onClick={(e) => {
                      e.preventDefault();
                      togglePin(no, destination);
                    }}
                  >
                    <th>{no}</th>
                    <td
                      class={`bus-lane-cell ${buses2.length ? 'multiple' : ''}`}
                    >
                      {buses2.length ? (
                        <>
                          <BusLane
                            index={1}
                            no={no}
                            buses={buses1}
                            maxDuration_ms={maxDuration_ms}
                            isFirstFetch={isFirstFetchRef.current}
                          />
                          <BusLane
                            index={2}
                            no={no}
                            buses={buses2}
                            maxDuration_ms={maxDuration_ms}
                            isFirstFetch={isFirstFetchRef.current}
                          />
                        </>
                      ) : (
                        <BusLane
                          no={no}
                          buses={sortedBuses}
                          maxDuration_ms={maxDuration_ms}
                          isFirstFetch={isFirstFetchRef.current}
                        />
                      )}
                    </td>
                  </tr>
                  <tr class={pinned ? 'pin' : ''}>
                    <th colspan="2">
                      <small class="destination">
                        {(destination && stopsData[destination]?.[2]) ||
                          destination ||
                          ''}
                      </small>
                    </th>
                  </tr>
                </Fragment>
              );
            };

            const { matchingStopGroups, flatGroups } = filteredGroupedServices;

            if (matchingStopGroups !== null) {
              if (matchingStopGroups.length === 0) {
                return (
                  <tbody>
                    <tr>
                      <td class="blank">
                        {fetchServicesError
                          ? `No buses operate from ${name} towards "${destFilter}"`
                          : `No buses arriving at ${name} towards "${destFilter}"`}
                      </td>
                    </tr>
                  </tbody>
                );
              }

              const groupHasETA = (group) =>
                group.buses.some(
                  (b) =>
                    typeof b?.duration_ms === 'number' &&
                    b.duration_ms <= maxArrivalTime,
                );

              const renderStopHeader = (stopName) => (
                <tr class="stop-match-header">
                  <th
                    colspan="2"
                    onClick={() => {
                      setDestFilter(stopName);
                      setDestFilterExact(true);
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    {stopName}
                  </th>
                </tr>
              );

              return (
                <tbody>
                  {matchingStopGroups.map(({ stopName, groups }) => {
                    const withETA = groups.filter(groupHasETA);
                    return withETA.length > 0 ? (
                      <Fragment key={`${stopName}-eta`}>
                        {renderStopHeader(stopName)}
                        {withETA.map(renderGroupRow)}
                      </Fragment>
                    ) : null;
                  })}
                  {matchingStopGroups.map(({ stopName, groups }) => {
                    const withoutETA = groups.filter((g) => !groupHasETA(g));
                    return withoutETA.length > 0 ? (
                      <Fragment key={`${stopName}-noeta`}>
                        {renderStopHeader(stopName)}
                        {withoutETA.map(renderGroupRow)}
                      </Fragment>
                    ) : null;
                  })}
                </tbody>
              );
            }

            return flatGroups.length ? (
              <tbody>{flatGroups.map(renderGroupRow)}</tbody>
            ) : (
              <tbody>
                <tr>
                  <td class="blank">No upcoming arrivals.</td>
                </tr>
              </tbody>
            );
          })()
        ) : (
          <tbody class="loading">
            <tr>
              <td>Loading&hellip;</td>
            </tr>
          </tbody>
        )}
      </table>
    </div>
  );
}

const $arrivals = document.getElementById('arrivals');
render(<ArrivalTimes />, $arrivals);
