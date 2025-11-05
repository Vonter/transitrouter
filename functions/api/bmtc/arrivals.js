/**
 * Cloudflare Pages Function for BMTC Live Arrival Data
 * Automatically deployed with your Pages project
 *
 * Endpoint: /api/bmtc/arrivals?stationid=20820
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
    // Get station ID from URL query parameter
    const url = new URL(request.url);
    const stationId = url.searchParams.get('stationid');

    if (!stationId) {
      return new Response(
        JSON.stringify({ error: 'stationid parameter is required' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...getCORSHeaders(),
          },
        },
      );
    }

    // Log the request body
    console.log('BMTC API Request:', {
      stationid: parseInt(stationId),
      triptype: 1,
    });

    // Fetch data from BMTC API
    const bmtcResponse = await fetch(
      'https://bmtcmobileapi.karnataka.gov.in/WebAPI/GetMobileTripsData',
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
          stationid: parseInt(stationId),
          triptype: 1,
        }),
      },
    );

    if (!bmtcResponse.ok) {
      throw new Error(`BMTC API returned ${bmtcResponse.status}`);
    }

    // Read the response body once and parse it
    const result = await bmtcResponse.json();

    // Log the parsed result
    console.log('BMTC API Response:', result);

    // Check if API returned success
    if (!result.Issuccess || !result.data || result.data.length === 0) {
      return new Response(JSON.stringify({ services: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=10',
          ...getCORSHeaders(),
        },
      });
    }

    // Convert BMTC API response to transitrouter format
    const services = await convertBMTCToServices(result.data, context);

    return new Response(JSON.stringify({ services }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10', // Cache for 10 seconds
        ...getCORSHeaders(),
      },
    });
  } catch (error) {
    console.error('BMTC API Function Error:', error);
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch arrival data',
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
}

/**
 * Fetch route ID for a service number
 */
async function getRouteIdForService(routeNo, context) {
  try {
    const baseUrl = new URL(context.request.url);
    const routesApiUrl = `${baseUrl.origin}/api/bmtc/routes?routetext=${encodeURIComponent(routeNo)}`;

    const response = await fetch(routesApiUrl);
    if (!response.ok) return null;

    const data = await response.json();
    if (data.routes && data.routes.length > 0) {
      const exactMatch = data.routes.find(
        (r) => r.routeNo.toLowerCase() === routeNo.toLowerCase(),
      );
      return exactMatch ? exactMatch.routeId : null;
    }
    return null;
  } catch (error) {
    console.error(`Error fetching route ID for ${routeNo}:`, error);
    return null;
  }
}

/**
 * Fetch vehicle data for a route ID
 */
async function fetchVehicleDataForRoute(routeId) {
  try {
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
          routeid: routeId,
          servicetypeid: 0,
        }),
      },
    );

    if (!bmtcResponse.ok) return null;

    const result = await bmtcResponse.json();

    // Extract vehicles from both directions
    const vehicles = new Map();

    // Process up direction
    if (result.up?.data) {
      result.up.data.forEach((station) => {
        if (station.vehicleDetails) {
          station.vehicleDetails.forEach((vehicle) => {
            if (vehicle.vehicleid && vehicle.centerlat && vehicle.centerlong) {
              vehicles.set(vehicle.vehicleid, {
                vehicleId: vehicle.vehicleid,
                vehicleNumber: vehicle.vehiclenumber,
                location: {
                  lat: parseFloat(vehicle.centerlat),
                  lng: parseFloat(vehicle.centerlong),
                },
                heading: vehicle.heading,
                routeNo: station.routeno,
              });
            }
          });
        }
      });
    }

    // Process down direction
    if (result.down?.data) {
      result.down.data.forEach((station) => {
        if (station.vehicleDetails) {
          station.vehicleDetails.forEach((vehicle) => {
            if (vehicle.vehicleid && vehicle.centerlat && vehicle.centerlong) {
              // Only add if not already present (avoid duplicates)
              if (!vehicles.has(vehicle.vehicleid)) {
                vehicles.set(vehicle.vehicleid, {
                  vehicleId: vehicle.vehicleid,
                  vehicleNumber: vehicle.vehiclenumber,
                  location: {
                    lat: parseFloat(vehicle.centerlat),
                    lng: parseFloat(vehicle.centerlong),
                  },
                  heading: vehicle.heading,
                  routeNo: station.routeno,
                });
              }
            }
          });
        }
      });
    }

    return vehicles;
  } catch (error) {
    console.error(`Error fetching vehicle data for route ${routeId}:`, error);
    return null;
  }
}

