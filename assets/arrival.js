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

import { encode } from './utils/specialID';
import fetchCache from './utils/fetchCache';
import setIcon from '../utils/setIcon';
import { stopMetrics } from './utils/metricsPage';

import ArrivalTimeText from './components/ArrivalTimeText';
import stopImagePath from './images/stop.png';
import stopEndImagePath from './images/stop-end.png';
import busSingleImagePath from './images/bus-single.svg';
import busDoubleImagePath from './images/bus-double.svg';
import busBendyImagePath from './images/bus-bendy.svg';
import busTinyImagePath from './images/bus-tiny.png';

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

const BusLane = ({ index, no, buses, maxDuration_ms, isFirstFetch }) => {
  const prevNo = useRef();
  const prevBuses = useRef();
  const busLaneRef = useRef();
  const [busLaneWidth, setBusLaneWidth] = useState(0);
  const nextBuses = buses.filter((nb) => typeof nb?.duration_ms === 'number');

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
    setBusLaneWidth(busLaneRef.current?.offsetWidth);
  }, []);

  return (
    <div class="bus-lane" ref={busLaneRef}>
      {nextBuses.map((b, i) => (
        <Bus
          key={b._id}
          index={i}
          {...b}
          maxPx={busLaneWidth}
          maxDuration_ms={maxDuration_ms}
          isFirstFetch={isFirstFetch}
        />
      ))}
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
      const result = {
        no: service.no,
        destination: service.destination,
        frequency: sortedTrips.length,
        next: createTrip(
          sortedTrips[0].duration_ms,
          sortedTrips[0].origin,
          sortedTrips[0].destination,
        ),
      };
      if (sortedTrips[1])
        result.next2 = createTrip(
          sortedTrips[1].duration_ms,
          sortedTrips[1].origin,
          sortedTrips[1].destination,
        );
      if (sortedTrips[2])
        result.next3 = createTrip(
          sortedTrips[2].duration_ms,
          sortedTrips[2].origin,
          sortedTrips[2].destination,
        );
      return result;
    })
    .sort((a, b) => b.frequency - a.frequency);
};

// API functions
const fetchLiveArrivalData = async (stationId) => {
  try {
    const response = await fetch(
      `${getApiUrl(cityConfig?.liveArrivals?.apiPath)}?stationid=${stationId}`,
    );
    if (!response.ok) {
      console.error(`Live arrival API error for ${city}:`, response.status);
      return null;
    }
    const result = await response.json();
    return result.services?.length > 0 ? result.services : null;
  } catch (error) {
    console.error(`Live arrival API error for ${city}:`, error);
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
      allCandidates.push({
        index,
        geometry,
        distance: closest.distance,
      });

      if (closest.distance < THRESHOLDS.stopProximity) {
        candidates.push({
          index,
          geometry,
          distance: closest.distance,
        });
      }
    } catch (e) {
      // Skip invalid polyline
    }
  }

  // Prefer polylines within proximity threshold
  if (candidates.length > 0) {
    const best = candidates.reduce((best, current) =>
      current.distance < best.distance ? current : best,
    );
    return {
      bestPolyline: best.geometry,
      bestMatchIndex: best.index,
    };
  }

  // Fallback: return closest polyline even if outside threshold
  if (allCandidates.length > 0) {
    const best = allCandidates.reduce((best, current) =>
      current.distance < best.distance ? current : best,
    );
    return {
      bestPolyline: best.geometry,
      bestMatchIndex: best.index,
    };
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

      const routeVariations =
        destinationData?.routes ||
        (Array.isArray(destinationData) ? destinationData : null);

      // Helper function to try route name matching
      const tryRouteNameMatching = () => {
        if (!serviceData.name) return false;

        const { bestPolyline, bestMatchIndex } = findMatchingPolyline(
          serviceRoutes,
          stopCoords,
          serviceData.name,
          servicesData,
          serviceNo,
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
    const routeVariations =
      destinationData?.routes ||
      (Array.isArray(destinationData) ? destinationData : null);

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

    [service.next, service.next2, service.next3].forEach((trip) => {
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

// Main component
function ArrivalTimes() {
  const { t, i18n } = useTranslation();
  const [busStop, setBusStop] = useState(null);
  const [stopsData, setStopsData] = useState(null);
  const [fetchServicesStatus, setFetchServicesStatus] = useState(null);
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

  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const isFirstFetchRef = useRef(true);
  const vehicleLocationCache = useRef(new Map());
  const arrivalsTimeoutRef = useRef(null);
  const arrivalsRAFRef = useRef(null);

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
    const title = busStop?.code
      ? t('arrivals.titleStop', {
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

    if (!cityConfig?.liveArrivals?.enabled) {
      fetchScheduleFallback(id);
      return;
    }

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT')), 10000);
    });

    const liveApiPromise = fetchLiveArrivalData(id);

    Promise.race([liveApiPromise, timeoutPromise])
      .then((liveServices) => {
        if (liveServices?.length > 0) {
          setFetchServicesStatus('online');
          setServices(liveServices);
          isFirstFetchRef.current = false;
          scheduleRetry(id);
        } else {
          console.log(
            'Live API returned no data, falling back to static schedule',
          );
          fetchScheduleFallback(id);
        }
      })
      .catch((error) => {
        if (error.message === 'TIMEOUT') {
          console.log('Live API timeout (1s), falling back to static schedule');
        } else {
          console.log('Live API error, falling back to static schedule');
        }
        fetchScheduleFallback(id);

        // Continue waiting for live API in background
        liveApiPromise
          .then((liveServices) => {
            if (liveServices?.length > 0) {
              console.log(
                'Live API response received, updating with live data',
              );
              setFetchServicesStatus('online');
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
            'icon-size': ['step', ['zoom'], 0.3, 14, 0.35, 15, 0.45, 16, 0.55],
            'text-field': ['get', 'vehicleNumber'],
            'text-optional': true,
            'text-size': [
              'interpolate',
              ['linear'],
              ['zoom'],
              12,
              8,
              14,
              10,
              16,
              12,
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
      });
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
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
  }, [pinnedServices, services, busStop, servicesData, stopsData]);

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
  }, [pinnedServices, services]);

  // Follow vehicle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !followedVehicleId || !services) return;

    let vehicleLocation = null;
    for (const service of services) {
      for (const trip of [service.next, service.next2, service.next3]) {
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
      const key = `${service.no}-${service.destination || service.next?.destination_code || ''}`;
      if (!groups[key]) {
        groups[key] = {
          no: service.no,
          destination: service.destination || service.next?.destination_code,
          frequency: 0,
          buses: [],
        };
      }
      [service.next, service.next2, service.next3]
        .filter(Boolean)
        .forEach((bus) => {
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

  return (
    <div>
      <div id="bus-stop-map" ref={mapContainer}></div>
      <h1>
        {t('arrivals.preHeading')}
        <b id="bus-stop-name">
          <span class={`stop-tag ${fetchServicesStatus}`}>{code}</span> {name}
        </b>
      </h1>
      <table>
        {services ? (
          groupedServices.length ? (
            <tbody>
              {groupedServices.map((group) => {
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
              })}
            </tbody>
          ) : (
            <tbody>
              <tr>
                <td class="blank">No upcoming arrivals.</td>
              </tr>
            </tbody>
          )
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
