/**
 * Stop/route metrics
 *
 * Usage:
 *   import { stopMetrics, routeMetrics } from './utils/metricsPage';
 *
 *   stopMetrics('blr', '22387', 'arrival');
 *   routeMetrics('blr', '500C', 'main');
 */

const ENDPOINT = '/api/usage/metrics';

// Debounce to avoid duplicate entries on rapid navigation
const recentEntries = new Map();
const DEBOUNCE_MS = 2000;

/**
 * Metric for a stop or route
 * @param {string} type - Metric type: 'stop_view' or 'route_view'
 * @param {string} city - City code (e.g., 'blr')
 * @param {string} id - Stop ID or route ID
 * @param {string} page - Page source: 'arrival' or 'main'
 */
const metrics = async (type, city, id, page) => {
  if (!city || !id) return;

  // Debounce duplicate entries
  const key = `${type}:${city}:${id}:${page}`;
  const now = Date.now();
  const lastRecorded = recentEntries.get(key);

  if (lastRecorded && now - lastRecorded < DEBOUNCE_MS) {
    return;
  }
  recentEntries.set(key, now);

  // Clean up old entries periodically
  if (recentEntries.size > 100) {
    for (const [k, v] of recentEntries) {
      if (now - v > DEBOUNCE_MS * 2) {
        recentEntries.delete(k);
      }
    }
  }

  try {
    // Use sendBeacon for reliable delivery even on page unload
    // Fall back to fetch if sendBeacon is not available
    const payload = JSON.stringify({ type, city, id, page });

    if (navigator.sendBeacon) {
      // Wrap in Blob with JSON content type - sendBeacon with plain string sends as text/plain
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(ENDPOINT, blob);
    } else {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {
        // Silently fail - should not break the app
      });
    }
  } catch (e) {
    // Silently fail - should not break the app
  }
};

/**
 * Metric for a stop
 * @param {string} city - City code (e.g., 'blr')
 * @param {string} stopId - Stop ID (e.g., '22387')
 * @param {string} page - Page source: 'arrival' or 'main'
 */
export const stopMetrics = (city, stopId, page) => {
  metrics('stop_view', city, stopId, page);
};

/**
 * Metric for a route
 * @param {string} city - City code (e.g., 'blr')
 * @param {string} routeId - Route/service ID (e.g., '500C')
 * @param {string} page - Page source: 'arrival' or 'main'
 */
export const routeMetrics = (city, routeId, page) => {
  metrics('route_view', city, routeId, page);
};
