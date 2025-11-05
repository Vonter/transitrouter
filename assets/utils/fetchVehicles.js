import { getApiUrl } from '../city-config.js';

/**
 * Search for a route by text to get its route ID
 * @param {string} routesApiPath - The routes API path from city config
 * @param {string} routeText - The route/service number to search for (e.g., "KIA-14")
 * @returns {Promise} Promise resolving to route search results
 */
export async function searchRoute(routesApiPath, routeText) {
  if (!routesApiPath || !routeText) {
    return null;
  }

  try {
    const url = `${getApiUrl(routesApiPath)}?routetext=${encodeURIComponent(routeText)}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to search route: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error searching route:', error);
    return null;
  }
}

/**
 * Get the route ID for a specific service number
 * @param {string} routesApiPath - The routes API path from city config
 * @param {string} serviceNumber - The service number (e.g., "KIA-14")
 * @returns {Promise<number|null>} Promise resolving to the route ID or null if not found
 */
export async function getRouteId(routesApiPath, serviceNumber) {
  const searchResults = await searchRoute(routesApiPath, serviceNumber);

  if (
    !searchResults ||
    !searchResults.routes ||
    searchResults.routes.length === 0
  ) {
    return null;
  }

  // Find exact match (case-insensitive)
  const exactMatch = searchResults.routes.find(
    (route) => route.routeNo.toLowerCase() === serviceNumber.toLowerCase(),
  );

  return exactMatch ? exactMatch.routeId : null;
}

/**
 * Utility to fetch live vehicle tracking data from the BMTC vehicles API
 * @param {string} apiPath - The API path from city config
 * @param {number} routeId - The BMTC route ID
 * @param {number} serviceTypeId - The service type ID (default: 0 for all types)
 * @returns {Promise} Promise resolving to vehicle data
 */
export async function fetchVehicles(apiPath, routeId, serviceTypeId = 0) {
  if (!apiPath || !routeId) {
    return null;
  }

  try {
    const url = `${getApiUrl(apiPath)}?routeid=${routeId}&servicetypeid=${serviceTypeId}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch vehicles: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching vehicles:', error);
    return null;
  }
}

/**
 * Extract all vehicles from the API response (both directions)
 * @param {Object} vehicleData - The API response containing up and down direction data
 * @returns {Array} Array of vehicle objects with normalized structure, deduplicated by vehicle number
 */
export function extractVehicles(vehicleData) {
  if (!vehicleData || (!vehicleData.up && !vehicleData.down)) {
    console.log('No vehicle data to extract');
    return [];
  }

  const vehicles = [];
  const seenVehicleNumbers = new Set();

  // Process up direction
  if (vehicleData.up && vehicleData.up.length > 0) {
    vehicleData.up.forEach((station) => {
      if (station.vehicles && station.vehicles.length > 0) {
        station.vehicles.forEach((vehicle) => {
          // Skip duplicate vehicle numbers
          if (seenVehicleNumbers.has(vehicle.vehicleNumber)) {
            return;
          }

          vehicles.push({
            ...vehicle,
            direction: 'up',
            stationName: station.stationName,
            routeNo: station.routeNo,
          });
          seenVehicleNumbers.add(vehicle.vehicleNumber);
        });
      }
    });
  }

  // Process down direction
  if (vehicleData.down && vehicleData.down.length > 0) {
    vehicleData.down.forEach((station) => {
      if (station.vehicles && station.vehicles.length > 0) {
        station.vehicles.forEach((vehicle) => {
          // Skip duplicate vehicle numbers
          if (seenVehicleNumbers.has(vehicle.vehicleNumber)) {
            return;
          }

          vehicles.push({
            ...vehicle,
            direction: 'down',
            stationName: station.stationName,
            routeNo: station.routeNo,
          });
          seenVehicleNumbers.add(vehicle.vehicleNumber);
        });
      }
    });
  }

  return vehicles;
}

/**
 * Convert vehicles to GeoJSON features for map display
 * @param {Array} vehicles - Array of vehicle objects
 * @returns {Object} GeoJSON FeatureCollection
 */
