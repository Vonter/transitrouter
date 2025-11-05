import { getApiUrl } from '../city-config.js';

/**
 * Utility to fetch live bus arrival data from the arrivals API
 * @param {string} apiPath - The API path from city config
 * @param {string|number} stationId - The station/stop ID
 * @returns {Promise} Promise resolving to arrival data
 */
export async function fetchArrivals(apiPath, stationId) {
  if (!apiPath || !stationId) {
    return null;
  }

  try {
    const url = `${getApiUrl(apiPath)}?stationid=${stationId}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch arrivals: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching arrivals:', error);
    return null;
  }
}

/**
 * Extract service numbers from arrivals data
 * @param {Object} arrivalsData - The API response containing services
 * @returns {Array} Array of service numbers
 */
export function extractServiceNumbers(arrivalsData) {
  if (
    !arrivalsData ||
    !arrivalsData.services ||
    arrivalsData.services.length === 0
  ) {
    return [];
  }

  return arrivalsData.services.map((service) => service.no).filter(Boolean);
}

/**
 * Get the next arrival for a specific service
 * @param {Object} arrivalsData - The API response containing services
 * @param {string} serviceNo - The service number to find
 * @returns {Object|null} The next arrival object or null if not found
 */
export function getNextArrivalForService(arrivalsData, serviceNo) {
  if (!arrivalsData || !arrivalsData.services) {
    return null;
  }

  const service = arrivalsData.services.find((s) => s.no === serviceNo);
  return service?.next || null;
}

/**
 * Group arrivals by service number with all their trips
 * @param {Object} arrivalsData - The API response containing services
 * @returns {Object} Object with service numbers as keys and their arrivals as values
 */
export function groupArrivalsByService(arrivalsData) {
  if (!arrivalsData || !arrivalsData.services) {
    return {};
  }

  const grouped = {};

  arrivalsData.services.forEach((service) => {
    if (!grouped[service.no]) {
      grouped[service.no] = {
        destination: service.destination,
        frequency: service.frequency,
        arrivals: [],
      };
    }

    // Add all available arrivals (next, next2, next3)
    if (service.next) grouped[service.no].arrivals.push(service.next);
    if (service.next2) grouped[service.no].arrivals.push(service.next2);
    if (service.next3) grouped[service.no].arrivals.push(service.next3);
  });

  return grouped;
}

/**
 * Convert duration_ms to a human-readable time string
 * @param {number} durationMs - Duration in milliseconds
 * @returns {string} Human-readable time string (e.g., "5 min", "1 min", "Arriving")
 */
export function formatArrivalTime(durationMs) {
  if (!durationMs || durationMs < 0) {
    return 'N/A';
  }

  const minutes = Math.floor(durationMs / 60000);

  if (minutes === 0) {
    return 'Arriving';
  } else if (minutes === 1) {
    return '1 min';
  } else {
    return `${minutes} min`;
  }
}

/**
 * Check if arrival data is fresh (less than 5 minutes old based on first arrival)
 * @param {Object} arrivalsData - The API response containing services
 * @returns {boolean} True if data appears fresh
 */
export function isArrivalDataFresh(arrivalsData) {
  if (
    !arrivalsData ||
    !arrivalsData.services ||
    arrivalsData.services.length === 0
  ) {
    return false;
  }

  // Check if at least one service has a next arrival
  return arrivalsData.services.some(
    (service) => service.next && service.next.duration_ms >= 0,
  );
}
