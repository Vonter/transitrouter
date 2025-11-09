import { getApiUrl } from '../city-config.js';

/**
 * Fetch live vehicles data from the vehicles API
 * Accepts either route name (routetext) or route ID
 * @param {string} apiPath - The API path from city config
 * @param {string|number} routeIdentifier - The route name (e.g., "KIA-14") or route ID
 * @param {number} serviceTypeId - The service type ID (default: 0 for all types)
 * @returns {Promise} Promise resolving to vehicle data with vehicles array and geoJSON
 */
export async function fetchVehicles(
  apiPath,
  routeIdentifier,
  serviceTypeId = 0,
) {
  if (!apiPath || !routeIdentifier) {
    return null;
  }

  try {
    // Determine if routeIdentifier is a number (route ID) or string (route name)
    const isRouteId = typeof routeIdentifier === 'number';
    const paramName = isRouteId ? 'routeid' : 'routetext';
    const paramValue = encodeURIComponent(routeIdentifier);

    const url = `${getApiUrl(apiPath)}?${paramName}=${paramValue}&servicetypeid=${serviceTypeId}`;
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
 * Reconstruct vehicle location from GeoJSON feature
 * Location is stored in GeoJSON coordinates to reduce redundancy
 * @param {Object} geoJSON - GeoJSON FeatureCollection
 * @param {string} vehicleId - Vehicle ID to look up
 * @returns {Object|null} Location object with lat and lng, or null if not found
 */
export function getVehicleLocationFromGeoJSON(geoJSON, vehicleId) {
  if (!geoJSON || !geoJSON.features || !vehicleId) {
    return null;
  }

  const feature = geoJSON.features.find(
    (f) => f.id === vehicleId || f.properties?.vehicleId === vehicleId,
  );

  if (!feature || !feature.geometry || !feature.geometry.coordinates) {
    return null;
  }

  // GeoJSON coordinates are [longitude, latitude]
  const [lng, lat] = feature.geometry.coordinates;
  return { lat, lng };
}

/**
 * Enrich vehicles array with location data from GeoJSON
 * Useful when location is needed but was removed to reduce redundancy
 * @param {Array} vehicles - Array of vehicle objects (without location)
 * @param {Object} geoJSON - GeoJSON FeatureCollection with vehicle locations
 * @returns {Array} Vehicles array with location added
 */
export function enrichVehiclesWithLocation(vehicles, geoJSON) {
  if (!vehicles || !geoJSON) {
    return vehicles || [];
  }

  return vehicles.map((vehicle) => {
    const location = getVehicleLocationFromGeoJSON(geoJSON, vehicle.vehicleId);
    return location ? { ...vehicle, location } : vehicle;
  });
}

/**
 * Convert vehicles to GeoJSON features for map display
 * Only includes minimal properties needed for map rendering
 * Full vehicle data is available in the vehicles array, linked by vehicleId
 * @param {Array} vehicles - Array of vehicle objects with location
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
        return false;
      }
      // Filter out invalid coordinates (0,0 or null island)
      if (vehicle.location.lat === 0 && vehicle.location.lng === 0) {
        return false;
      }
      return true;
    })
    .map((vehicle, index) => ({
      type: 'Feature',
      id: vehicle.vehicleId || `vehicle-${index}`,
      properties: {
        vehicleId: vehicle.vehicleId,
        vehicleNumber: vehicle.vehicleNumber, // Needed for text label on map
        heading: vehicle.heading, // Needed for icon rotation
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
 * Create a vehicle tracker instance for managing live vehicles
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
  const currentVehicles = new Map(); // Map service number to vehicles array
  const routeIdCache = new Map(); // Cache route IDs: service number -> route ID
  const subscribers = new Set(); // Subscribers for vehicle updates

  /**
   * Update vehicles for all tracked services
   */
  async function updatePositions() {
    const vehicleTracking = cityConfig?.liveVehicles;

    // Early return if vehicle tracking is disabled or no services are tracked
    if (!vehicleTracking?.enabled || trackedServices.size === 0) {
      return;
    }

    try {
      // Fetch vehicles for all tracked services in parallel
      const fetchPromises = Array.from(trackedServices).map(
        async (serviceNumber) => {
          try {
            // Check cache for route ID first
            const cachedRouteId = routeIdCache.get(serviceNumber);
            const routeIdentifier = cachedRouteId || serviceNumber;

            const response = await fetchVehicles(
              vehicleTracking.apiPath,
              routeIdentifier,
            );

            // Cache the route ID from the response if available
            if (response && response.routeId) {
              routeIdCache.set(serviceNumber, response.routeId);
            }

            return { serviceNumber, response };
          } catch (error) {
            console.error(
              `Error fetching vehicles for service ${serviceNumber}:`,
              error,
            );
            return { serviceNumber, response: null };
          }
        },
      );

      const results = await Promise.all(fetchPromises);

      // Combine all vehicles from all services
      const allVehicles = [];

      results.forEach(({ serviceNumber, response }) => {
        if (response) {
          if (response.vehicles) {
            // Check if vehicles have location data
            const vehiclesWithLocation = response.vehicles.filter(
              (v) =>
                v.location &&
                typeof v.location.lat === 'number' &&
                typeof v.location.lng === 'number',
            );

            currentVehicles.set(serviceNumber, response.vehicles);
            allVehicles.push(...response.vehicles);
          }
        }
      });

      // Generate GeoJSON from vehicles on the client side
      const combinedGeoJSON = vehiclesToGeoJSON(allVehicles);

      // Update map if source exists
      if (map && map.getSource('buses-service')) {
        map.getSource('buses-service').setData(combinedGeoJSON);
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

    const vehicleTracking = cityConfig?.liveVehicles;

    if (!vehicleTracking?.enabled) {
      console.log('Vehicle tracking not enabled');
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
      currentVehicles.clear();

      // Add services to tracking
      serviceNumbers.forEach((serviceNumber) => {
        trackedServices.add(serviceNumber);
      });

      if (trackedServices.size === 0) {
        console.warn('No valid services to track');
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