export function vehiclesToGeoJSON(vehicles) {
  if (!vehicles || vehicles.length === 0) {
    return {
      type: 'FeatureCollection',
      features: [],
    };
  }

  const features = vehicles
    .filter((vehicle) => {
      // Only include vehicles with valid location data
      if (
        !vehicle.location ||
        typeof vehicle.location.lat !== 'number' ||
        typeof vehicle.location.lng !== 'number'
      ) {
        console.warn(
          `Vehicle ${vehicle.vehicleNumber} has invalid location data:`,
          vehicle.location,
        );
        return false;
      }
      // Filter out invalid coordinates (0,0 or null island)
      if (vehicle.location.lat === 0 && vehicle.location.lng === 0) {
        console.warn(
          `Vehicle ${vehicle.vehicleNumber} has null island coordinates`,
        );
        return false;
      }
      return true;
    })
    .map((vehicle, index) => ({
      type: 'Feature',
      id: vehicle.vehicleId || `vehicle-${index}`,
      properties: {
        vehicleNumber: vehicle.vehicleNumber,
        vehicleId: vehicle.vehicleId,
        routeNo: vehicle.routeNo,
        direction: vehicle.direction,
        heading: vehicle.heading,
        serviceType: vehicle.serviceType,
        lastRefresh: vehicle.lastRefresh,
        lastRefreshMs: vehicle.lastRefreshMs,
      },
      geometry: {
        type: 'Point',
        coordinates: [vehicle.location.lng, vehicle.location.lat],
      },
    }));

  return {
    type: 'FeatureCollection',
    features,
  };
}

/**
 * Create a vehicle tracker instance for managing live vehicle tracking
 * Supports tracking multiple services simultaneously
 * @param {Object} config - Configuration object
 * @param {Object} config.cityConfig - City configuration with API paths
 * @param {Object} config.map - Maplibre GL map instance
 * @param {Function} config.setRafInterval - RAF interval setter function
 * @param {Function} config.clearRafInterval - RAF interval clearer function
 * @returns {Object} Vehicle tracker instance
 */
