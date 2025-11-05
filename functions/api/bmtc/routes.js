/**
 * Cloudflare Pages Function for BMTC Route Search
 * Automatically deployed with your Pages project
 *
 * Endpoint: /api/bmtc/routes?routetext=kia-1
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
    // Get route text from URL query parameter
    const url = new URL(request.url);
    const routeText = url.searchParams.get('routetext');

    if (!routeText) {
      return new Response(
        JSON.stringify({ error: 'routetext parameter is required' }),
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
    console.log('BMTC Route Search API Request:', {
      routetext: routeText,
    });

    // Fetch data from BMTC API
    const bmtcResponse = await fetch(
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

    if (!bmtcResponse.ok) {
      throw new Error(`BMTC API returned ${bmtcResponse.status}`);
    }

    // Read the response body once and parse it
    const result = await bmtcResponse.json();

    // Log the parsed result
    console.log('BMTC Route Search API Response:', result);

    // Check if API returned valid data
    if (!result.Issuccess || !result.data || result.data.length === 0) {
      return new Response(
        JSON.stringify({
          routes: [],
          message: 'No routes found',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
            ...getCORSHeaders(),
          },
        },
      );
    }

    // Convert BMTC API response to a cleaner format
    const routes = result.data.map((route) => ({
      routeNo: route.routeno,
      routeId: route.routeparentid,
      responseCode: route.responsecode,
      row: route.row,
    }));

    return new Response(JSON.stringify({ routes }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour since route IDs don't change often
        ...getCORSHeaders(),
      },
    });
  } catch (error) {
    console.error('BMTC Route Search API Function Error:', error);
    return new Response(
      JSON.stringify({
        error: 'Failed to search routes',
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
