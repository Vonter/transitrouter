import './i18n';

import { getCurrentCity } from './config';
import { getConfigForCity, getApiUrl } from './city-config';
import { h, render, Fragment } from 'preact';
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { useTranslation, Trans } from 'react-i18next';
import maplibregl from 'maplibre-gl';
import { toGeoJSON } from '@mapbox/polyline';

import { encode } from './utils/specialID';
import { sortServicesPinned } from './utils/bus';
import fetchCache from './utils/fetchCache';
import setIcon from '../utils/setIcon';

import ArrivalTimeText from './components/ArrivalTimeText';
import stopImagePath from './images/stop.png';
import stopEndImagePath from './images/stop-end.png';

import busSingleImagePath from './images/bus-single.svg';
import busDoubleImagePath from './images/bus-double.svg';
import busBendyImagePath from './images/bus-bendy.svg';
import busTinyImagePath from './images/bus-tiny.png';

const city = getCurrentCity();
const cityConfig = getConfigForCity(city);
const dataPath = `/data/${city}`;
const stopsJSONPath = `${dataPath}/stops.min.json`;
const scheduleJSONPath = `https://data.transitrouter.vonter.in/${city}/schedule`;
const routesJSONPath = `${dataPath}/routes.min.json`;
const servicesJSONPath = `${dataPath}/services.min.json`;

// Cache routes data (service -> encoded polylines per direction)
let _routesDataCache = null;

const BUSES = {
  sd: {
    alt: 'Single deck bus',
    src: busSingleImagePath,
    width: 20,
  },
  dd: {
    alt: 'Double deck bus',
    src: busDoubleImagePath,
    width: 20,
  },
  bd: {
    alt: 'Bendy bus',
    src: busBendyImagePath,
    width: 26,
  },
};

const Bus = (props) => {
  const { maxPx, index, duration_ms, type, load, feature, _ghost, _id } = props;

  const busImage = BUSES[type.toLowerCase()];

  const prevPx = useRef();
  const px = (duration_ms / 1000 / 60) * (duration_ms > 0 ? 10 : 2.5);

  const busTooFar = px > maxPx - 30; // 30 = bus width
  const pxFar = 90 + index * 2; // index = zero-based

  useEffect(() => {
    prevPx.current = px;
  }, [px]);

  let time = 1; // 1 second
  if (prevPx.current) {
    const distance = Math.abs(prevPx.current - px);
    time = distance / 10;
  }

  return (
    <span
      id={_id ? `bus-${_id}` : null}
      class={`bus ${_ghost ? 'ghost' : ''}`}
      style={{
        marginLeft: busTooFar ? pxFar + '%' : px.toFixed(1) + 'px',
        transitionDuration: `${time}s`,
      }}
    >
      <span class="bus-float">
        {/* <b class="debug">{_id}</b> */}
        <img {...busImage} />
        <br />
        <span class={`time time-${load.toLowerCase()}`}>
          <ArrivalTimeText ms={duration_ms} />
        </span>
      </span>
    </span>
  );
};

let BUSID = 1;
const busID = () => BUSID++;
const isSameBus = (b1, b2) =>
  b1.feature === b2.feature &&
  b1.type === b2.type &&
  b1.visit_number === b2.visit_number &&
  b1.origin_code === b2.origin_code &&
  b1.destination_code === b2.destination_code;
const isSameBuses = (b1, b2) =>
  b1.map((b) => b._id).join() === b2.map((b) => b._id).join();

// Helper functions
const getServiceNo = (p) => (p && typeof p === 'object' ? p.serviceNo : p);
const toServiceNoStr = (no) => String(no);
const isPinned = (no, pinnedServices) => {
  const noStr = toServiceNoStr(no);
  return pinnedServices.some((p) => toServiceNoStr(getServiceNo(p)) === noStr);
};
const clearMapSource = (map, sourceId) => {
  const source = map?.getSource(sourceId);
  if (source) {
    source.setData({ type: 'FeatureCollection', features: [] });
  }
};
const getPinnedServiceNumbers = (pinnedServices) =>
  new Set(pinnedServices.map(getServiceNo).filter(Boolean).map(toServiceNoStr));