/**
 * Convert BMTC API response to transitrouter service format
 */
async function convertBMTCToServices(data, context) {
  const servicesMap = new Map();
  const now = new Date();

  let processedCount = 0;
  let filteredCount = 0;

  // First pass: collect all unique route numbers and vehicles
  const uniqueRoutes = new Set();
  const vehicleIds = new Map(); // Map vehicle_id to trip info

  data.forEach((trip) => {
    const routeNo = trip.routeno;
    uniqueRoutes.add(routeNo);

    if (trip.vehicleid) {
      vehicleIds.set(trip.vehicleid, {
        routeNo,
        busNo: trip.busno,
      });
    }
  });

  // Fetch vehicle data for all unique routes in parallel
  const routeIdPromises = Array.from(uniqueRoutes).map(async (routeNo) => {
    const routeId = await getRouteIdForService(routeNo, context);
    return { routeNo, routeId };
  });

  const routeIds = await Promise.all(routeIdPromises);
  const routeIdMap = new Map();
  routeIds.forEach(({ routeNo, routeId }) => {
    if (routeId) routeIdMap.set(routeNo, routeId);
  });

  // Fetch vehicle data for all routes in parallel
  const vehiclePromises = Array.from(routeIdMap.entries()).map(
    async ([routeNo, routeId]) => {
      const vehicles = await fetchVehicleDataForRoute(routeId);
      return { routeNo, vehicles };
    },
  );

  const vehicleDataResults = await Promise.all(vehiclePromises);
  const allVehicles = new Map();
  vehicleDataResults.forEach(({ routeNo, vehicles }) => {
    if (vehicles) {
      vehicles.forEach((vehicle, vehicleId) => {
        allVehicles.set(vehicleId, vehicle);
      });
    }
  });

  // Second pass: process trips and attach vehicle data
  data.forEach((trip, index) => {
    const routeNo = trip.routeno;
    const destination = trip.tostationname;

    // Parse arrival time (BMTC API returns timestamps in DD-MM-YYYY format in IST timezone)
    // Example: "31-10-2025 14:30:00" means 31st October 2025, 2:30 PM IST
    const arrivalTime = parseBMTCDate(trip.arrivaltime);
    const duration_ms = arrivalTime - now;

    // Skip if bus has already arrived or is too far in the future (90 minutes)
    if (duration_ms < 0 || duration_ms > 90 * 60 * 1000) {
      filteredCount++;
      return;
    }

    processedCount++;

    const key = `${routeNo}-${destination}`;

    if (!servicesMap.has(key)) {
      servicesMap.set(key, {
        no: routeNo,
        destination: destination,
        frequency: 0,
        trips: [],
      });
    }

    const service = servicesMap.get(key);

    // Get vehicle location if available
    let vehicleLocation = null;
    if (trip.vehicleid && allVehicles.has(trip.vehicleid)) {
      const vehicle = allVehicles.get(trip.vehicleid);
      vehicleLocation = vehicle.location;
    }

    service.trips.push({
      duration_ms,
      type: 'SD', // Default to single deck
      load: trip.devicestatusflag === 1 ? 'SEA' : 'SDA', // SEA if tracking available
      feature: 'WAB',
      visit_number: 1,
      origin_code: trip.fromstationname,
      destination_code: trip.tostationname,
      vehicle_id: trip.vehicleid,
      bus_no: trip.busno,
      location: vehicleLocation, // Add vehicle location if available
    });
    service.frequency++;
  });

  // Convert to array format expected by the client
  const services = Array.from(servicesMap.values()).map((service) => {
    // Sort trips by arrival time
    service.trips.sort((a, b) => a.duration_ms - b.duration_ms);

    const result = {
      no: service.no,
      destination: service.destination,
      frequency: service.frequency,
    };

    // Assign next, next2, next3
    if (service.trips.length > 0) result.next = service.trips[0];
    if (service.trips.length > 1) result.next2 = service.trips[1];
    if (service.trips.length > 2) result.next3 = service.trips[2];

    return result;
  });

  return services;
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
