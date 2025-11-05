# TransitRouter

Forked from BusRouter SG: https://github.com/cheeaun/busrouter-sg

Explore transit stops and routes across multiple cities on an interactive map.

[**Website**](https://transitrouter.vonter.in/)

[![Screenshot of TransitRouter](screenshots/screenshot-1.jpg)](https://transitrouter.vonter.in/)

[![Screenshot of TransitRouter](screenshots/screenshot-2.jpg)](https://transitrouter.vonter.in/)

## ✨ Features

- **All** transit stops shown even in low zoom levels.
- **Full routes** display with all stops for every service.
- View all routes **passing through** a stop.
- Supports any transit network with a GTFS feed.

## Technicalities

### Data

- Bengaluru: [Vonter/bmtc-gtfs](https://github.com/Vonter/bmtc-gtfs)
- Chennai: [ungalsoththu/ChennaiGTFS](https://github.com/ungalsoththu/ChennaiGTFS)
- Delhi: [OTD Delhi](https://otd.delhi.gov.in/data/static/)
- Goa: [KTCL Goa](https://ktclgoa.com/gtfs/)
- Kochi: [Jungle Bus](https://jungle-bus.github.io/KochiTransport/)
- Pune: [pmpml-gtfs](https://github.com/croyla/pmpml-gtfs)
- Indian Railways: [Neo2308/indianrailways-gtfs](https://github.com/Neo2308/indianrailways-gtfs/)

### Processing GTFS Data

The project includes Python scripts to process GTFS feeds into optimized JSON formats:

#### `routes.py` - Generate routes, services, and stops data
```bash
cd data
./routes.py --gtfs-path bmtc.zip --min-trips 2
```

This generates:
- `stops.min.json` - All stops with coordinates and names
- `routes.min.json` - Route shapes/polylines for map visualization
- `services.min.json` - Service patterns (stops sequence per route)

#### `schedule.py` - Generate per-stop schedule data
```bash
cd data
./schedule.py --gtfs-path bmtc.zip --city blr --min-trips 2
```

This generates `data/$city/schedule/$stop_id.json` files containing scheduled times for all routes passing through each stop. These files serve as fallback data when live arrival information is unavailable.

#### `firstlast.py` - Generate first/last arrival times
```bash
cd data
./firstlast.py --city blr
```

This generates `data/$city/firstlast.min.json` containing the earliest and latest arrival times for each route at each stop. The format follows the `route_no earliest_weekday latest_weekday earliest_saturday latest_saturday earliest_sunday latest_sunday` convention where times are in HHMM format.

#### `visualization/build-routes.mjs` - Build routes for 3D visualization
```bash
cd visualization
node build-routes.mjs --city blr
```

#### `visualization/build-stops.mjs` - Build stops for 3D visualization
```bash
cd visualization
node build-stops.mjs --city blr
```

**Required dependencies:**
```bash
pip install pandas polyline
```

### Web App

The scripts for the web app:

- `npm start` - start server for development
- `npm run build` - build for production and deployment, in `./dist` folder.

## TODO

Base Functionality:
    - `bus-diagram/` page for visualizing major stops in passing routes
User Experience
    - Navigation flow
    - Typography/styling of elements
Extend Support:
    - Add OSM to rail.json script
    - CI Pipeline to process all GTFS
    - More cities
    - Cleanup unused dependencies and components
Release Collaterals:
    - Update styling for OpenFreeMap tiles to resemble original PMTiles
    - New custom assets for TransitRouter
Future Goals:
    - Interchange stops support
    - Multi-operator support
    - Multi-modal support
    - Categorizing routes and stops by frequency or importance

## 📜 License

[MIT](LICENSE)

## 🙇‍ Credits

- Forked from [BusRouter SG](https://github.com/cheeaun/busrouter-sg/)