function BusLane({ index, no, buses }) {
  const prevNo = useRef();
  const prevBuses = useRef();
  const nextBuses = buses.filter((nb) => typeof nb?.duration_ms === 'number');

  if (prevNo.current === no && !isSameBuses(prevBuses.current, nextBuses)) {
    nextBuses.forEach((nb) => {
      delete nb._id;
    });

    const pBuses = prevBuses.current.filter((b) => !b._ghost); // Remove previously ghosted buses
    pBuses.forEach((b, i) => {
      // Next bus requirements/checks
      // - Within range of duration_ms of current bus
      // - Not assigned with ID (possibly from previous loop execution)
      // - Same bus type as current bus
      const latestNextBus = nextBuses.find((nb) => {
        if (nb._id || !isSameBus(b, nb)) return false;
        const d = (nb.duration_ms - b.duration_ms) / 1000 / 60;
        return d > -5 && d < 3;
      });
      if (latestNextBus) {
        latestNextBus._id = b._id; // Assign ID for marking
      } else {
        // Insert "ghost" bus that will dissapear into thin air
        b._ghost = true;
        nextBuses.splice(i, 0, b);
      }
    });
  }

  nextBuses.forEach((nb) => {
    if (!nb._id) nb._id = busID();
  });

  // DEBUGGING
  // const prevBusesClone = structuredClone(prevBuses.current);
  // const nextBusesClone = structuredClone(nextBuses);
  // if (no == 315) {
  //   console.log(
  //     no,
  //     prevBusesClone?.map((b) => b._id)?.join(),
  //     nextBusesClone?.map((b) => b._id)?.join(),
  //   );
  // }

  useEffect(() => {
    prevNo.current = no;
    prevBuses.current = structuredClone(nextBuses);
  }, [no, nextBuses]);

  const busLaneRef = useRef();
  const [busLaneWidth, setBusLaneWidth] = useState(0);
  useLayoutEffect(() => {
    setBusLaneWidth(busLaneRef.current?.offsetWidth);
  }, []);

  return (
    <div class="bus-lane" ref={busLaneRef}>
      {nextBuses.map((b, i) => (
        <Bus key={b._id} index={i} {...b} maxPx={busLaneWidth} />
      ))}
      {index && <span class="visit-number">{index}</span>}
    </div>
  );
}