export function createVehicleTracker({
  cityConfig,
  map,
  setRafInterval,
  clearRafInterval,
}) {
  let intervalId = null;
  const trackedServices = new Set(); // Track multiple services
  const serviceRouteIds = new Map(); // Map service numbers to route IDs
  const currentVehicles = new Map(); // Map service number to vehicles array
  const routeIdCache = new Map(); // Cache route IDs to avoid repeated searches
  const subscribers = new Set(); // Subscribers for vehicle updates

  /**
   * Update vehicle positions for all tracked services
   */
  async function updatePositions() {
    const vehicleTracking = cityConfig?.liveVehicleTracking;

    // Early return if vehicle tracking is disabled or no services are tracked
    if (!vehicleTracking?.enabled || trackedServices.size === 0) {
      return;
    }

    try {
      // Fetch vehicles for all tracked services in parallel
      const fetchPromises = Array.from(trackedServices).map(
        async (serviceNumber) => {
          const routeId = serviceRouteIds.get(serviceNumber);
          if (!routeId) {
            console.warn(`No route ID for service: ${serviceNumber}`);
            return { serviceNumber, vehicles: [] };
          }

          try {
            const vehicleData = await fetchVehicles(
              vehicleTracking.apiPath,
              routeId,
            );

            if (vehicleData) {
              const vehicles = extractVehicles(vehicleData);
              return { serviceNumber, vehicles };
            }
            return { serviceNumber, vehicles: [] };
          } catch (error) {
            console.error(
              `Error fetching vehicles for service ${serviceNumber}:`,
              error,
            );
            return { serviceNumber, vehicles: [] };
          }
        },
      );

      const results = await Promise.all(fetchPromises);

      // Combine all vehicles from all services
      const allVehicles = [];
      results.forEach(({ serviceNumber, vehicles }) => {
        currentVehicles.set(serviceNumber, vehicles);
        allVehicles.push(...vehicles);
      });

      const geoJSON = vehiclesToGeoJSON(allVehicles);

      // Update map if source exists
      if (map && map.getSource('buses-service')) {
        map.getSource('buses-service').setData(geoJSON);
      }

      // Notify subscribers
      subscribers.forEach((callback) => {
        callback(allVehicles);
      });
    } catch (error) {
      console.error('Error updating vehicle positions:', error);
      subscribers.forEach((callback) => callback([]));
    }
  }

  /**
   * Start tracking vehicles for multiple services
   * @param {Array<string>} serviceNumbers - Array of service numbers to track
   * @returns {Promise<boolean>} True if tracking started successfully
   */
  async function startServices(serviceNumbers) {
    if (!serviceNumbers || serviceNumbers.length === 0) {
      stop();
      return false;
    }

    const vehicleTracking = cityConfig?.liveVehicleTracking;

    if (!vehicleTracking?.enabled || !vehicleTracking.routesApiPath) {
      console.log('Vehicle tracking not enabled or routes API not configured');
      return false;
    }

    try {
      // Stop existing tracking
      if (intervalId) {
        clearRafInterval(intervalId);
        intervalId = null;
      }

      // Clear existing tracked services
      trackedServices.clear();
      serviceRouteIds.clear();
      currentVehicles.clear();

      // Fetch route IDs for all services in parallel
      const routeIdPromises = serviceNumbers.map(async (serviceNumber) => {
        // Check cache first
        let routeId = routeIdCache.get(serviceNumber);

        if (!routeId) {
          // Route ID not in cache, fetch it
          routeId = await getRouteId(
            vehicleTracking.routesApiPath,
            serviceNumber,
          );

          if (routeId) {
            // Cache the route ID for future use
            routeIdCache.set(serviceNumber, routeId);
          } else {
            console.warn(`No route ID found for service: ${serviceNumber}`);
            return { serviceNumber, routeId: null };
          }
        }

        return { serviceNumber, routeId };
      });

      const routeIdResults = await Promise.all(routeIdPromises);

      // Add services with valid route IDs to tracking
      routeIdResults.forEach(({ serviceNumber, routeId }) => {
        if (routeId) {
          trackedServices.add(serviceNumber);
          serviceRouteIds.set(serviceNumber, routeId);
        }
      });

      if (trackedServices.size === 0) {
        console.warn('No valid services to track');
        // Ensure everything is stopped if no valid services found
        stop();
        return false;
      }

      // Fetch vehicles immediately for all services
      await updatePositions();

      // Only set up periodic updates if we have tracked services
      if (trackedServices.size > 0) {
        intervalId = setRafInterval(() => {
          updatePositions();
        }, 60 * 1000);
      }

      return true;
    } catch (error) {
      console.error('Error starting vehicle tracking:', error);
      return false;
    }
  }

  /**
   * Start tracking vehicles for a single service (backward compatibility)
   * @param {string} serviceNumber - The service number to track
   * @returns {Promise<boolean>} True if tracking started successfully
   */
  async function start(serviceNumber) {
    return startServices([serviceNumber]);
  }

  /**
   * Stop tracking vehicles and clear map
   */
  function stop() {
    if (intervalId) {
      clearRafInterval(intervalId);
      intervalId = null;
    }

    trackedServices.clear();
    serviceRouteIds.clear();
    currentVehicles.clear();

    // Clear vehicles from map
    if (map && map.getSource('buses-service')) {
      map.getSource('buses-service').setData({
        type: 'FeatureCollection',
        features: [],
      });
    }

    // Notify subscribers of empty vehicles
    subscribers.forEach((callback) => callback([]));
  }

  /**
   * Get current tracking status
   * @returns {Object} Current tracking status
   */
  function getStatus() {
    return {
      isTracking: intervalId !== null,
      serviceNumbers: Array.from(trackedServices),
      routeIds: Array.from(serviceRouteIds.values()),
    };
  }

  /**
   * Get current vehicles (all tracked services combined)
   * @returns {Array} Current vehicles array
   */
  function getVehicles() {
    const allVehicles = [];
    currentVehicles.forEach((vehicles) => {
      allVehicles.push(...vehicles);
    });
    return allVehicles;
  }

  /**
   * Subscribe to vehicle updates
   * @param {Function} callback - Callback function to receive vehicle updates
   * @returns {Function} Unsubscribe function
   */
  function subscribe(callback) {
    subscribers.add(callback);
    // Immediately call with current vehicles
    const current = getVehicles();
    if (current.length > 0) {
      callback(current);
    }
    return () => subscribers.delete(callback);
  }

  return {
    start,
    startServices, // New method for multiple services
    stop,
    getStatus,
    getVehicles,
    subscribe,
  };
}
