# TransitRouter

Forked from BusRouter SG: https://github.com/cheeaun/busrouter-sg

Explore transit stops and routes across multiple cities on an interactive map.

[**Website**](https://transitrouter.pages.dev/)

[![Screenshot of TransitRouter](screenshots/screenshot-1.jpg)](https://transitrouter.pages.dev/)

[![Screenshot of TransitRouter](screenshots/screenshot-2.jpg)](https://transitrouter.pages.dev/)

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
- Indian Railways: [Neo2308/indianrailways-gtfs](https://github.com/Neo2308/indianrailways-gtfs/)

### Web App

The scripts for the web app:

- `npm start` - start server for development
- `npm run build` - build for production and deployment, in `./dist` folder.

## TODO

- Update styling for OpenFreeMap tiles to resemble original PMTiles
- Add OSM to rail.json script
- New custom assets for TransitRouter
- Data creation for `visualization/` sub-page
- Date creation for `bus-arrival/` sub-page
- Timetable schedules for categorizing routes and stops by frequency
- Cleanup unused dependencies and components
- Live tracking for real-time arrivals at bus stops

## 📜 License

[MIT](LICENSE)

## 🙇‍ Credits

- Forked from [BusRouter SG](https://github.com/cheeaun/busrouter-sg/)
