# TransitRouter

Multi-city transit route explorer (Preact + MapLibre GL). Displays interactive maps with transit stops, routes, live arrivals, and vehicle tracking across cities.

## Quick Reference

```sh
pnpm install              # Install dependencies (pnpm only, engine-strict)
pnpm run dev              # Full-stack dev server (Parcel watch + Wrangler Pages)
pnpm run start            # Frontend-only dev server (Parcel, port 8888)
pnpm run build            # Production build → dist/
pnpm run test:e2e         # Playwright E2E tests
pnpm run gtfs             # Process raw GTFS feeds (Python)
pnpm run data             # Prepare data files for dist/
```

## Architecture

- **UI framework:** Preact 10 with hooks — JSX pragma is `h` (see `.babelrc`), `react` aliased to `preact/compat`
- **Maps:** MapLibre GL 5 + Deck.GL 9 + Protomaps basemaps
- **Bundler:** Parcel 2 (zero-config, no scope hoisting)
- **State:** Preact hooks only (no external state library)
- **Routing:** Hash-based (`/#/city/page/value/subpage`) parsed by `getRoute()`
- **Styling:** Plain CSS, dark mode via `.dark` class on `<html>`
- **Service workers:** Workbox strategies, disabled on localhost
- **Deploy:** Cloudflare Pages

## Project Structure

```
assets/              Main app source
  app.js             Main map application entry
  arrival.js         Live arrivals page entry
  timetable.js       Timetable page entry
  city-config.js     Per-city config (bounds, APIs, feature flags)
  components/        Preact components (PascalCase)
  utils/             Utility modules (camelCase)
    theme.js         Dark mode colors & map styles
    specialID.js     FNV-1a hash encoding for MapLibre feature IDs
    geometry.js      Polyline operations
    fetchArrivals.js Live arrival data + staleness filtering
arrival/             Arrivals page HTML
beta/                Beta features (timetable, visualization)
diagram/             Route diagram visualization
data/                GTFS processing scripts (Python) + per-city JSON
functions/           Cloudflare Functions (serverless API endpoints)
tests/e2e/           Playwright E2E tests
i18n/                Internationalization (English only)
tasks/               Build tasks (header generation)
```

## Entry Points (Parcel)

- `index.html` — Main map app
- `arrival/index.html` — Arrivals page
- `beta/timetable/index.html` — Timetable
- `diagram/index.html` — Route diagrams
- `beta/visualization/index.html` — 3D visualization

## Code Conventions

- **Package manager:** pnpm only
- **Formatting:** Prettier — 2 spaces, single quotes, trailing commas (`.prettierrc`)
- **Naming:** camelCase for functions/variables, PascalCase for components, SCREAMING_SNAKE_CASE for constants
- **Components:** Functional Preact components with hooks, `.jsx` or `.js` extension
- **Imports:** Preact → external libs → local utilities → components → assets
- **Comments:** Only where logic isn't self-documenting
- **No TypeScript** — plain JavaScript throughout

## Testing

- **Framework:** Playwright with 3 profiles: Desktop Chrome, Mobile Chrome, Mobile Safari
- **Location:** `tests/e2e/`
- **Config:** `playwright.config.js` — 30s timeout, HTML reporter, traces on first retry
- **Dev server:** Auto-starts `pnpm run start` on port 8888
- **CI mode:** 2 retries, 1 worker; local: 0 retries, parallel

## Multi-City System

City config in `assets/city-config.js` defines 13+ cities. Each city has:
- Bounds, center, zoom levels
- API paths for live arrivals/vehicles (optional per city)
- Feature flags (liveArrivals, liveVehicles, stopRoutes, etc.)
- Name normalization rules
- Data at `/data/{city}/` (stops.min.json, routes.min.json, services.min.json)

## Dark Mode

- Theme stored in localStorage key `theme` (`light` | `dark`)
- Preload script in `index.html` applies `.dark` class before render to prevent flash
- Map styles: `/data/style.json` (light) / `/data/style-dark.json` (dark)
- Color palette defined in `assets/utils/theme.js`

## Performance Patterns

- MapLibre feature state API for efficient layer updates (no full redraws)
- requestAnimationFrame throttling for frequent updates
- Lazy-loaded schedule data per stop
- Minified JSON data files (`.min.json`)
- Workbox caching: 30 days versioned assets, 7 days data files
