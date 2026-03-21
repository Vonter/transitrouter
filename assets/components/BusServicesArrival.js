import { h, Fragment } from 'preact';
import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from 'preact/hooks';
import { useTranslation } from 'react-i18next';

import Fuse from 'fuse.js';
import getRoute from '../utils/getRoute';
import { setRafInterval, clearRafInterval } from '../utils/rafInterval';
import { timeDisplay, sortServices } from '../utils/bus';
import { getConfigForCity } from '../city-config';
import fetchCache from '../utils/fetchCache';
import {
  filterStaleArrivalsFromService,
  fetchStopRoutes,
} from '../utils/fetchArrivals';

import ArrivalTimeText from './ArrivalTimeText';

export default function BusServicesArrival({
  services,
  id,
  map,
  active,
  showBusesOnMap,
  stopData, // Added to access destination groups
  onLoadingChange, // Callback to notify parent of loading state
  onErrorChange, // Callback to notify parent of error state
  cancelRef, // Ref to expose cancel function to parent
  destFilter = '',
  destFilterExact = false,
  onDestFilterChange = () => {},
}) {
  if (!id) return;
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [servicesArrivals, setServicesArrivals] = useState({});
  const [servicesIssues, setServicesIssues] = useState([]);
  const [oneServiceHasMultipleDirections, setOneServiceHasMultipleDirections] =
    useState(false);
  const [scheduleData, setScheduleData] = useState(null);
  const route = getRoute();

  // Build a Fuse index over all downstream stop names for this stop.
  // Rebuilt only when stop data or services list changes.
  const destFuse = useMemo(() => {
    if (!stopData?.destinationGroups) return null;
    const names = new Set();
    services.forEach((service) => {
      const serviceDestGroups = stopData.destinationGroups[service];
      if (!serviceDestGroups) return;
      Object.values(serviceDestGroups).forEach(({ routes }) => {
        routes.forEach((routeStops) => {
          const idx = routeStops.indexOf(stopData.number);
          if (idx === -1) return;
          routeStops.slice(idx + 1).forEach((stopId) => {
            const stopName = window._data?.stopsData?.[stopId]?.name;
            if (stopName) names.add(stopName);
          });
        });
      });
    });
    return new Fuse(Array.from(names), { threshold: 0.35 });
  }, [services, stopData]);

  // When filter is active, group services by which downstream stop name fuzzy-matches.
  // Each service may appear under multiple matching stop names.
  // Returns null when no filter is active.
  const matchingStopGroups = useMemo(() => {
    if (!destFilter.trim() || !stopData?.destinationGroups || !destFuse)
      return null;

    const fuzzyMatches = destFilterExact
      ? new Set([destFilter.trim()])
      : new Set(destFuse.search(destFilter).map((r) => r.item));
    if (fuzzyMatches.size === 0) return [];

    const stopNameToServices = new Map();

    services.forEach((service) => {
      const serviceDestGroups = stopData.destinationGroups[service];
      if (!serviceDestGroups) return;

      // Track which stop names we've already added this service to (avoid duplicates)
      const matchedStopNames = new Set();

      Object.values(serviceDestGroups).forEach(({ routes }) => {
        routes.forEach((routeStops) => {
          const idx = routeStops.indexOf(stopData.number);
          if (idx === -1) return;
          routeStops.slice(idx + 1).forEach((stopId) => {
            const stopName = window._data?.stopsData?.[stopId]?.name;
            if (
              stopName &&
              fuzzyMatches.has(stopName) &&
              !matchedStopNames.has(stopName)
            ) {
              matchedStopNames.add(stopName);
              if (!stopNameToServices.has(stopName)) {
                stopNameToServices.set(stopName, new Set());
              }
              stopNameToServices.get(stopName).add(service);
            }
          });
        });
      });
    });

    return Array.from(stopNameToServices.entries())
      .map(([stopName, serviceSet]) => ({
        stopName,
        services: Array.from(serviceSet).sort(sortServices),
      }))
      .sort((a, b) => b.services.length - a.services.length);
  }, [services, destFilter, destFilterExact, stopData, destFuse]);

  const controllerRef = useRef(null);
  const fetchServices = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);
    onLoadingChange?.(true);
    controllerRef.current = new AbortController();
    const { signal } = controllerRef.current;

    try {
      const cityConfig = getConfigForCity(route.city);
      const stopRoutesApiPath = cityConfig?.stopRoutes?.apiPath;
      const arrivalsApiPath =
        stopRoutesApiPath || cityConfig?.liveArrivals?.apiPath;

      if (!arrivalsApiPath) {
        setIsLoading(false);
        setHasError(false);
        onErrorChange?.(false);
        onLoadingChange?.(false);
        return;
      }

      // Phase 1: Fetch routes/ETAs and render immediately
      const routeData = await fetchStopRoutes(arrivalsApiPath, id, signal);

      if (routeData) {
        const { services, servicesArrivals } = routeData;
        setServicesArrivals(servicesArrivals);
        setIsLoading(false);
        setHasError(false);
        onErrorChange?.(false);
        onLoadingChange?.(false);

        // Check for issues (duplicate services, multiple visits)
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
        setOneServiceHasMultipleDirections(servicesWithIssues.length > 0);
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Error fetching arrivals:', error);
        setHasError(true);
        onErrorChange?.(true);
        setIsLoading(false);
        onLoadingChange?.(false);
        return;
      }
    } finally {
      setIsLoading(false);
      onLoadingChange?.(false);
    }
  }, [id, onLoadingChange]);

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
      controllerRef.current?.abort();
    };
  }, [id, active]);

  // Expose cancel function via ref
  useEffect(() => {
    if (cancelRef) {
      cancelRef.current = () => {
        if (controllerRef.current) {
          controllerRef.current.abort();
          setIsLoading(false);
          setHasError(false);
          onLoadingChange?.(false);
          onErrorChange?.(false);
        }
      };
    }
    return () => {
      if (cancelRef) {
        cancelRef.current = null;
      }
    };
  }, [onLoadingChange, onErrorChange]);

  // Notify parent of error state changes
  useEffect(() => {
    onErrorChange?.(hasError);
  }, [hasError, onErrorChange]);

  const servicesValue = route.value?.split('~') || [];

  // Group by arrival status (upcoming vs scheduled) and then by terminal destination.
  // Only used when no destination filter is active.
  const groupedByDestination = useMemo(() => {
    if (!stopData?.destinationGroups) {
      // Fallback to old format if destinationGroups not available
      const upcomingServices = services.filter((s) => servicesArrivals[s]);
      const scheduledServices = services.filter((s) => !servicesArrivals[s]);
      return {
        hasGroups: false,
        upcomingServices: upcomingServices.sort(sortServices),
        scheduledServices: scheduledServices.sort(sortServices),
      };
    }

    // Build a map of service number to trip_count from schedule data
    const serviceTripCounts = new Map();
    if (scheduleData?.services) {
      scheduleData.services.forEach((serviceData) => {
        serviceTripCounts.set(serviceData.no, serviceData.trip_count || 0);
      });
    }

    // Separate services into upcoming (with arrivals) and scheduled (without arrivals)
    const upcomingServices = services.filter((s) => servicesArrivals[s]);
    const scheduledServices = services.filter((s) => !servicesArrivals[s]);

    // Helper function to group services by destination
    const groupServicesByDestination = (serviceList) => {
      const destinationMap = new Map();

      serviceList.forEach((service) => {
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
      return Array.from(destinationMap.values()).sort((a, b) => {
        return b.totalTripCount - a.totalTripCount;
      });
    };

    const upcomingDestinations = groupServicesByDestination(upcomingServices);
    const scheduledDestinations = groupServicesByDestination(scheduledServices);

    return {
      hasGroups: true,
      upcomingDestinations,
      scheduledDestinations,
    };
  }, [services, stopData, scheduleData, servicesArrivals]);

  // Renders a list of service tags for a given set of service numbers,
  // sorted by soonest arrival first, then alphabetically for those without arrivals.
  const renderServiceTags = (serviceList) => (
    <p
      class={`services-list ${isLoading ? 'loading' : ''}`}
      style={{ marginTop: '4px' }}
    >
      {[...serviceList]
        .sort((a, b) => {
          const aMs = servicesArrivals[a],
            bMs = servicesArrivals[b];
          if (aMs && !bMs) return -1;
          if (!aMs && bMs) return 1;
          if (aMs && bMs) return aMs - bMs;
          return sortServices(a, b);
        })
        .map((service) => (
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
              {servicesArrivals[service] && (
                <span>
                  <ArrivalTimeText ms={servicesArrivals[service]} />
                </span>
              )}
            </a>{' '}
          </>
        ))}
    </p>
  );

  // Helper component to render a destination group (terminal destination header + routes)
  const renderDestinationGroup = (dest) => (
    <div key={dest.id} class="service-destination-group">
      <p class="service-destination-info">
        <strong>{dest.name}</strong>
      </p>
      {renderServiceTags(dest.services)}
    </div>
  );

  // Helper component to render a service list (for fallback when no destination groups)
  const renderServiceList = (serviceList) => (
    <p class={`services-list ${isLoading ? 'loading' : ''}`}>
      {serviceList.map((service) => (
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
  );

  return (
    <>
      {destFilter.trim() ? (
        // Filter active: group routes by the downstream stop name that matched
        matchingStopGroups && matchingStopGroups.length > 0 ? (
          (() => {
            const renderDestGroup = (stopName, services) => (
              <div class="service-destination-group">
                <p class="service-destination-info">
                  <strong
                    style={{ cursor: 'pointer' }}
                    onClick={() => onDestFilterChange(stopName, true)}
                  >
                    {stopName}
                  </strong>
                </p>
                {renderServiceTags(services)}
              </div>
            );
            return (
              <div class="service-arrival-group">
                {matchingStopGroups.map(({ stopName, services: svc }) => {
                  const withETA = svc.filter((s) => servicesArrivals[s]);
                  return withETA.length > 0
                    ? renderDestGroup(stopName, withETA)
                    : null;
                })}
                {matchingStopGroups.map(({ stopName, services: svc }) => {
                  const withoutETA = svc.filter((s) => !servicesArrivals[s]);
                  return withoutETA.length > 0
                    ? renderDestGroup(stopName, withoutETA)
                    : null;
                })}
              </div>
            );
          })()
        ) : (
          <p class="dest-filter-empty">No routes to "{destFilter}"</p>
        )
      ) : (
        // No filter: show existing terminal-destination grouping
        <>
          {groupedByDestination.hasGroups ? (
            <>
              {groupedByDestination.upcomingDestinations.length > 0 && (
                <div class="service-arrival-group">
                  {groupedByDestination.upcomingDestinations.map((dest) =>
                    renderDestinationGroup(dest),
                  )}
                </div>
              )}

              {groupedByDestination.scheduledDestinations.length > 0 && (
                <div class="service-arrival-group">
                  {groupedByDestination.scheduledDestinations.map((dest) =>
                    renderDestinationGroup(dest),
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {groupedByDestination.upcomingServices.length > 0 && (
                <div class="service-arrival-group">
                  {renderServiceList(groupedByDestination.upcomingServices)}
                </div>
              )}

              {groupedByDestination.scheduledServices.length > 0 && (
                <div class="service-arrival-group">
                  {renderServiceList(groupedByDestination.scheduledServices)}
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
