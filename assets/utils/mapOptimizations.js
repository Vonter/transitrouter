/**
 * Map rendering optimizations for MapLibre GL
 * These utilities help reduce unnecessary re-renders and improve performance
 */

/**
 * Reusable empty FeatureCollection to avoid creating new objects
 */
export const EMPTY_FEATURE_COLLECTION = Object.freeze({
  type: 'FeatureCollection',
  features: [],
});

/**
 * Check if a GeoJSON source has any features
 * @param {maplibregl.Map} map - The map instance
 * @param {string} sourceId - The source ID to check
 * @returns {boolean} True if source has features
 */
export const sourceHasFeatures = (map, sourceId) => {
  const source = map.getSource(sourceId);
  if (!source) return false;
  const data = source._data;
  return data?.features?.length > 0;
};

/**
 * Batch clear multiple map sources efficiently
 * Only clears sources that actually have data to avoid unnecessary setData calls
 * @param {maplibregl.Map} map - The map instance
 * @param {string[]} sourceIds - Array of source IDs to clear
 */
export const batchClearSources = (map, sourceIds) => {
  sourceIds.forEach((sourceId) => {
    if (sourceHasFeatures(map, sourceId)) {
      map.getSource(sourceId).setData(EMPTY_FEATURE_COLLECTION);
    }
  });
};

/**
 * Batch update multiple map sources in a single frame
 * Groups updates to minimize layout thrashing
 * @param {maplibregl.Map} map - The map instance
 * @param {Array<{sourceId: string, data: object}>} updates - Array of source updates
 */
export const batchUpdateSources = (map, updates) => {
  requestAnimationFrame(() => {
    updates.forEach(({ sourceId, data }) => {
      const source = map.getSource(sourceId);
      if (source) {
        source.setData(data);
      }
    });
  });
};

/**
 * Create a throttled function that uses requestAnimationFrame
 * Better for visual updates than time-based throttling
 * @param {Function} fn - Function to throttle
 * @returns {Function} RAF-throttled function
 */
export const rafThrottle = (fn) => {
  let rafId = null;
  let lastArgs = null;

  const throttled = (...args) => {
    lastArgs = args;
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        fn(...lastArgs);
        rafId = null;
      });
    }
  };

  throttled.cancel = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  return throttled;
};

/**
 * Create a debounced function that waits for idle time
 * Good for non-critical updates that can wait
 * @param {Function} fn - Function to debounce
 * @param {number} timeout - Idle timeout in ms (default 100)
 * @returns {Function} Idle-debounced function
 */
export const idleDebounce = (fn, timeout = 100) => {
  let idleId = null;

  const debounced = (...args) => {
    if (idleId !== null) {
      cancelIdleCallback(idleId);
    }
    idleId = requestIdleCallback(
      () => {
        fn(...args);
        idleId = null;
      },
      { timeout },
    );
  };

  debounced.cancel = () => {
    if (idleId !== null) {
      cancelIdleCallback(idleId);
      idleId = null;
    }
  };

  return debounced;
};

/**
 * Batch feature state updates to reduce map re-renders
 * @param {maplibregl.Map} map - The map instance
 * @param {string} source - Source ID
 * @param {Array<{id: number|string, state: object}>} updates - Feature state updates
 */
export const batchSetFeatureState = (map, source, updates) => {
  requestAnimationFrame(() => {
    updates.forEach(({ id, state }) => {
      map.setFeatureState({ source, id }, state);
    });
  });
};

/**
 * Efficiently update feature states by clearing all first then setting new ones
 * Better than setting individual states when many features change
 * @param {maplibregl.Map} map - The map instance
 * @param {string} source - Source ID
 * @param {Array<{id: number|string, state: object}>} updates - Feature state updates
 */
export const replaceFeatureStates = (map, source, updates) => {
  // Clear all feature states at once (much faster than individual clears)
  map.removeFeatureState({ source });

  // Set new states
  updates.forEach(({ id, state }) => {
    map.setFeatureState({ source, id }, state);
  });
};

/**
 * Create features array with pre-allocated size for better memory performance
 * @param {Array} items - Source items to convert
 * @param {Function} mapper - Function to convert item to feature
 * @returns {Array} Array of features
 */
export const createFeaturesOptimized = (items, mapper) => {
  const features = new Array(items.length);
  for (let i = 0, len = items.length; i < len; i++) {
    features[i] = mapper(items[i], i);
  }
  return features;
};

/**
 * Check if map is currently animating (panning, zooming, etc.)
 * Useful to defer non-critical updates during animations
 * @param {maplibregl.Map} map - The map instance
 * @returns {boolean} True if map is animating
 */
export const isMapAnimating = (map) => {
  return map.isMoving() || map.isZooming() || map.isRotating();
};

/**
 * Wait for map to stop animating before executing callback
 * @param {maplibregl.Map} map - The map instance
 * @param {Function} callback - Function to call when idle
 * @param {number} maxWait - Maximum wait time in ms (default 2000)
 */
export const whenMapIdle = (map, callback, maxWait = 2000) => {
  if (!isMapAnimating(map)) {
    callback();
    return;
  }

  const timeoutId = setTimeout(callback, maxWait);

  const onIdle = () => {
    clearTimeout(timeoutId);
    map.off('idle', onIdle);
    callback();
  };

  map.once('idle', onIdle);
};

/**
 * Optimize bounds calculation by using a simple loop instead of creating intermediate arrays
 * @param {Array<{coordinates: [number, number]}>} items - Items with coordinates
 * @returns {{minLng: number, minLat: number, maxLng: number, maxLat: number}|null}
 */
export const calculateBoundsOptimized = (items) => {
  if (!items || items.length === 0) return null;

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (let i = 0, len = items.length; i < len; i++) {
    const [lng, lat] = items[i].coordinates;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return { minLng, minLat, maxLng, maxLat };
};

/**
 * Convert optimized bounds to MapLibre LngLatBounds format
 * @param {{minLng: number, minLat: number, maxLng: number, maxLat: number}} bounds
 * @returns {[[number, number], [number, number]]} Bounds array for fitBounds
 */
export const boundsToArray = (bounds) => {
  return [
    [bounds.minLng, bounds.minLat],
    [bounds.maxLng, bounds.maxLat],
  ];
};
