# Data

### Source GTFS Data

- Bengaluru: [Vonter/bmtc-gtfs](https://github.com/Vonter/bmtc-gtfs)
- Chennai: [ungalsoththu/ChennaiGTFS](https://github.com/ungalsoththu/ChennaiGTFS)
- Delhi: [OTD Delhi](https://otd.delhi.gov.in/data/static/)
- Goa: [KTCL Goa](https://ktclgoa.com/gtfs/)
- Kochi: [Jungle Bus](https://jungle-bus.github.io/KochiTransport/)
- Pune: [pmpml-gtfs](https://github.com/croyla/pmpml-gtfs)
- Indian Railways: [Neo2308/indianrailways-gtfs](https://github.com/Neo2308/indianrailways-gtfs/)
- Greyhound: [Greyhound, Flixbus](http://gtfs.gis.flix.tech/gtfs_generic_us.zip)

### Processing GTFS Data

To process the GTFS data, run the following command:
```bash
cd data
./process.py
```

This will process all the GTFS data and generate the required files for the web app. The following Python scripts are run as part of the process.py script to generate optimized JSON files:

#### `routes.py` - Generate routes, services, and stops data
```bash
cd data
./routes.py --gtfs-path gtfs.zip --city blr --min-trips 2
```

This generates:
- `stops.min.json` - All stops with coordinates and names
- `routes.min.json` - Route shapes/polylines for map visualization
- `services.min.json` - Service patterns (stops sequence per route)

#### `schedule.py` - Generate per-stop schedule data
```bash
cd data
./schedule.py --gtfs-path gtfs.zip --city blr --min-trips 2
```

This generates `data/$city/schedule/$stop_id.json` files containing scheduled times for all routes passing through each stop. These files serve as fallback data when live arrival information is unavailable.

#### `firstlast.py` - Generate first/last arrival times
```bash
cd data
./firstlast.py --city blr
```

This generates `data/$city/firstlast.min.json` containing the earliest and latest arrival times for each route at each stop. The format follows the `route_no earliest_weekday latest_weekday earliest_saturday latest_saturday earliest_sunday latest_sunday` convention where times are in HHMM format.

#### `ranking.py` - Generate stop importance rankings
```bash
cd data
./ranking.py --gtfs-path gtfs.zip --city blr
```

This generates `data/$city/ranking.min.json` containing the importance rankings for each stop.

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