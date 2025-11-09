# functions

The Arrivals API and Vehicles API provide live transit data for integration into the TransitRouter frontend.

## Arrivals API

The Arrivals API provides real-time arrival information for a specific transit stop.

### Request Format

**Method:** `GET`

**URL:** `{apiBaseUrl}/{apiPath}?stationid={stationId}`

**Query Parameters:**
- `stationid` (required): The station or stop identifier. Can be a string or number.

**Example Request:**
```
GET /api/bmtc/arrivals?stationid=20820
```

### Response Format

**Content-Type:** `application/json`

**Success Response (200 OK):**

```json
{
  "services": [
    {
      "no": "KIA-14",
      "destination": "Kempegowda Bus Station",
      "frequency": 3,
      "next": {
        "duration_ms": 300000,
        "type": "SD",
        "load": "SEA",
        "feature": "WAB",
        "visit_number": 1,
        "origin_code": "Kempegowda Bus Station",
        "destination_code": "KIA Terminal",
        "vehicle_id": "12345",
        "bus_no": "KA-01-AB-1234",
        "location": {
          "lat": 12.9716,
          "lng": 77.5946
        }
      },
      "next2": {
        "duration_ms": 600000,
        "type": "SD",
        "load": "SDA",
        "feature": "WAB",
        "visit_number": 1,
        "origin_code": "Kempegowda Bus Station",
        "destination_code": "KIA Terminal",
        "vehicle_id": "12346",
        "bus_no": "KA-01-AB-1235",
        "location": null
      },
      "next3": {
        "duration_ms": 900000,
        "type": "SD",
        "load": "SDA",
        "feature": "WAB",
        "visit_number": 1,
        "origin_code": "Kempegowda Bus Station",
        "destination_code": "KIA Terminal",
        "vehicle_id": null,
        "bus_no": null,
        "location": null
      }
    }
  ]
}
```

**Empty Response (200 OK):**
```json
{
  "services": []
}
```

**Error Response (400 Bad Request):**
```json
{
  "error": "stationid parameter is required"
}
```

**Error Response (500 Internal Server Error):**
```json
{
  "error": "Failed to fetch arrival data",
  "message": "Error details"
}
```

### Response Fields

#### Top-level Object
- `services` (array, required): Array of service objects. Empty array if no services are available.

#### Service Object
- `no` (string, required): The service/route number (e.g., "KIA-14", "335E").
- `destination` (string, required): The destination name for this service direction.
- `frequency` (number, required): The number of upcoming trips for this service.
- `next` (object, optional): The next arriving trip. Present if `frequency > 0`.
- `next2` (object, optional): The second upcoming trip. Present if `frequency > 1`.
- `next3` (object, optional): The third upcoming trip. Present if `frequency > 2`.

#### Trip Object (next, next2, next3)
- `duration_ms` (number, required): Time until arrival in milliseconds. Must be non-negative and typically less than 90 minutes (5,400,000 ms).
- `type` (string, required): Vehicle type. Common values: `"SD"` (Single Deck), `"DD"` (Double Deck).
- `load` (string, required): Load status. Common values: `"SEA"` (Seats Available), `"SDA"` (Standing Available), `"LSD"` (Limited Standing).
- `feature` (string, required): Service features. Common values: `"WAB"` (Wheelchair Accessible Bus).
- `visit_number` (number, required): Visit number for this trip (typically 1).
- `origin_code` (string, required): Origin station/stop name.
- `destination_code` (string, required): Destination station/stop name.
- `vehicle_id` (string|null, optional): Unique identifier for the vehicle. `null` if vehicle tracking is not available.
- `bus_no` (string|null, optional): Vehicle registration number. `null` if not available.
- `location` (object|null, optional): Vehicle location if available. `null` if vehicle tracking is not available.
  - `lat` (number): Latitude in decimal degrees.
  - `lng` (number): Longitude in decimal degrees.

### Notes

1. **Filtering:** The API should filter out trips that have already arrived (`duration_ms < 0`) or are too far in the future (typically > 90 minutes).

2. **Sorting:** Trips within each service should be sorted by `duration_ms` in ascending order (earliest arrival first).

3. **Caching:** Responses should include appropriate cache headers (e.g., `Cache-Control: public, max-age=10`) since arrival data changes frequently.

4. **CORS:** The API must support CORS with appropriate headers for cross-origin requests from the frontend.

5. **Empty States:** When no services are available, return `{"services": []}` with status 200, not an error.

---

## Vehicles API

The Vehicles API provides real-time locations for transit vehicles on a specific route.

### Request Format

**Method:** `GET`

**URL:** `{apiBaseUrl}/{apiPath}?{routeIdentifier}&servicetypeid={serviceTypeId}`

**Query Parameters:**
- `routetext` OR `routeid` (required): Either the route name (e.g., "KIA-14") or the route ID (numeric). Only one should be provided.
- `servicetypeid` (optional): Service type filter. Defaults to `0` (all service types).

**Example Requests:**
```
GET /api/bmtc/vehicles?routetext=KIA-14&servicetypeid=0
GET /api/bmtc/vehicles?routeid=6463&servicetypeid=0
```

### Response Format

**Content-Type:** `application/json`

**Success Response (200 OK):**

