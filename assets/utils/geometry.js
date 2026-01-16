/**
 * Shared geometry utilities for polyline operations
 * Used by both app.js and arrival.js
 */

/**
 * Calculate Euclidean distance between two points
 * Uses optimized math operations
 * @param {Array} p1 - First point [lng, lat]
 * @param {Array} p2 - Second point [lng, lat]
 * @returns {number} Distance
 */
export const pointDistance = (p1, p2) => {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Calculate squared distance (faster when you only need to compare distances)
 * @param {Array} p1 - First point [lng, lat]
 * @param {Array} p2 - Second point [lng, lat]
 * @returns {number} Squared distance
 */
export const pointDistanceSquared = (p1, p2) => {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  return dx * dx + dy * dy;
};

/**
 * Find the closest point on a line segment to a given point
 * @param {Array} point - The point [lng, lat]
 * @param {Array} segmentStart - Segment start [lng, lat]
 * @param {Array} segmentEnd - Segment end [lng, lat]
 * @returns {Array} Closest point on segment [lng, lat]
 */
export const closestPointOnSegment = (point, segmentStart, segmentEnd) => {
  const [px, py] = point;
  const [x1, y1] = segmentStart;
  const [x2, y2] = segmentEnd;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return segmentStart;
  const t = Math.max(
    0,
    Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared),
  );
  return [x1 + t * dx, y1 + t * dy];
};

/**
 * Find the closest point on a polyline to a given point
 * @param {Array} point - The point [lng, lat]
 * @param {Array} coordinates - Array of polyline coordinates
 * @returns {Object} { point, segmentIndex, distance }
 */
export const findClosestPointOnPolyline = (point, coordinates) => {
  let minDistance = Infinity;
  let closestPoint = null;
  let closestSegmentIndex = -1;

  for (let i = 0, len = coordinates.length - 1; i < len; i++) {
    const closestOnSegment = closestPointOnSegment(
      point,
      coordinates[i],
      coordinates[i + 1],
    );
    const distance = pointDistance(point, closestOnSegment);
    if (distance < minDistance) {
      minDistance = distance;
      closestPoint = closestOnSegment;
      closestSegmentIndex = i;
    }
  }

  return {
    point: closestPoint,
    segmentIndex: closestSegmentIndex,
    distance: minDistance,
  };
};

/**
 * Crop a polyline from a given point onwards
 * @param {Array} coordinates - Original polyline coordinates
 * @param {Array} closestPoint - The point to start from
 * @param {number} segmentIndex - The segment index where the point lies
 * @returns {Array} Cropped coordinates
 */
export const cropPolylineFromPoint = (
  coordinates,
  closestPoint,
  segmentIndex,
) => {
  if (segmentIndex < 0 || segmentIndex >= coordinates.length - 1)
    return coordinates;
  const cropped = [closestPoint, ...coordinates.slice(segmentIndex + 1)];
  return cropped.length > 1 ? cropped : coordinates;
};

// Cache for decoded polylines to avoid redundant decoding
const polylineCache = new Map();
const MAX_CACHE_SIZE = 500;

/**
 * Decode a polyline with caching
 * @param {string} encoded - Encoded polyline string
 * @param {Function} decoder - Decoder function (e.g., toGeoJSON)
 * @returns {Object} Decoded geometry
 */
export const decodePolylineCached = (encoded, decoder) => {
  if (polylineCache.has(encoded)) {
    return polylineCache.get(encoded);
  }

  const decoded = decoder(encoded);

  // Limit cache size with simple LRU-like behavior
  if (polylineCache.size >= MAX_CACHE_SIZE) {
    const firstKey = polylineCache.keys().next().value;
    polylineCache.delete(firstKey);
  }

  polylineCache.set(encoded, decoded);
  return decoded;
};

/**
 * Clear the polyline cache (useful for memory management)
 */
export const clearPolylineCache = () => {
  polylineCache.clear();
};
