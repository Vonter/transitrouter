# TransitRouter E2E Tests

End-to-end tests using [Playwright](https://playwright.dev/) across Desktop Chrome, Mobile Chrome (Pixel 5), and Mobile Safari (iPhone 12).

## Running Tests

```bash
# Run all tests headless
npx playwright test

# Run with browser visible (watch mode)
npx playwright test --headed

# Run Playwright UI mode (interactive)
npx playwright test --ui

# Run a single spec file
npx playwright test tests/e2e/search.spec.js --headed

# Run only chromium
npx playwright test --project=chromium --headed
```

> **Note:** The dev server must be running on `http://localhost:1234` before tests start (or configure `webServer` in playwright.config.js).

## Test Files & Coverage (~131 tests × 3 browsers)

| File | Tests | What it covers |
|------|-------|----------------|
| `main-page.spec.js` | 9 | Page load, map render, search input, meta tags, service list popover, tooltip, console errors |
| `search.spec.js` | 10 | Focus, expand, search by name/code/number, no-results state, cancel, navigation on click, clear input |
| `stop-popover.spec.js` | 3 | URL hash, popover attachment, map on stop page. _Detailed popover tests in navigation.spec.js (serial)_ |
| `service-page.spec.js` | 6 | Service page load, console errors, multi-route mode (float pill, service tags, intersections, remove button) |
| `navigation.spec.js` | 10 | **Serial.** Stop/service popover open/close, back nav, deep links, arrivals link, map persistence |
| `arrival-page.spec.js` | 9 | Arrival page load, title, container, city-prefix redirect, dark mode, viewport |
| `first-last.spec.js` | 7 | First/last page load, table structure, row data, dark mode, HTTP status |
| `diagram.spec.js` | 6 | Diagram container (hidden element, uses `toBeAttached`), Google Fonts, dark mode |
| `visualization.spec.js` | 9 | Map, side panel, status, tooltip, toggle button, HTTP status, console errors |
| `city-drawer.spec.js` | 11 | Open/close drawer, city list with flags, Escape key, theme toggle, intro text, GitHub link |
| `between-routes.spec.js` | 6 | Between-stops popover, start/end names, close, invalid stop IDs |
| `passing-routes.spec.js` | 6 | Passing routes float pill, service tags, multi-route link |
| `theme.spec.js` | 6 | Dark/light localStorage, persistence across pages, meta theme-color |
| `data-loading.spec.js` | 11 | JSON data files, valid structure, caching, manifest, CORS, network requests |
| `responsive.spec.js` | 14 | PWA manifest, OG/Twitter meta, viewport, desktop (1280px) & mobile (375px) layouts, a11y |
| `routes-smoke.spec.js` | 8 | Smoke tests: all 5 pages + 3 hash routes — HTTP status, marker visibility, zero console errors |

## Key Design Decisions

- **Serial navigation tests:** `navigation.spec.js` runs in serial mode to reliably test popover expand/collapse, which is timing-sensitive under parallel execution.
- **Hash URL format:** All hash routes must include the city prefix: `/#/blr/stops/08057`, not `/#/stops/08057`. The app's `getRoute()` parser treats the first path segment as a city code.
- **Diagram visibility:** The `#diagram` element is hidden by CSS — tests use `toBeAttached()` instead of `toBeVisible()`.
- **Screenshots on failure:** Configured in `playwright.config.js` — check `test-results/` after a failed run.
