/**
 * Cloudflare Pages Function for stop/route metrics
 *
 * Metrics for stops and routes with timestamps.
 *
 * Endpoint: POST /api/usage/metrics
 *
 * Request body:
 * {
 *   "type": "stop_view" | "route_view",
 *   "city": "blr",
 *   "id": "22387",           // stop ID or route ID
 *   "page": "arrival" | "main"  // which app triggered the view
 * }
 *
 * Data points structure:
 * - indexes[0]: entry type (e.g., "stop_view", "route_view")
 * - blobs[0]: city code (e.g., "blr")
 * - blobs[1]: stop/route ID (e.g., "22387")
 * - blobs[2]: page source (e.g., "arrival", "main")
 * - doubles[0]: 1 (count for aggregation)
 *
 * Query examples (via GraphQL API):
 *
 * -- Count views per stop in the last 7 days:
 * SELECT blob1 as city, blob2 as stop_id, SUM(double1) as views
 * FROM USAGE_DATASET
 * WHERE index1 = 'stop_view'
 *   AND timestamp > NOW() - INTERVAL '7' DAY
 * GROUP BY blob1, blob2
 * ORDER BY views DESC
 *
 * -- Count views between two timestamps:
 * SELECT blob2 as id, SUM(double1) as views
 * FROM USAGE_DATASET
 * WHERE index1 = 'stop_view'
 *   AND timestamp >= '2024-01-01T00:00:00Z'
 *   AND timestamp < '2024-01-08T00:00:00Z'
 * GROUP BY blob2
 */

export async function onRequest(context) {
  const { request, env } = context;

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return handleCORS();
  }

  // Only allow POST
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: getCORSHeaders(),
    });
  }

  try {
    const body = await request.json();
    const { type, city, id, page } = body;

    // Validate required fields
    if (!type || !city || !id) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: type, city, id' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...getCORSHeaders(),
          },
        },
      );
    }

    // Validate entry type
    const validTypes = ['stop_view', 'route_view'];
    if (!validTypes.includes(type)) {
      return new Response(
        JSON.stringify({
          error: `Invalid type. Must be one of: ${validTypes.join(', ')}`,
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

    // Write to Analytics Engine
    // The USAGE binding must be configured in Cloudflare dashboard
    if (env.USAGE) {
      env.USAGE.writeDataPoint({
        indexes: [type],
        blobs: [city, String(id), page || 'unknown'],
        doubles: [1],
      });
    } else {
      // Log warning if not configured
      console.warn('Usage binding (USAGE) not configured');
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...getCORSHeaders(),
      },
    });
  } catch (error) {
    console.error('Metrics error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to update metrics for stop/route' }),
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

function getCORSHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: getCORSHeaders(),
  });
}
