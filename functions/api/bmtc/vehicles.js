/**
 * Cloudflare Pages Function for BMTC Live Vehicle Tracking
 * Automatically deployed with your Pages project
 *
 * Endpoint: /api/bmtc/vehicles?routetext=KIA-14&servicetypeid=0
 *           /api/bmtc/vehicles?routeid=6463&servicetypeid=0
 *
 * Accepts either routetext (route name) or routeid as parameter.
 * If routetext is provided, searches for route ID first, then fetches vehicles.
 * Returns processed GeoJSON data ready for frontend use.
 */

export async function onRequest(context) {
  const { request, env } = context;

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return handleCORS();
  }

  // Only allow GET requests
  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: getCORSHeaders(),
    });
  }

  try {
    // Get route parameters from URL query parameters
    const url = new URL(request.url);
    const routeText = url.searchParams.get('routetext');
    const routeId = url.searchParams.get('routeid');
    const serviceTypeId = url.searchParams.get('servicetypeid') || '0';

    // Must provide either routetext or routeid
    if (!routeText && !routeId) {
      return new Response(
        JSON.stringify({
          error: 'Either routetext or routeid parameter is required',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...getCORSHeaders(),
          },
        },
      );
    }

    let finalRouteId = routeId ? parseInt(routeId) : null;

    // If routetext is provided, search for route ID first
    if (routeText && !finalRouteId) {
      console.log('BMTC Route Search API Request:', {
        routetext: routeText,
      });

      // Fetch route ID from BMTC route search API
      const routeSearchResponse = await fetch(
        'https://bmtcmobileapi.karnataka.gov.in/WebAPI/SearchRoute_v2',
        {
          method: 'POST',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            lan: 'en',
            deviceType: 'WEB',
          },
          body: JSON.stringify({
            routetext: routeText.toLowerCase(),
          }),
        },
      );

      if (!routeSearchResponse.ok) {
        throw new Error(
          `BMTC Route Search API returned ${routeSearchResponse.status}`,
        );
      }

      const routeSearchResult = await routeSearchResponse.json();

      if (
        !routeSearchResult.Issuccess ||
        !routeSearchResult.data ||
        routeSearchResult.data.length === 0
      ) {
        return new Response(
          JSON.stringify({
            routeId: null,
            vehicles: [],
            geoJSON: {
              type: 'FeatureCollection',
              features: [],
            },
            message: 'No routes found',
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=15',
              ...getCORSHeaders(),
            },
          },
        );
      }

      // Find exact match (case-insensitive)
      const exactMatch = routeSearchResult.data.find(
        (route) => route.routeno.toLowerCase() === routeText.toLowerCase(),
      );

      if (!exactMatch) {
        return new Response(
          JSON.stringify({
            routeId: null,
            vehicles: [],
            geoJSON: {
              type: 'FeatureCollection',
              features: [],
            },
            message: 'No exact route match found',
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=15',
              ...getCORSHeaders(),
            },
          },
        );
      }

      finalRouteId = exactMatch.routeparentid;
      console.log('Found route ID:', finalRouteId, 'for route:', routeText);
    }

    if (!finalRouteId) {
      return new Response(
        JSON.stringify({
          error: 'Could not determine route ID',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...getCORSHeaders(),
          },
        },
      );
    }

    // Log the request
    console.log('BMTC Vehicles API Request:', {
      routeid: finalRouteId,
      servicetypeid: parseInt(serviceTypeId),
    });

    // Fetch vehicle data from BMTC API
    const bmtcResponse = await fetch(
      'https://bmtcmobileapi.karnataka.gov.in/WebAPI/SearchByRouteDetails_v4',
      {
        method: 'POST',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          lan: 'en',
          deviceType: 'WEB',
        },
        body: JSON.stringify({
          routeid: finalRouteId,
          servicetypeid: parseInt(serviceTypeId),
        }),
      },
    );

    if (!bmtcResponse.ok) {
      throw new Error(`BMTC API returned ${bmtcResponse.status}`);
    }

    // Read the response body once and parse it
    const result = await bmtcResponse.json();

    // Log the parsed result
    console.log('BMTC Vehicles API Response:', result);

    // Check if API returned valid data
    if (!result.up && !result.down) {
      return new Response(
        JSON.stringify({
          routeId: finalRouteId,
          vehicles: [],
          message: 'No vehicle tracking data available',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=15',
            ...getCORSHeaders(),
          },
        },
      );
    }

    // Convert BMTC API response to a cleaner format
    const vehicleData = {
      up: convertDirectionData(result.up),
      down: convertDirectionData(result.down),
    };

    // Extract vehicles from both directions WITH location
    // Client will generate GeoJSON from vehicles array
    const vehicles = extractVehiclesWithLocation(vehicleData);

    return new Response(
      JSON.stringify({
        routeId: finalRouteId,
        vehicles,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=15', // Cache for 15 seconds
          ...getCORSHeaders(),
        },
      },
    );
  } catch (error) {
    console.error('BMTC Vehicles API Function Error:', error);
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch vehicle tracking data',
        message: error.message,
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...getCORSHeaders(),
        },
      },
    );
  }
}

