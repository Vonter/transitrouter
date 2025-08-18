<div align="center">
  # BusRouter BLR
</div>

Forked from BusRouter SG: https://github.com/cheeaun/busrouter-sg

Explore bus stops and routes on the map for all bus services in Bengaluru.

[**Website**](https://busrouter-blr.pages.dev/)

[![Screenshot of BusRouter BLR](screenshots/screenshot-1.jpg)](https://busroutes-blr.pages.dev/)

[![Screenshot of BusRouter BLR](screenshots/screenshot-2.jpg)](https://busroutes-blr.pages.dev/)

## ✨ Features

- **All** bus stops shown even in low zoom levels.
- **Full routes** display with all stops for every service.
- View all routes **passing through** a stop.

## Technicalities

### Data

Available here: [Vonter/bmtc-gtfs](https://github.com/Vonter/bmtc-gtfs).

### Web App

The scripts for the web app:

- `npm start` - start server for development
- `npm run build` - build for production and deployment, in `./dist` folder.

## TODO

- Replace BusRouter SG assets with new assets for BusRouter BLR
- Cleanup unused dependencies and components
- Data creation for `visualization/` sub-page
- Timetable schedules for categorizing routes and stops by frequency
- Live tracking for real-time arrivals at bus stops

## 📜 License

[MIT](LICENSE)

## 🙇‍ Credits

- Forked from [BusRouter SG](https://github.com/cheeaun/busrouter-sg/)
