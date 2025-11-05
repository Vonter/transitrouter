import { h, Fragment } from 'preact';
import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from 'preact/hooks';
import CheapRuler from 'cheap-ruler';
const ruler = new CheapRuler(1.3);
import { useTranslation } from 'react-i18next';

import { encode } from '../utils/specialID';
import getRoute from '../utils/getRoute';
import { setRafInterval, clearRafInterval } from '../utils/rafInterval';
import { timeDisplay, sortServices } from '../utils/bus';
import { getConfigForCity, getApiUrl } from '../city-config';
import fetchCache from '../utils/fetchCache';

import ArrivalTimeText from './ArrivalTimeText';

import busTinyImagePath from '../images/bus-tiny.png';

const setupBusesStopLayerOnce = (map) => {
  if (!map) return;
  if (!map.getSource('buses-stop')) {
    map.addSource('buses-stop', {
      type: 'geojson',
      tolerance: 10,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
    if (!map.hasImage('bus-tiny')) {
      map.loadImage(busTinyImagePath, (e, img) => {
        if (!map.hasImage('bus-tiny')) map.addImage('bus-tiny', img);
      });
    }
    map.addLayer({
      id: 'buses-stop',
      type: 'symbol',
      source: 'buses-stop',
      minzoom: 11,
      layout: {
        'icon-image': 'bus-tiny',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': ['step', ['zoom'], 0.25, 15, 0.3, 16, 0.4],
        'text-field': ['step', ['zoom'], '', 15, ['get', 'number']],
        'text-optional': true,
        'text-size': 10,
        // 'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
        'text-font': ['Noto Sans Regular'],
        'text-variable-anchor': ['left', 'right', 'bottom', 'top'],
        'text-justify': 'auto',
        'text-padding': ['step', ['zoom'], 4, 15, 6, 16, 8],
      },
      paint: {
        'text-color': '#00454d',
        'text-halo-color': '#fff',
        'text-halo-width': 2,
      },
    });
  }
};

const removeMapBuses = (map) => {
  if (!map) return;
  map.getSource('buses-stop')?.setData({
    type: 'FeatureCollection',
    features: [],
  });
};

const timeout = (n) => new Promise((f) => setTimeout(f, n));

export default function BusServicesArrival({
  services,
  id,
  map,
  active,
  showBusesOnMap,
  stopData, // Added to access destination groups
}) {
  if (!id) return;
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [servicesArrivals, setServicesArrivals] = useState({});
  const [servicesIssues, setServicesIssues] = useState([]);
  const [liveBusCount, setLiveBusCount] = useState(0);
  const [oneServiceHasMultipleDirections, setOneServiceHasMultipleDirections] =
    useState(false);
  const [scheduleData, setScheduleData] = useState(null);
  const route = getRoute();

  let controller;
  const renderStopsTimeout = useRef();
  const fetchServices = useCallback(async () => {
    setIsLoading(true);
    controller = new AbortController();

    try {
      // Get city config to find the arrivals API path
      const cityConfig = getConfigForCity(route.city);
      const arrivalsApiPath = cityConfig?.liveArrivals?.apiPath;
      const apiUrl = `${getApiUrl(arrivalsApiPath)}?stationid=${id}`;

      const response = await fetch(apiUrl, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch arrivals: ${response.status}`);
      }

      const results = await response.json();

      if (results) {
        const servicesArrivals = {};
        const { services } = results;
        services.forEach((service) => {
          if (
            !servicesArrivals[service.no] ||
            servicesArrivals[service.no] > service.next.duration_ms // if there is a service with multiple directions, we only want the one with the shortest duration
          ) {
            servicesArrivals[service.no] = service.next.duration_ms;
          }
        });
        setServicesArrivals(servicesArrivals);
        setIsLoading(false);

        // check for issues (duplicate services, multiple visits)
        const servicesWithIssues = [];
        services.forEach((service, i) => {
          const hasDuplicateServices =
            services.findIndex((s) => s.no === service.no) !== i;
          if (hasDuplicateServices) {
            servicesWithIssues.push(service.no);
          }
          const { next, next2, next3 } = service;
          const hasMultipleVisits =
            next?.visit_number > 1 ||
            next2?.visit_number > 1 ||
            next3?.visit_number > 1;
          if (hasMultipleVisits) {
            servicesWithIssues.push(service.no);
          }
        });
        setServicesIssues(servicesWithIssues);

        const hasIssues = servicesWithIssues.length > 0;
        setOneServiceHasMultipleDirections(hasIssues);

        if (showBusesOnMap) {
          setupBusesStopLayerOnce(map);
          renderStopsTimeout.current = setTimeout(
            () => {
              const servicesWithCoords = services.filter(
                (s) => s.no && s.next.lat > 0,
              );
              setLiveBusCount(servicesWithCoords.length);
              const pointMargin = 100;
              const servicesWithFixedCoordsPromises = servicesWithCoords.map(
                async (s) => {
                  await timeout(0); // Forces this to be async
                  const coords = [s.next.lng, s.next.lat];
                  const point = map.project(coords);
                  let shortestDistance = Infinity;
                  let nearestCoords;
                  if (point.x && point.y) {
                    const features = map
                      .queryRenderedFeatures(
                        [
                          [point.x - pointMargin, point.y - pointMargin],
                          [point.x + pointMargin, point.y + pointMargin],
                        ],
                        {
                          validate: false,
                        },
                      )
                      .filter((f) => {
                        return (
                          f.sourceLayer === 'road' &&
                          f.layer.type === 'line' &&
                          f.properties.class != 'path' &&
                          !/(pedestrian|sidewalk|steps)/.test(f.layer.id)
                        );
                      });
                    features.forEach((f) => {
                      const nearestPoint = ruler.pointOnLine(
                        f.geometry.coordinates,
                        coords,
                      );
                      if (nearestPoint.t) {
                        const distance = ruler.distance(
                          coords,
                          nearestPoint.point,
                        );
                        if (distance < shortestDistance) {
                          shortestDistance = distance;
                          nearestCoords = nearestPoint.point;
                        }
                      }
                    });
                    if (nearestCoords && shortestDistance * 1000 < 10) {
                      // Only within 10m
                      console.log(
                        `Fixed bus position: ${s.no} - ${(
                          shortestDistance * 1000
                        ).toFixed(3)}m`,
                      );
                      s.next = {
                        lng: nearestCoords[0],
                        lat: nearestCoords[1],
                      };
                    }
                  }
                  return s;
                },
              );
              requestAnimationFrame(async () => {
                const servicesWithFixedCoords = await Promise.all(
                  servicesWithFixedCoordsPromises,
                );
                map.getSource('buses-stop').setData({
                  type: 'FeatureCollection',
                  features: servicesWithFixedCoords.map((s) => ({
                    type: 'Feature',
                    id: encode(s.no),
                    properties: {
                      number: s.no,
                    },
                    geometry: {
                      type: 'Point',
                      coordinates: [s.next.lng, s.next.lat],
                    },
                  })),
                });
              });
            },
            map.loaded() ? 0 : 1000,
          );
        }
      }
    } catch (error) {
      // Silent fail
      console.error('Error fetching arrivals:', error);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  // Fetch schedule data to get trip_count for each service
  useEffect(() => {
    if (!id) return;

    const cityConfig = getConfigForCity(route.city);
    const scheduleJSONPath = `https://data.transitrouter.vonter.in/${route.city}/schedule`;

    fetchCache(`${scheduleJSONPath}/${id}.json`, 60 * 60) // Cache for 1 hour
      .then((data) => {
        setScheduleData(data);
      })
      .catch((error) => {
        console.error('Failed to fetch schedule data:', error);
        setScheduleData(null);
      });
  }, [id, route.city]);

  useEffect(() => {
    let intervalID;
    if (active) {
      intervalID = setRafInterval(fetchServices, 60 * 1000); // 60 seconds
    }
    return () => {
      clearRafInterval(intervalID);
      controller?.abort();
      clearTimeout(renderStopsTimeout.current);
      removeMapBuses(map);
    };
  }, [id, active, showBusesOnMap]);

  const servicesValue = route.value?.split('~') || [];

  // Group by destination and collect all services going to each destination
  const groupedByDestination = useMemo(() => {
    if (!stopData?.destinationGroups) {
      // Fallback to old format if destinationGroups not available
      return {
        hasGroups: false,
        destinations: [],
        ungroupedServices: services.sort(sortServices),
      };
    }

    // Build a map of service number to trip_count from schedule data
    const serviceTripCounts = new Map();
    if (scheduleData?.services) {
      scheduleData.services.forEach((serviceData) => {
        serviceTripCounts.set(serviceData.no, serviceData.trip_count || 0);
      });
    }

    // Map to collect all services for each destination
    const destinationMap = new Map();

    services.forEach((service) => {
      const destinationData = stopData.destinationGroups[service];
      if (destinationData) {
        // For each destination this service goes to
        Object.keys(destinationData).forEach((destId) => {
          if (!destinationMap.has(destId)) {
            destinationMap.set(destId, {
              id: destId,
              name: window._data?.stopsData?.[destId]?.name || destId,
              services: [],
              maxStopCount: 0,
              totalTripCount: 0,
            });
          }

          const dest = destinationMap.get(destId);
          dest.services.push(service);

          // Track the maximum stop count to this destination
          const stopCount = destinationData[destId].stopCount || 0;
          if (stopCount > dest.maxStopCount) {
            dest.maxStopCount = stopCount;
          }

          // Add trip_count to total for this destination
          const tripCount = serviceTripCounts.get(service) || 0;
          dest.totalTripCount += tripCount;
        });
      }
    });

    // Convert to array and sort by total trip_count (descending)
    const destinations = Array.from(destinationMap.values()).sort((a, b) => {
      // Sort by total trip_count (descending)
      return b.totalTripCount - a.totalTripCount;
    });

    return {
      hasGroups: true,
      destinations,
      ungroupedServices: [],
    };
  }, [services, stopData, scheduleData]);

  return (
    <>
      {groupedByDestination.hasGroups ? (
        <>
          {groupedByDestination.destinations.map((dest) => (
            <div key={dest.id} class="service-destination-group">
              <p class="service-destination-info">
                <strong>{dest.name}</strong>
              </p>
              <p
                class={`services-list ${isLoading ? 'loading' : ''}`}
                style={{ marginTop: '4px' }}
              >
                {dest.services.sort(sortServices).map((service) => (
                  <>
                    <a
                      href={`#${route.cityPrefix}/services/${service}`}
                      class={`service-tag ${
                        route.page === 'service' &&
                        servicesValue.includes(service)
                          ? 'current'
                          : ''
                      }`}
                    >
                      {service}
                      {servicesIssues.includes(service) && ' ⚠️'}
                      {servicesArrivals[service] && (
                        <span>
                          <ArrivalTimeText ms={servicesArrivals[service]} />
                        </span>
                      )}
                    </a>{' '}
                  </>
                ))}
              </p>
            </div>
          ))}
        </>
      ) : (
        <p class={`services-list ${isLoading ? 'loading' : ''}`}>
          {groupedByDestination.ungroupedServices.map((service) => (
            <>
              <a
                href={`#${route.cityPrefix}/services/${service}`}
                class={`service-tag ${
                  route.page === 'service' && servicesValue.includes(service)
                    ? 'current'
                    : ''
                }`}
              >
                {service}
                {servicesIssues.includes(service) && ' ⚠️'}
                {servicesArrivals[service] && (
                  <span>
                    <ArrivalTimeText ms={servicesArrivals[service]} />
                  </span>
                )}
              </a>{' '}
            </>
          ))}
        </p>
      )}
      {oneServiceHasMultipleDirections && (
        <div class="callout warning iconic">
          {t('stop.multipleDirectionsWarning')}
        </div>
      )}
      {showBusesOnMap && liveBusCount > 0 && (
        <p style={{ marginTop: 5, fontSize: '.8em' }}>
          <span class="live">{t('common.live')}</span>{' '}
          <img src={busTinyImagePath} width="16" alt="" />{' '}
          {t('stop.liveBusTrack', { count: liveBusCount })}
        </p>
      )}
    </>
  );
}