function ArrivalTimes() {
  const { t, i18n } = useTranslation();
  const [busStop, setBusStop] = useState(null);
  const [stopsData, setStopsData] = useState(null);
  const [fetchServicesStatus, setFetchServicesStatus] = useState(null); // 'loading', 'error', 'online'
  const [services, setServices] = useState(null);
  const [servicesData, setServicesData] = useState(null); // For determining direction
  // Initialize pinned services from localStorage
  const [pinnedServices, setPinnedServices] = useState(() => {
    try {
      const stored = localStorage.getItem('transitrouter.arrival.pinnedServices');
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      // Convert old format (strings) to new format (objects)
      return parsed
        .map((item) => (typeof item === 'string' ? { serviceNo: item } : item))
        .filter((item) => item?.serviceNo || (typeof item === 'object' && item));
    } catch (e) {
      console.warn('Failed to parse pinned services from localStorage:', e);
      return [];
    }
  });
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const [followedVehicleId, setFollowedVehicleId] = useState(null);
  // Cache vehicle locations from previous API responses
  const vehicleLocationCache = useRef(new Map()); // vehicleId -> { lat, lng, heading }

  useEffect(() => {
    (async () => {
      const stops = await fetchCache(stopsJSONPath, 24 * 60);
      const services = await fetchCache(servicesJSONPath, 24 * 60);
      setServicesData(services);
      setStopsData(stops);

      window.onhashchange = () => {
        let code = location.hash.replace(/^#/, '');
        const cityMatch = code.match(/^\/[A-Za-z]+\/(.+)$/);
        if (cityMatch) code = cityMatch[1];

        if (code && stops[code]) {
          const [lng, lat, name] = stops[code];
          setBusStop({ code, name, lat, lng });
          setIcon(code);
        } else if (code) {
          alert(t('arrivals.invalidBusStopCode'));
        } else {
          setBusStop(null);
        }
      };
      window.onhashchange();
    })();
  }, [t]);

  useEffect(() => {
    if (busStop?.code) {
      const { code, name } = busStop;
      document.title = t('arrivals.titleStop', {
        stopNumber: code,
        stopName: name,
      });
      document
        .querySelector('[name="apple-mobile-web-app-title"]')
        .setAttribute('content', document.title);
    } else {
      document.title = t('arrivals.title');
      document
        .querySelector('[name="apple-mobile-web-app-title"]')
        .setAttribute('content', document.title);
    }
  }, [busStop, i18n.resolvedLanguage]);

  // Convert schedule data to arrival format
  function convertScheduleToArrival(scheduleData) {
    if (!scheduleData?.services) return [];

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const MAX_DURATION_MS = 30 * 60 * 1000;

    const createTrip = (duration_ms, origin, destination) => ({
      duration_ms,
      type: 'SD',
      load: 'SEA',
      feature: 'WAB',
      visit_number: 1,
      origin_code: origin,
      destination_code: destination,
    });

    return scheduleData.services
      .map((service) => {
        const { no, origin, destination, trips } = service;
        const upcomingTrips = trips
          .map((timeStr) => {
            const [hours, minutes] = timeStr.split(':').map(Number);
            const tripMinutes = hours * 60 + minutes;
            const duration_ms = (tripMinutes - currentMinutes) * 60 * 1000;
            return { minutes: tripMinutes, duration_ms };
          })
          .filter((t) => t.duration_ms > 0 && t.duration_ms <= MAX_DURATION_MS)
          .sort((a, b) => a.minutes - b.minutes);

        if (upcomingTrips.length === 0) return null;

        const result = {
          no,
          destination,
          frequency: upcomingTrips.length,
          next: createTrip(upcomingTrips[0].duration_ms, origin, destination),
        };
        if (upcomingTrips[1]) result.next2 = createTrip(upcomingTrips[1].duration_ms, origin, destination);
        if (upcomingTrips[2]) result.next3 = createTrip(upcomingTrips[2].duration_ms, origin, destination);

        return result;
      })
      .filter(Boolean)
      .sort((a, b) => b.frequency - a.frequency);
  }

  // Fetch live arrival data from city-specific API via Cloudflare Function
  async function fetchLiveArrivalData(stationId) {
    try {
      const response = await fetch(
        `${getApiUrl(cityConfig?.liveArrivals?.apiPath)}?stationid=${stationId}`
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
  }

  let arrivalsTimeout, arrivalsRAF;
  const scheduleRetry = (id, delay = 30000) => {
    arrivalsTimeout = setTimeout(() => {
      arrivalsRAF = requestAnimationFrame(() => fetchServices(id));
    }, delay);
  };

  const fetchScheduleFallback = (id) => {
    return fetchCache(`${scheduleJSONPath}/${id}.json`, 60)
      .then((scheduleData) => {
        const convertedServices = convertScheduleToArrival(scheduleData);
        setFetchServicesStatus(convertedServices.length > 0 ? 'static' : 'error');
        setServices(convertedServices.length > 0 ? convertedServices : []);
        scheduleRetry(id, 30000);
      })
      .catch((error) => {
        console.error('Fallback schedule fetch failed:', error);
        setFetchServicesStatus('error');
        setServices([]);
        scheduleRetry(id, 3000);
      });
  };

  function fetchServices(id) {
    if (!id || window._PAUSED) return;
    setFetchServicesStatus('loading');

    const hasLiveArrivals = cityConfig?.liveArrivals?.enabled;

    if (hasLiveArrivals) {
      fetchLiveArrivalData(id)
        .then((liveServices) => {
          if (liveServices?.length > 0) {
            setFetchServicesStatus('online');
            setServices(liveServices);
            scheduleRetry(id);
          } else {
            throw new Error('No live data available');
          }
        })
        .catch(() => {
          console.log('Falling back to static schedule');
          fetchScheduleFallback(id);
        });
    }
  }

  useEffect(() => {
    if (busStop) fetchServices(busStop.code);
    return () => {
      clearTimeout(arrivalsTimeout);
      cancelAnimationFrame(arrivalsRAF);
    };
  }, [busStop]);

  // Initialize map when busStop is set
  useEffect(() => {
    if (!busStop || !mapContainer.current || mapRef.current) return;

    const { lat, lng, code } = busStop;

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
    });

    mapRef.current = map;

    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
      }),
      'bottom-left',
    );

    map.on('load', () => {
      // Load stop images
      Promise.all([
        map.loadImage(stopImagePath).then((img) => {
          map.addImage('stop', img.data);
        }),
        map.loadImage(stopEndImagePath).then((img) => {
          map.addImage('stop-end', img.data);
        }),
        map
          .loadImage(busTinyImagePath)
          .then((img) => {
            map.addImage('bus-tiny', img.data);
          })
          .catch(() => {}),
      ]).then(() => {
        // Add stop source and layer
        map.addSource('stop-highlight', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                id: encode(code),
                properties: {
                  number: code,
                  name: busStop.name,
                },
                geometry: {
                  type: 'Point',
                  coordinates: [lng, lat],
                },
              },
            ],
          },
        });

        // Add icon layer for the stop
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

        // Source/layers for pinned routes
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

        // Source/layer for live buses of pinned service
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
            'text-size': ['interpolate', ['linear'], ['zoom'], 12, 8, 14, 10, 16, 12],
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

        // Click to follow a vehicle
        map.on('click', 'buses-service', (e) => {
          const feat = e.features?.[0];
          const vid = feat?.id || feat?.properties?.vehicleId;
          if (vid) {
            setFollowedVehicleId(vid);
            const [lng, lat] = feat.geometry.coordinates;
            map.easeTo({ center: [lng, lat], duration: 600 });
          }
        });

        // Note: Initial pinned services will be rendered by the useEffect that watches
        // pinnedServices and services. We don't render them here immediately because
        // we need to wait for services to load first to filter out inactive services.
      });
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [busStop]);

  // Render pinned routes and control vehicle tracking when pinnedServices change
  useEffect(() => {
    const map = mapRef.current;
    const routesSource = map?.getSource('routes-pinned');
    if (!map || !routesSource) {
      const timeoutId = setTimeout(() => {}, 100);
      return () => clearTimeout(timeoutId);
    }

    (async () => {
      try {
        const isEmpty = !pinnedServices?.length || !Array.isArray(pinnedServices);
        
        // Filter to only active pinned services that exist in current services
        const activePinnedServices = isEmpty
          ? []
          : pinnedServices.filter((pinned) => {
              const serviceNoStr = toServiceNoStr(getServiceNo(pinned));
              return services?.some((s) => toServiceNoStr(s.no) === serviceNoStr);
            });

        if (!activePinnedServices.length) {
          clearMapSource(map, 'routes-pinned');
          return;
        }

        if (!_routesDataCache) {
          _routesDataCache = await fetchCache(routesJSONPath, 24 * 60);
        }

        const features = [];
        activePinnedServices.forEach((pinned) => {
          const serviceNo = getServiceNo(pinned);
          const serviceRoutes = _routesDataCache?.[serviceNo];
          if (Array.isArray(serviceRoutes)) {
            serviceRoutes.forEach((enc) => {
              features.push({
                type: 'Feature',
                id: encode(serviceNo),
                properties: { service: serviceNo },
                geometry: toGeoJSON(enc),
              });
            });
          }
        });

        routesSource.setData({ type: 'FeatureCollection', features });
      } catch (e) {
        console.error('Failed to render pinned routes', e);
        clearMapSource(map, 'routes-pinned');
      }
    })();
  }, [pinnedServices, services]);

  // Extract and display vehicles from services data for pinned routes
  useEffect(() => {
    const map = mapRef.current;
    const vehiclesSource = map?.getSource('buses-service');
    if (!map || !vehiclesSource) {
      const timeoutId = setTimeout(() => {}, 100);
      return () => clearTimeout(timeoutId);
    }

    const isEmpty = !services || !pinnedServices?.length || !Array.isArray(pinnedServices);
    if (isEmpty) {
      clearMapSource(map, 'buses-service');
      return;
    }

    const pinnedServiceNumbers = getPinnedServiceNumbers(pinnedServices);
    const extractLocation = (trip) => {
      let location = trip.location || (trip.lat !== undefined && trip.lng !== undefined ? { lat: trip.lat, lng: trip.lng } : null);
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
        typeof lat !== 'number' || typeof lng !== 'number' ||
        isNaN(lat) || isNaN(lng) ||
        Math.abs(lat) > 90 || Math.abs(lng) > 180 ||
        (lat === 0 && lng === 0)
      ) {
        return null;
      }
      return { lat, lng };
    };

    const vehicles = [];
    services.forEach((service) => {
      const serviceNoStr = toServiceNoStr(service.no);
      if (!pinnedServiceNumbers.has(serviceNoStr)) return;

      [service.next, service.next2, service.next3].forEach((trip) => {
        if (!trip) return;
        const location = extractLocation(trip);
        if (!location) return;

        vehicles.push({
          vehicleId: trip.vehicle_id || trip.vehicleId || `vehicle-${serviceNoStr}-${trip.duration_ms}`,
          vehicleNumber: trip.bus_no || trip.busNo || trip.vehicleNumber || serviceNoStr,
          routeNo: serviceNoStr,
          location,
          heading: trip.heading || null,
        });
      });
    });

    const geoJSON = {
      type: 'FeatureCollection',
      features: vehicles.map((vehicle, index) => ({
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
      })),
    };

    vehiclesSource.setData(geoJSON);
    
    // Clean up vehicle location cache
    for (const [vehicleId] of vehicleLocationCache.current.entries()) {
      const belongsToPinned = Array.from(pinnedServiceNumbers).some(
        (serviceNo) => vehicleId.includes(serviceNo) || vehicleId.startsWith(`vehicle-${serviceNo}-`)
      );
      if (!belongsToPinned) {
        vehicleLocationCache.current.delete(vehicleId);
      }
    }
  }, [pinnedServices, services]);

  // Follow selected vehicle as positions update
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !followedVehicleId || !services) return;

    let vehicleLocation = null;
    for (const service of services) {
      for (const trip of [service.next, service.next2, service.next3]) {
        if (!trip?.location) continue;
        const tripVehicleId = trip.vehicle_id || trip.vehicleId || `vehicle-${service.no}-${trip.duration_ms}`;
        if (tripVehicleId === followedVehicleId || `vehicle-${tripVehicleId}` === followedVehicleId) {
          vehicleLocation = trip.location;
          break;
        }
      }
      if (vehicleLocation) break;
    }

    if (vehicleLocation?.lng && typeof vehicleLocation.lng === 'number' && typeof vehicleLocation.lat === 'number') {
      map.easeTo({ center: [vehicleLocation.lng, vehicleLocation.lat], duration: 800 });
    }
  }, [followedVehicleId, services]);

  function togglePin(no, destination = null) {
    if (!destination && services) {
      const service = services.find((s) => s.no === no);
      destination = service?.destination || service?.next?.destination_code || null;
    }

    const serviceNoStr = toServiceNoStr(no);
    const pinnedIndex = pinnedServices.findIndex((p) => 
      toServiceNoStr(getServiceNo(p)) === serviceNoStr
    );
    
    const updatedPinned = pinnedIndex >= 0
      ? pinnedServices.filter((_, i) => i !== pinnedIndex)
      : [...pinnedServices, { serviceNo: no, destination }];
    
    // Clean up vehicle cache when unpinning
    if (pinnedIndex >= 0) {
      for (const [vehicleId] of vehicleLocationCache.current.entries()) {
        if (vehicleId.includes(serviceNoStr) || vehicleId.startsWith(`vehicle-${serviceNoStr}-`)) {
          vehicleLocationCache.current.delete(vehicleId);
        }
      }
    }

    setPinnedServices(updatedPinned);
    try {
      localStorage.setItem('transitrouter.arrival.pinnedServices', JSON.stringify(updatedPinned));
    } catch (e) {}
  }

  if (!busStop) {
    if (stopsData) {
      return (
        <ul class="stops-list">
          {Object.keys(stopsData).map((stop) => (
            <li>
              <a href={`#${stop}`}>{stopsData[stop][2]}</a>
            </li>
          ))}
        </ul>
      );
    }
    return;
  }

  const { code, name } = busStop;

  // Group services by route number and destination
  const groupedServices = services ? (() => {
    const groups = {};
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
      [service.next, service.next2, service.next3].filter(Boolean).forEach((bus) => {
        groups[key].buses.push(bus);
      });
      groups[key].frequency += service.frequency || 0;
    });

    return Object.values(groups).sort((a, b) => {
      const aPinned = isPinned(a.no, pinnedServices);
      const bPinned = isPinned(b.no, pinnedServices);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return b.frequency - a.frequency;
    });
  })() : [];

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
            <tbody class={!groupedServices.length ? 'loading' : ''}>
              {groupedServices.map((group) => {
                const { no, destination, buses } = group;
                const pinned = isPinned(no, pinnedServices);
                const sortedBuses = [...buses].sort((a, b) => a.duration_ms - b.duration_ms);
                const buses1 = sortedBuses.filter((b) => b?.visit_number === 1);
                const buses2 = sortedBuses.filter((b) => b?.visit_number === 2);
                return (
                  <>
                    <tr class={pinned ? 'pin' : ''}>
                      <th onClick={(e) => { e.preventDefault(); togglePin(no, destination); }}>
                        {no}
                      </th>
                      <td class={`bus-lane-cell ${buses2.length ? 'multiple' : ''}`}>
                        {buses2.length ? (
                          <>
                            <BusLane index={1} no={no} buses={buses1} />
                            <BusLane index={2} no={no} buses={buses2} />
                          </>
                        ) : (
                          <BusLane no={no} buses={sortedBuses} />
                        )}
                      </td>
                    </tr>
                    <tr class={pinned ? 'pin' : ''}>
                      <th colspan="2">
                        <small class="destination">
                          {(destination && stopsData[destination]?.[2]) || destination || ''}
                        </small>
                      </th>
                    </tr>
                  </>
                );
              })}
            </tbody>
          ) : (
            <tbody>
              <tr>
                <td class="blank">No arrival times available.</td>
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
