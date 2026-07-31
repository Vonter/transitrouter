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

/**
 * Build a cropped polyline between two already-located closest-point results.
 * Shared by cropPolylineBetweenPoints (which locates the points itself) and
 * findBestRouteSegment (which has already located them while scoring variants).
 * @param {Array} coordinates - Original polyline coordinates
 * @param {Object} startClosest - Result of findClosestPointOnPolyline for the start point
 * @param {Object} endClosest - Result of findClosestPointOnPolyline for the end point
 * @returns {Array} Cropped coordinates between the two points
 */
const buildCroppedSegment = (coordinates, startClosest, endClosest) => {
  if (!startClosest.point || !endClosest.point) {
    return coordinates;
  }

  // Determine which point comes first along the polyline
  let actualStart = startClosest;
  let actualEnd = endClosest;

  const startSegIdx = startClosest.segmentIndex;
  const endSegIdx = endClosest.segmentIndex;

  // If start segment comes after end segment, swap them
  if (startSegIdx > endSegIdx) {
    actualStart = endClosest;
    actualEnd = startClosest;
  } else if (startSegIdx === endSegIdx) {
    // Both on same segment - determine order by position along segment
    const segStart = coordinates[startSegIdx];
    const segEnd = coordinates[startSegIdx + 1];

    // Calculate parameter t for each closest point along the segment
    // t represents position along segment (0 = start, 1 = end)
    const calculateT = (point, segStart, segEnd) => {
      const [px, py] = point;
      const [x1, y1] = segStart;
      const [x2, y2] = segEnd;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared === 0) return 0;
      const t = Math.max(
        0,
        Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared),
      );
      return t;
    };

    const startT = calculateT(actualStart.point, segStart, segEnd);
    const endT = calculateT(actualEnd.point, segStart, segEnd);

    // If start comes after end on the segment, swap them
    if (startT > endT) {
      actualStart = endClosest;
      actualEnd = startClosest;
    }
  }

  // Build the cropped polyline
  const cropped = [actualStart.point];

  // Add intermediate coordinates between the segments
  const startIdx = actualStart.segmentIndex;
  const endIdx = actualEnd.segmentIndex;

  // Ensure we have valid indices
  if (
    startIdx >= 0 &&
    endIdx >= 0 &&
    startIdx < coordinates.length - 1 &&
    endIdx < coordinates.length - 1
  ) {
    if (startIdx < endIdx) {
      // Add coordinates from after start segment to before end segment
      // This includes all intermediate points to preserve the polyline shape
      for (let i = startIdx + 1; i <= endIdx; i++) {
        if (
          coordinates[i] &&
          Array.isArray(coordinates[i]) &&
          coordinates[i].length >= 2
        ) {
          cropped.push(coordinates[i]);
        }
      }
    } else if (startIdx > endIdx) {
      // Points are in reverse order - this shouldn't happen after swapping, but handle it
      // Return the polyline in reverse order
      for (let i = startIdx; i >= endIdx; i--) {
        if (
          coordinates[i] &&
          Array.isArray(coordinates[i]) &&
          coordinates[i].length >= 2
        ) {
          cropped.push(coordinates[i]);
        }
      }
    } else {
      // Both points are on the same segment
      // When both points are on the same segment, we should still preserve the polyline structure
      // by including the segment endpoints. This ensures we follow the actual route path.
      // Include the segment end point to preserve polyline structure
      if (startIdx + 1 < coordinates.length) {
        const segmentEnd = coordinates[startIdx + 1];
        if (segmentEnd && Array.isArray(segmentEnd) && segmentEnd.length >= 2) {
          // Only add if it's different from the end point to avoid duplicates
          const endPointArr = actualEnd.point;
          if (
            !endPointArr ||
            Math.abs(segmentEnd[0] - endPointArr[0]) > 1e-9 ||
            Math.abs(segmentEnd[1] - endPointArr[1]) > 1e-9
          ) {
            cropped.push(segmentEnd);
          }
        }
      }
    }
  }

  // Add the end point (avoid duplicate if it's already the last point)
  if (
    actualEnd.point &&
    Array.isArray(actualEnd.point) &&
    actualEnd.point.length >= 2
  ) {
    const lastPoint = cropped[cropped.length - 1];
    if (
      !lastPoint ||
      Math.abs(lastPoint[0] - actualEnd.point[0]) > 1e-9 ||
      Math.abs(lastPoint[1] - actualEnd.point[1]) > 1e-9
    ) {
      cropped.push(actualEnd.point);
    }
  }

  // Validate the result before returning
  if (
    cropped.length >= 2 &&
    cropped.every((coord) => Array.isArray(coord) && coord.length >= 2)
  ) {
    return cropped;
  }

  // Fallback to original coordinates if cropping failed
  return coordinates;
};

/**
 * Crop a polyline between two points
 * @param {Array} coordinates - Original polyline coordinates
 * @param {Array} startPoint - The point to start from [lng, lat]
 * @param {Array} endPoint - The point to end at [lng, lat]
 * @returns {Array} Cropped coordinates between the two points
 */
export const cropPolylineBetweenPoints = (
  coordinates,
  startPoint,
  endPoint,
) => {
  if (!coordinates || coordinates.length < 2) return coordinates;

  const startClosest = findClosestPointOnPolyline(startPoint, coordinates);
  const endClosest = findClosestPointOnPolyline(endPoint, coordinates);

  return buildCroppedSegment(coordinates, startClosest, endClosest);
};

/**
 * Find the polyline variant (of a service's multiple shape variants) whose
 * shape best matches both endpoints, and return it cropped between them.
 * @param {Array<string>} servicePolylines - Encoded polyline variants for a service
 * @param {Array} fromCoords - Start point [lng, lat]
 * @param {Array} toCoords - End point [lng, lat]
 * @param {Function} decoder - Encoded-polyline decoder, e.g. toGeoJSON
 * @returns {Array|null} Cropped coordinates of the best-matching variant, or null
 */
export const findBestRouteSegment = (
  servicePolylines,
  fromCoords,
  toCoords,
  decoder,
) => {
  if (!servicePolylines?.length) return null;

  let bestCropped = null;
  let bestDistance = Infinity;

  for (const encoded of servicePolylines) {
    const polyline = decodePolylineCached(encoded, decoder);
    if (!polyline?.coordinates?.length) continue;

    const startClosest = findClosestPointOnPolyline(
      fromCoords,
      polyline.coordinates,
    );
    const endClosest = findClosestPointOnPolyline(toCoords, polyline.coordinates);
    if (!startClosest.point || !endClosest.point) continue;

    const totalDist = startClosest.distance + endClosest.distance;
    if (totalDist < bestDistance) {
      const cropped = buildCroppedSegment(
        polyline.coordinates,
        startClosest,
        endClosest,
      );
      if (
        Array.isArray(cropped) &&
        cropped.length >= 2 &&
        cropped.every((c) => Array.isArray(c) && c.length >= 2)
      ) {
        bestDistance = totalDist;
        bestCropped = cropped;
      }
    }
  }

  return bestCropped;
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