/**
 * Parse BMTC date string in DD-MM-YYYY HH:MM:SS format to JavaScript Date
 * BMTC API returns dates in IST timezone
 * @param {string} dateString - Date string in format "DD-MM-YYYY HH:MM:SS"
 * @returns {Date} JavaScript Date object in UTC
 */
function parseBMTCDate(dateString) {
  if (!dateString || dateString.trim() === '') {
    return null;
  }

  try {
    // Expected format: "31-10-2025 14:30:00" (DD-MM-YYYY HH:MM:SS in IST)
    const parts = dateString.split(' ');
    const dateParts = parts[0].split('-');
    const timeParts = parts[1] ? parts[1].split(':') : ['0', '0', '0'];

    const day = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10) - 1; // JavaScript months are 0-indexed
    const year = parseInt(dateParts[2], 10);
    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);
    const seconds = parseInt(timeParts[2], 10);

    // Create date in ISO format with IST timezone offset
    // Format: YYYY-MM-DDTHH:MM:SS+05:30
    const isoString = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}+05:30`;

    return new Date(isoString);
  } catch (e) {
    console.error('Error parsing date:', dateString, e);
    return null;
  }
}

/**
 * Convert direction data from BMTC API to a cleaner format
 */
function convertDirectionData(directionData) {
  if (
    !directionData ||
    !directionData.data ||
    directionData.data.length === 0
  ) {
    return [];
  }

  return directionData.data.map((station) => {
    const vehicles = station.vehicleDetails
      ? station.vehicleDetails.map((vehicle) => {
          // Parse last refresh time
          const lastRefreshDate = parseBMTCDate(vehicle.lastrefreshon);
          const lastRefreshMs = lastRefreshDate
            ? lastRefreshDate.getTime()
            : null;

          return {
            vehicleId: vehicle.vehicleid,
            vehicleNumber: vehicle.vehiclenumber,
            serviceType: vehicle.servicetype,
            serviceTypeId: vehicle.servicetypeid,
            location: {
              lat: parseFloat(vehicle.centerlat),
              lng: parseFloat(vehicle.centerlong),
            },
            heading: vehicle.heading,
            eta: vehicle.eta || null,
            schedule: {
              arrivalTime: vehicle.sch_arrivaltime || null,
              departureTime: vehicle.sch_departuretime || null,
              tripStartTime: vehicle.sch_tripstarttime || null,
              tripEndTime: vehicle.sch_tripendtime || null,
            },
            actual: {
              arrivalTime: vehicle.actual_arrivaltime || null,
              departureTime: vehicle.actual_departuretime || null,
            },
            stops: {
              last: vehicle.laststop,
              current: vehicle.currentstop,
              next: vehicle.nextstop,
              lastLocationId: vehicle.lastlocationid,
              currentLocationId: vehicle.currentlocationid,
              nextLocationId: vehicle.nextlocationid,
            },
            stopCoveredStatus: vehicle.stopCoveredStatus,
            tripPosition: vehicle.tripposition,
            lastRefresh: vehicle.lastrefreshon,
            lastRefreshMs: lastRefreshMs,
            lastReceivedFlag: vehicle.lastreceiveddatetimeflag,
          };
        })
      : [];

    return {
      routeId: station.routeid,
      stationId: station.stationid,
      stationName: station.stationname,
      routeNo: station.routeno,
      from: station.from,
      to: station.to,
      distanceOnStation: station.distance_on_station,
      location: {
        lat: parseFloat(station.centerlat),
        lng: parseFloat(station.centerlong),
      },
      responseCode: station.responsecode,
      isNotify: station.isnotify,
      vehicles: vehicles,
    };
  });
}

/**
 * Extract all vehicles from the API response (both directions) WITH location
 * Used for GeoJSON conversion before location is removed
 * @param {Object} vehicleData - The API response containing up and down direction data
 * @returns {Array} Array of vehicle objects with normalized structure including location, deduplicated by vehicle number
 */
function extractVehiclesWithLocation(vehicleData) {
  if (!vehicleData || (!vehicleData.up && !vehicleData.down)) {
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
 * Get CORS headers
 */
function getCORSHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/**
 * Handle CORS preflight requests
 */
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: getCORSHeaders(),
  });
}