```json
{
  "routeId": 6463,
  "vehicles": [
    {
      "vehicleId": "12345",
      "vehicleNumber": "KA-01-AB-1234",
      "serviceType": "Ordinary",
      "serviceTypeId": 1,
      "location": {
        "lat": 12.9716,
        "lng": 77.5946
      },
      "heading": 45,
      "eta": "5 min",
      "schedule": {
        "arrivalTime": "14:30:00",
        "departureTime": "14:35:00",
        "tripStartTime": "14:00:00",
        "tripEndTime": "15:30:00"
      },
      "actual": {
        "arrivalTime": "14:32:00",
        "departureTime": "14:36:00"
      },
      "stops": {
        "last": "Stop A",
        "current": "Stop B",
        "next": "Stop C",
        "lastLocationId": "101",
        "currentLocationId": "102",
        "nextLocationId": "103"
      },
      "stopCoveredStatus": 1,
      "tripPosition": 5,
      "lastRefresh": "31-10-2025 14:30:00",
      "lastRefreshMs": 1727704800000,
      "lastReceivedFlag": 1,
      "direction": "up",
      "stationName": "Stop B",
      "routeNo": "KIA-14"
    }
  ]
}
```

**Empty Response (200 OK):**
```json
{
  "routeId": null,
  "vehicles": [],
  "message": "No routes found"
}
```

**Error Response (400 Bad Request):**
```json
{
  "error": "Either routetext or routeid parameter is required"
}
```

**Error Response (500 Internal Server Error):**
```json
{
  "error": "Failed to fetch vehicle tracking data",
  "message": "Error details"
}
```

### Response Fields

#### Top-level Object
- `routeId` (number|null, required): The route ID if found, `null` if route lookup failed.
- `vehicles` (array, required): Array of vehicle objects with location data. Empty array if no vehicles are available.
- `message` (string, optional): Informational message (e.g., "No routes found", "No vehicle tracking data available").

#### Vehicle Object
- `vehicleId` (string, required): Unique identifier for the vehicle.
- `vehicleNumber` (string, required): Vehicle registration number.
- `location` (object, required): Vehicle location data.
  - `lat` (number): Latitude in decimal degrees.
  - `lng` (number): Longitude in decimal degrees.
- `serviceType` (string, optional): Service type name (e.g., "Ordinary", "Express").
- `serviceTypeId` (number, optional): Service type identifier.
- `heading` (number|null, optional): Vehicle heading in degrees (0-360). `null` if not available.
- `eta` (string|null, optional): Estimated time of arrival as a human-readable string.
- `schedule` (object, optional): Scheduled times.
  - `arrivalTime` (string|null): Scheduled arrival time.
  - `departureTime` (string|null): Scheduled departure time.
  - `tripStartTime` (string|null): Scheduled trip start time.
  - `tripEndTime` (string|null): Scheduled trip end time.
- `actual` (object, optional): Actual times.
  - `arrivalTime` (string|null): Actual arrival time.
  - `departureTime` (string|null): Actual departure time.
- `stops` (object, optional): Stop information.
  - `last` (string|null): Last stop name.
  - `current` (string|null): Current stop name.
  - `next` (string|null): Next stop name.
  - `lastLocationId` (string|null): Last stop location ID.
  - `currentLocationId` (string|null): Current stop location ID.
  - `nextLocationId` (string|null): Next stop location ID.
- `stopCoveredStatus` (number, optional): Stop coverage status flag.
- `tripPosition` (number, optional): Position in the trip sequence.
- `lastRefresh` (string|null, optional): Last refresh timestamp as a string.
- `lastRefreshMs` (number|null, optional): Last refresh timestamp in milliseconds (Unix epoch).
- `lastReceivedFlag` (number, optional): Flag indicating last received status.
- `direction` (string, required): Direction of travel. Values: `"up"` or `"down"`.
- `stationName` (string, required): Name of the current or nearest station.
- `routeNo` (string, required): Route/service number.

### Notes

1. **Route Lookup:** If `routetext` is provided, the API should first search for the route ID, then fetch vehicle data. The response should include the resolved `routeId` for caching purposes.

2. **Deduplication:** Vehicles should be deduplicated by `vehicleNumber` to avoid showing the same vehicle multiple times.

3. **Location Data:** All vehicles in the response must include valid `location` data with `lat` and `lng` properties. The API should filter out vehicles with:
   - Missing location data
   - Invalid coordinates (e.g., `lat: 0, lng: 0`)
   - Non-numeric latitude or longitude

4. **Caching:** Responses should include appropriate cache headers (e.g., `Cache-Control: public, max-age=15`) since vehicle positions update frequently.

5. **CORS:** The API must support CORS with appropriate headers for cross-origin requests from the frontend.

6. **Empty States:** When no vehicles are available, return empty arrays with status 200, not an error. Include a helpful `message` field.

7. **Direction Handling:** The API should handle both directions (`up` and `down`) and include the `direction` field in each vehicle object.

---

## Integration Guide

To integrate APIs for a new city or operator:

1. **Create API Endpoint Functions:**
   - Create a new function file in `functions/api/{operator}/arrivals.js`
   - Create a new function file in `functions/api/{operator}/vehicles.js`
   - Implement the request/response formats documented above to integrate with operator live data.

2. **Configure APIs in City Configuration:**
   - Add the API paths to the city configuration in `assets/city-config.js` to enable the APIs for the city.

3. **Verify Integration:**
   - Verify that the live data is being fetched and displayed correctly in the frontend.
