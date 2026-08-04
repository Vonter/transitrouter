import './i18n';

import {
  isDark,
  mapStyle,
  C,
  routeLineGradient,
  stationTextColor,
  stationIconColor,
} from './utils/theme';
import {
  getCurrentCity,
  getCityInfo,
  getCityBounds,
  DEFAULT_CITY,
  isCitySupported,
  AVAILABLE_CITIES,
  getConfigForCity,
} from './config';
import { getApiUrl, isDevMode, isAlphaEnabled, CITY_CONFIGS } from './city-config';
import { normalizeName } from './utils/normalizeNames';
import {
  pointDistance,
  closestPointOnSegment,
  findClosestPointOnPolyline,
  findBestRouteSegment,
  cropPolylineFromPoint,
  decodePolylineCached,
} from './utils/geometry';
import { h, render, Fragment } from 'preact';
import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
} from 'preact/hooks';
import maplibregl from 'maplibre-gl';
import { toGeoJSON } from '@mapbox/polyline';
import CheapRuler from 'cheap-ruler';
import { useTranslation } from 'react-i18next';
import {
  initDataWorker,
  workerSearch,
  workerClosestStops,
  workerBetweenRoutes,
  workerNearbyStops,
} from './utils/workerClient';
import { fetchPois } from './utils/parsePoisCsv';
import { fetchGeocode, fetchReverseGeocode } from './utils/geocode';

import { encode, decode } from './utils/specialID';
import { refineWithSchedule } from './utils/raptor';
import { syncRaptorWorkerCities, searchRaptorWorker } from './utils/raptorWorkerClient';
import { sortServices } from './utils/bus';
import fetchCache from './utils/fetchCache';
import getRoute from './utils/getRoute';
import { filterStaleArrivalsFromService } from './utils/fetchArrivals';
import getWalkingMinutes from './utils/getWalkingMinutes';
import usePrevious from './utils/usePrevious';
import { createVehicleTracker } from './utils/fetchVehicles';
import { setRafInterval, clearRafInterval } from './utils/rafInterval';
import { stopMetrics, routeMetrics } from './utils/metricsPage';
import {
  paneAppliesHere,
  syncMobilePane,
  watchMobilePaneContent,
  watchMobilePaneResize,
  computeSearchBreaks,
  movePaneToBreak,
} from './utils/mobilePane';
import {
  batchClearSources,
  rafThrottle,
  replaceFeatureStates,
  createFeaturesOptimized,
} from './utils/mapOptimizations';

import BusServicesArrival from './components/BusServicesArrival';
import { CLOSE_SVG } from './components/CloseControl';
import GeolocateControl, { GEOLOCATE_SVG } from './components/GeolocateControl';
import BetweenRoutes, { sortAndFilterResults } from './components/BetweenRoutes';
import ScrollableContainer from './components/ScrollableContainer';
import StopsList from './components/StopsList.jsx';

import stopImagePath from './images/stop.png';
import stopEndImagePath from './images/stop-end.png';
import stopActiveImagePath from './images/stop-active.png';
import passingRoutesBlueImagePath from './images/passing-routes-blue.svg';
import iconSVGPath from '../icons/icon.svg';
import busTinyImagePath from './images/bus-tiny-map.png';
import metroStationSdfPath from './images/metro-station-sdf.svg';
import railStationPath from './images/rail-station.svg';
import monorailStationPath from './images/monorail-station.svg';

let city = getCurrentCity();
if (city === 'all' && !isAlphaEnabled()) {
  // #/all is an alpha feature — softlock it behind the same flag as other alpha features
  location.hash = `/${DEFAULT_CITY}`;
  city = DEFAULT_CITY;
}
const IS_ALL_MODE = city === 'all';
const dataPath = `/data/${city}`;
const routesJSONPath = `${dataPath}/routes.min.json`;
const stopsJSONPath = `${dataPath}/stops.min.json`;
const servicesJSONPath = `${dataPath}/services.min.json`;
const railJSONPath = `${dataPath}/rail.json`;

const $map = document.getElementById('map');
const STORE = {};
// All-mode: keyed by city code, holds loaded city data and tracks loading state
const cityDataMap = new Map();
const loadedCities = new Set();
const loadingCities = new Set();
const loadCityPromises = new Map(); // cityCode → Promise — allows callers to await an in-progress load
let onCityLoadedCallback = null; // set by App component to refresh search after a city loads
let onCityUnloadedCallback = null; // set by App component to refresh search after a city unloads
const activeSelectionCities = new Set();
// All-mode: city code → { lowerLat, upperLat, lowerLong, upperLong } computed from that
// city's actual stops.min.json extent (+ 4km buffer), populated by preindexAllCities.
// Used instead of the hand-authored CITY_CONFIGS bounds so the viewport-overlap check
// reflects real stop coverage rather than a manually maintained bbox.
const cityStopsBounds = new Map();
// Flat search indices populated as cities load — searched client-side in all-mode
const allModeServicesIdx = []; // { number, name, city }
const allModeStopsIdx = [];    // { number, name, suffix, city }
const allModePoisIdx = [];     // { id, name, type, lat, lon, color, city } — alpha "locations" feature
// Adjacent/overlapping cities' pois.csv commonly share the same real-world POI
// (each is independently queried from OSM over its own padded bbox), so
// de-dupe by coordinate when merging into the cross-city index.
const allModePoisSeen = new Set();
const pushAllModePois = (pois, cityCode) => {
  pois.forEach((poi, i) => {
    const key = locationKey(poi.lat, poi.lon);
    if (allModePoisSeen.has(key)) return;
    allModePoisSeen.add(key);
    allModePoisIdx.push({ ...poi, id: `${cityCode}-${i}`, city: cityCode });
  });
};
// Both all-mode load paths (the full per-city load in loadCity, and the
// lightweight name-only preindexAllCities) need the same "have we already
// indexed this city's services/stops/pois" dedup-and-push, just from
// differently-shaped source data (full stop/service objects vs raw JSON
// keyed by number) — this is the one shared entry point for both.
const AllModeIndex = {
  hasCity: (cityCode) => allModeServicesIdx.some((s) => s.city === cityCode),
  hasPois: (cityCode) => allModePoisIdx.some((p) => p.city === cityCode),
  addCity: (cityCode, { services, stops, pois } = {}) => {
    if (!AllModeIndex.hasCity(cityCode)) {
      services?.forEach(({ number, name }) => {
        allModeServicesIdx.push({ number, name: name || '', city: cityCode });
      });
      stops?.forEach(({ number, name, suffix }) => {
        allModeStopsIdx.push({ number, name: name || '', suffix, city: cityCode });
      });
    }
    if (pois && !AllModeIndex.hasPois(cityCode)) {
      pushAllModePois(pois, cityCode);
    }
  },
};
// Splits a stop list (as flattened across every selected service's route
// variants) into its unique stops and the ones repeated across 2+ services
// ("intersecting" stops, i.e. shared interchange points) — an O(n) counting
// pass replacing the previous `arr.indexOf(el) === pos` + `.includes()`
// combination, which was O(n²) over what can be hundreds of stops.
const uniqueAndIntersectingStops = (arr) => {
  const counts = new Map();
  arr.forEach((el) => counts.set(el, (counts.get(el) || 0) + 1));
  const unique = [...counts.keys()];
  const intersecting = unique.filter((el) => counts.get(el) > 1).sort();
  return { unique, intersecting };
};
const BREAKPOINT = () => window.innerWidth > 640;
const supportsHover =
  window.matchMedia && matchMedia('(any-hover: hover)').matches;
const supportsTouch =
  (window.matchMedia && matchMedia('(any-pointer: coarse)').matches) ||
  'ontouchstart' in window ||
  navigator.MaxTouchPoints > 0 ||
  navigator.msMaxTouchPoints > 0;
const ruler = new CheapRuler(1.3);

// Pane-managed popovers are display:none (0 offsetHeight/Width) until
// CupertinoPane presents them, so map-pan/fitBounds calculations that need
// a popover's expanded size have to estimate against the pane's own
// middle-break height instead of measuring the DOM node — see
// mobilePane.js's breaks config. Falls back to the real DOM measurement on
// desktop / non-touch, where the popover is still a plain CSS floating card.
const paneOrOffsetHeight = (el) =>
  paneAppliesHere(supportsTouch, BREAKPOINT)
    ? Math.round(window.innerHeight * 0.5)
    : el?.offsetHeight;

// Compute closest stops across all loaded cities for all-mode (main-thread, no worker needed)
const computeAllModeClosestStops = (lng, lat) => {
  const results = [];
  for (const [cityCode, cityData] of cityDataMap) {
    if (!cityData?.stopsDataArr) continue;
    for (const stop of cityData.stopsDataArr) {
      const dist = ruler.distance([lng, lat], stop.coordinates);
      if (dist <= 5000) results.push({ ...stop, city: cityCode, distance: dist });
    }
  }
  results.sort((a, b) => a.distance - b.distance);
  return results.slice(0, 25);
};

// Helper to decode polylines with caching
const decodePolyline = (encoded) => decodePolylineCached(encoded, toGeoJSON);

const DIRECTIONS_SVG = <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M21.71 11.29l-9-9a1 1 0 00-1.42 0l-9 9a1 1 0 000 1.42l9 9a1 1 0 001.42 0l9-9a1 1 0 000-1.42zM14 14.5V12h-4v3a1 1 0 01-2 0v-4a1 1 0 011-1h5V7.5a.5.5 0 01.85-.36l3.15 3.36a.5.5 0 010 .71l-3.15 3.15a.5.5 0 01-.85-.36z"/></svg>;
const TIMETABLE_SVG = <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;

function parseRouteKey(routeKey) {
  const first = routeKey.indexOf('|');
  const second = routeKey.indexOf('|', first + 1);
  if (first === -1 || second === -1) return null;
  return {
    service: routeKey.slice(0, first),
    destination: routeKey.slice(first + 1, second),
    variantIdx: routeKey.slice(second + 1),
  };
}

const $logo = document.getElementById('logo');

// City drawer functionality
const createCityDrawer = () => {
  const overlay = document.createElement('div');
  overlay.id = 'city-drawer-overlay';

  const drawer = document.createElement('div');
  drawer.id = 'city-drawer';

  const handle = document.createElement('div');
  handle.className = 'drawer-handle';
  handle.innerHTML = '<span></span>';
  drawer.appendChild(handle);

  const intro = document.createElement('div');
  intro.className = 'drawer-intro';
  intro.innerHTML = `
    <h2>TransitRouter</h2>
    <p>Explore transit stops and routes across cities on an interactive map.</p>
    <p>Source code on <a href="https://github.com/Vonter/transitrouter" target="_blank">GitHub</a>. Inspired by <a href="https://busrouter.sg" target="_blank" rel="noopener">busrouter.sg</a></p>
  `;

  const divider = document.createElement('hr');
  divider.className = 'drawer-divider';

  const citiesSection = document.createElement('div');
  citiesSection.className = 'drawer-cities';

  const citiesLabel = document.createElement('p');
  citiesLabel.className = 'drawer-cities-label';
  citiesLabel.textContent = 'Regions';
  citiesSection.appendChild(citiesLabel);

  const cityList = document.createElement('ul');
  cityList.className = 'drawer-city-list';

  // "All Cities" entry at the top — alpha-gated, same flag as #/all itself
  if (isAlphaEnabled()) {
    const allItem = document.createElement('li');
    allItem.className = 'drawer-city-item';
    const allFlag = document.createElement('span');
    allFlag.className = 'drawer-city-flag';
    allFlag.textContent = '🗺️';
    allFlag.setAttribute('aria-hidden', 'true');
    const allName = document.createElement('span');
    allName.className = 'drawer-city-name';
    allName.textContent = '(Test) All Sources';
    allItem.appendChild(allFlag);
    allItem.appendChild(allName);
    allItem.onclick = () => {
      hideDrawer();
      location.hash = '/all/';
      if (!IS_ALL_MODE) location.reload();
    };
    cityList.appendChild(allItem);
  }

  AVAILABLE_CITIES.forEach((cityCode) => {
    const cityConfig = getConfigForCity(cityCode);
    const item = document.createElement('li');
    item.className = 'drawer-city-item';

    const flag = document.createElement('span');
    flag.className = 'drawer-city-flag';
    flag.textContent = cityConfig.city.flag || '';
    flag.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'drawer-city-name';
    name.textContent = cityConfig.city.name;

    item.appendChild(flag);
    item.appendChild(name);
    item.onclick = () => {
      hideDrawer();
      window.location.hash = `/${cityCode}/`;
      window.location.reload();
    };
    cityList.appendChild(item);
  });

  citiesSection.appendChild(cityList);
  drawer.appendChild(intro);
  drawer.appendChild(divider);
  drawer.appendChild(citiesSection);

  // Settings section
  const settingsDivider = document.createElement('hr');
  settingsDivider.className = 'drawer-divider';
  drawer.appendChild(settingsDivider);

  const settingsLabel = document.createElement('p');
  settingsLabel.className = 'drawer-cities-label';
  settingsLabel.textContent = 'Settings';
  drawer.appendChild(settingsLabel);

  const themeSection = document.createElement('div');
  themeSection.className = 'drawer-theme';
  const themeLabel = document.createElement('span');
  themeLabel.className = 'drawer-theme-label';
  themeLabel.textContent = 'Dark Mode';
  const track = document.createElement('div');
  track.className = 'theme-toggle-track';
  track.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  track.setAttribute('role', 'switch');
  track.setAttribute('aria-checked', String(isDark));
  track.setAttribute('aria-label', 'Dark Mode');
  track.tabIndex = 0;
  track.innerHTML =
    '<span class="theme-toggle-icons">' +
    '<svg class="theme-toggle-sun" viewBox="0 0 20 20" fill="currentColor"><circle cx="10" cy="10" r="4"/><path d="M10 1v2m0 14v2M3.5 3.5l1.4 1.4m10.2 10.2l1.4 1.4M1 10h2m14 0h2M3.5 16.5l1.4-1.4m10.2-10.2l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>' +
    '<svg class="theme-toggle-moon" viewBox="0 0 20 20" fill="currentColor"><path d="M17.3 13.3A8 8 0 0 1 6.7 2.7a8 8 0 1 0 10.6 10.6z"/></svg>' +
    '</span>' +
    '<span class="theme-toggle-thumb"></span>';
  const toggleTheme = () => {
    const nowDark = document.documentElement.classList.contains('dark');
    localStorage.setItem('theme', nowDark ? 'light' : 'dark');
    location.reload();
  };
  track.onclick = toggleTheme;
  track.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleTheme();
    }
  };
  themeSection.appendChild(themeLabel);
  themeSection.appendChild(track);
  drawer.appendChild(themeSection);

  // Helper: create a setting row with label + control
  const settingRow = (labelText, control, className = 'drawer-theme') => {
    const row = document.createElement('div');
    row.className = className;
    const label = document.createElement('span');
    label.className = 'drawer-theme-label';
    label.textContent = labelText;
    row.append(label, control);
    return row;
  };

  // Helper: create a toggle switch bound to a localStorage key
  const createToggle = (key, ariaLabel, onChange) => {
    const on = localStorage.getItem(key) === 'true';
    const track = document.createElement('div');
    track.className = 'dev-toggle-track' + (on ? ' active' : '');
    track.setAttribute('role', 'switch');
    track.setAttribute('aria-checked', String(on));
    track.setAttribute('aria-label', ariaLabel);
    track.tabIndex = 0;
    track.innerHTML = '<span class="dev-toggle-thumb"></span>';
    const toggle = () => {
      const nowOn = localStorage.getItem(key) === 'true';
      localStorage.setItem(key, String(!nowOn));
      track.classList.toggle('active', !nowOn);
      track.setAttribute('aria-checked', String(!nowOn));
      onChange?.(!nowOn);
    };
    track.onclick = toggle;
    track.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    };
    return track;
  };

  // Helper: create a <select> bound to a localStorage key
  const createSelect = (key, options, fallback) => {
    const sel = document.createElement('select');
    sel.className = 'drawer-select';
    const stored = localStorage.getItem(key) || fallback;
    options.forEach(([val, text]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      if (val === stored) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => localStorage.setItem(key, sel.value);
    return sel;
  };

  // Default City select
  const storedDefault = localStorage.getItem('defaultCity');
  const cityOptions = AVAILABLE_CITIES.map((code) => {
    const cfg = getConfigForCity(code);
    return [code, `${cfg.city.flag || ''} ${cfg.city.name}`];
  });
  // "all" (every city combined — see IS_ALL_MODE) is an alpha feature,
  // same gate the /all/ route itself is softlocked behind (see the
  // city==='all' redirect guard near the top of this file) — offering it
  // as a default here without that gate would pick a default that then
  // immediately bounces back to FALLBACK_CITY for anyone without alpha
  // features on.
  if (isAlphaEnabled()) {
    cityOptions.unshift(['all', '🌐 All']);
  }
  cityOptions.unshift(['auto', 'Automatic']);
  const citySelect = createSelect(
    'defaultCity',
    cityOptions,
    storedDefault || 'blr',
  );
  drawer.appendChild(settingRow('Default City', citySelect));

  // Developer Mode toggle + dev settings panel
  const devSettings = document.createElement('div');
  devSettings.className = 'drawer-dev-settings';
  devSettings.style.display = isDevMode() ? '' : 'none';

  const devModeToggle = createToggle('devMode', 'Developer Mode', (on) => {
    devSettings.style.display = on ? '' : 'none';
    if (!on) {
      localStorage.removeItem('disableApi');
      localStorage.removeItem('refreshInterval');
      localStorage.removeItem('alphaFeatures');
    }
  });
  drawer.appendChild(settingRow('Developer Mode', devModeToggle));

  // Dev-only settings
  devSettings.appendChild(
    settingRow(
      'Alpha Features',
      createToggle('alphaFeatures', 'Alpha Features (Not recommended)'),
      'drawer-theme drawer-dev-item',
    ),
  );
  devSettings.appendChild(
    settingRow(
      'Offline Mode',
      createToggle('disableApi', 'Offline Mode'),
      'drawer-theme drawer-dev-item',
    ),
  );
  devSettings.appendChild(
    settingRow(
      'Auto-Refresh Interval',
      createSelect(
        'refreshInterval',
        [
          ['0', 'Off'],
          ['30', '30 seconds'],
          ['60', '1 minute'],
          ['120', '2 minutes'],
        ],
        '60',
      ),
      'drawer-theme drawer-dev-item',
    ),
  );
  drawer.appendChild(devSettings);

  overlay.appendChild(drawer);

  overlay.addEventListener('click', (e) => {
    if (!drawer.contains(e.target)) hideDrawer();
  });

  return overlay;
};

const drawerOverlay = createCityDrawer();
document.body.appendChild(drawerOverlay);

const showDrawer = () => {
  drawerOverlay.classList.add('open');
};

const hideDrawer = () => {
  drawerOverlay.classList.remove('open');
};

$logo.addEventListener('click', (e) => {
  e.stopPropagation();
  drawerOverlay.classList.contains('open') ? hideDrawer() : showDrawer();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerOverlay.classList.contains('open')) {
    hideDrawer();
  }
});

// Auto-locate nearest city when default is "auto" and user is at root.
function nearestCityTo(latitude, longitude) {
  let nearest = null;
  let minDist = Infinity;
  AVAILABLE_CITIES.forEach((code) => {
    const cfg = getConfigForCity(code);
    const b = cfg.city.bounds;
    if (
      latitude >= b.lowerLat &&
      latitude <= b.upperLat &&
      longitude >= b.lowerLong &&
      longitude <= b.upperLong
    ) {
      const dist = Math.hypot(
        latitude - (b.lowerLat + b.upperLat) / 2,
        longitude - (b.lowerLong + b.upperLong) / 2,
      );
      if (dist < minDist) {
        minDist = dist;
        nearest = code;
      }
    }
  });
  return nearest;
}

if (
  localStorage.getItem('defaultCity') === 'auto' &&
  (!location.hash || location.hash === '#' || location.hash === '#/')
) {
  // Fast path: Cloudflare's edge-populated request.cf (city/lat/lon), read via
  // a same-origin Function (functions/api/map/geolocator.js) - no
  // navigator.geolocation permission prompt, and no external IP-lookup
  // service (the data is already on the request that reaches the Function).
  fetch('/api/map/geolocator')
    .then((res) => res.json())
    .catch(() => null)
    .then((geo) => {
      const nearest = geo && nearestCityTo(geo.latitude, geo.longitude);
      if (nearest && nearest !== city) {
        location.hash = `/${nearest}/`;
        location.reload();
        return;
      }
      if (nearest) return; // matched current city, nothing to do

      // Fallback: geolocator gave nothing usable (e.g. local dev without a
      // real Cloudflare edge, or no city-bbox match) - fall back to the
      // browser's own (slower, permission-gated) geolocation.
      navigator.geolocation?.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          const geoNearest = nearestCityTo(latitude, longitude);
          if ((geoNearest || city) !== city) {
            location.hash = `/${geoNearest}/`;
            location.reload();
          }
        },
        () => {},
        { timeout: 5000 },
      );
    });
}

// Pins the document at scroll 0 while the keyboard opens — html/body sit a hair
// taller than the viewport (the safe-area min-height in app.css), so iOS
// scrolling a focused input into view drags the whole fixed layout with it.
//
// Time-boxed rather than cancelled on the popover's transitionend: a
// pane-managed popover has `transition: none !important` and no transitioning
// children, so that event never arrived and the loop ran at 60fps for the rest
// of the session, fighting the browser's own focus handling every frame.
const SCROLL_PIN_MS = 600;
let rafST = null;
let rafSTUntil = 0;
const rafScrollTop = () => {
  if (window.scrollY !== 0) window.scrollTo(0, 0);
  if (performance.now() >= rafSTUntil) {
    rafST = null;
    return;
  }
  rafST = requestAnimationFrame(rafScrollTop);
};
const pinScrollTop = () => {
  // Extend the window rather than start a second, independent chain.
  rafSTUntil = performance.now() + SCROLL_PIN_MS;
  if (!rafST) rafST = requestAnimationFrame(rafScrollTop);
};

const $tooltip = document.getElementById('tooltip');
function showStopTooltip(data) {
  $tooltip.innerHTML = `<span class="stop-tag">${data.number}</span> ${data.name}`;
  $tooltip.classList.add('show');
  const { x, y: top } = data;
  const left = Math.max(
    5 + $map.offsetLeft,
    Math.min(
      window.innerWidth - $tooltip.offsetWidth - 5,
      x + $map.offsetLeft - 5,
    ),
  );
  $tooltip.style.transform = `translate(${left}px, ${top}px)`;
}
function hideStopTooltip() {
  $tooltip.classList.remove('show');
}

window.requestIdleCallback =
  window.requestIdleCallback || ((cb) => setTimeout(cb, 1));

const [lowerLong, lowerLat, upperLong, upperLat] = getCityBounds();
const CACHE_TIME = 24 * 60; // 1 day
let map;
let servicesDataArr = [];
let stopsDataArr = [];
let servicesData = {};
let stopsData = {};
let routesData = {};
let poisData = []; // [{id,name,type,lat,lon,color}] — alpha "locations" feature
// Alpha "locations" feature — name resolution cache for lat,lon-only URLs.
// Populated when a search result is clicked (so the popover doesn't need a
// round trip for a name it was just shown) and by reverse-geocode lookups.
const LOCATION_KEY_PRECISION = 5; // ~1m — matches the precision search results are rendered with
const locationKey = (lat, lon) => `${lat.toFixed(LOCATION_KEY_PRECISION)},${lon.toFixed(LOCATION_KEY_PRECISION)}`;
const locationNameCache = new Map(); // locationKey → {name,type,color}
// A location matches a known POI if within ~30m of it (nearby stops/POIs are
// often a few meters apart at the same station, so this stays tight).
const POI_MATCH_DEGREES = 0.0003;
const findMatchingPoi = (lat, lon) => {
  let best = null;
  let bestDist = POI_MATCH_DEGREES;
  const scan = (pois) => {
    for (const poi of pois || []) {
      const d = Math.hypot(poi.lat - lat, poi.lon - lon);
      if (d < bestDist) {
        bestDist = d;
        best = poi;
      }
    }
  };
  if (IS_ALL_MODE) {
    for (const cityData of cityDataMap.values()) scan(cityData?.poisData);
  } else {
    scan(poisData);
  }
  return best;
};

// Best-effort synchronous name for a location endpoint (click-time cache or
// a known POI, same lookup order as the location popover) without waiting
// on a reverse-geocode round trip — used anywhere a location's identity
// needs to show up immediately (between-popover header while the search is
// still running), falling back to a generic label rather than the raw
// "loc:{lat},{lon}" URL token or coordinates.
const friendlyLocationName = (lat, lon) => {
  const cached = locationNameCache.get(locationKey(lat, lon)) || findMatchingPoi(lat, lon);
  return cached?.name || 'Selected Location';
};

// Alpha "location-to-location directions" feature — `between` endpoint
// tokens. A stop endpoint is its plain number (single-city) or
// "{city}^{number}" (all-mode, unchanged from before). A location endpoint
// is "loc:{lat},{lon}" — the `loc:` prefix is required because `,` can't be
// used as the sole marker (it's also the lat/lon separator) and `-` can't be
// either (longitudes are negative for e.g. the nyc dataset). The two
// endpoint tokens are joined with `~`, matching the separator convention
// already used elsewhere (multi-select service ids, all-mode value pairs).
// Old `{start}-{end}`/`{start},{end}` stop-only URLs (no `~`) still parse via
// the legacy fallback, so existing bookmarked between links keep working.
const encodeBetweenToken = (endpoint) => {
  if (endpoint.type === 'location') return `loc:${endpoint.lat},${endpoint.lon}`;
  return endpoint.city ? `${endpoint.city}^${endpoint.number}` : endpoint.number;
};
const decodeBetweenToken = (token) => {
  if (token.startsWith('loc:')) {
    const [rawLat, rawLon] = token.slice(4).split(',');
    const lat = parseFloat(rawLat);
    const lon = parseFloat(rawLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { type: 'location', lat, lon };
  }
  const caret = token.indexOf('^');
  return caret !== -1
    ? { type: 'stop', city: token.slice(0, caret), number: token.slice(caret + 1) }
    : { type: 'stop', number: token };
};
const buildBetweenUrl = (startEndpoint, endEndpoint) =>
  `${encodeBetweenToken(startEndpoint)}~${encodeBetweenToken(endEndpoint)}`;
const parseBetweenValue = (value) => {
  const parts = value.includes('~') ? value.split('~') : value.split(/[,-]/);
  if (parts.length !== 2) return null;
  const start = decodeBetweenToken(parts[0]);
  const end = decodeBetweenToken(parts[1]);
  return start && end ? [start, end] : null;
};
// `.catch()` alone only guards against *rejection* — if the underlying
// fetch/worker round-trip just stalls (slow network, worker never replies),
// the promise never settles at all and a `.then()`-driven loading state gets
// stuck forever. This races the real promise against a timeout so callers
// always reach a final state.
const withTimeout = (promise, ms, fallback) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
const LOCATION_FETCH_TIMEOUT_MS = 8000;
// Same cap transfers.py applies to every Voronoi cell (MAX_RADIUS_METERS
// there) — capping the nearest-stop distance to this radius is the cheap
// equivalent of a true point-in-polygon test against that stop's Voronoi
// cell (for the *nearest* site, "inside its cell" and "is the nearest site"
// are the same statement), without shipping/parsing cell geometry
// client-side. Beyond this range, no stop is close enough to call "nearby".
const MAX_RANGE_KM = 1; // ruler.distance() returns kilometers
// Mirrors dataWorker.js's NEARBY_STOPS_MAX — a large BUFFER_METERS (see
// transfers.py) can single-link-chain many stops into one cluster at a busy
// multi-modal hub, so this is a safety cap, not an expected typical size.
const NEARBY_STOPS_MAX = 20;

// Memoized per-city clusters.min.json fetches (alpha "locations" feature) —
// keyed by city code since IS_ALL_MODE locations may belong to any city.
// clusters.min.json holds same-place stop groups (intra-cluster Voronoi
// edges) — see transfers.py's docstring for how this differs from
// transfers.min.json (inter-cluster walking transfers, used by RAPTOR).
// Deliberately NOT timeout-wrapped here — this promise is memoized and
// reused for the lifetime of the page, so racing it against a timeout would
// permanently "poison" the cache with an empty result the first time the
// fetch is merely slow. Callers that need a bounded wait should wrap the
// call with `withTimeout` themselves instead.
const cityClustersPromises = new Map();
const loadCityClusters = (cityCode) => {
  if (!cityClustersPromises.has(cityCode)) {
    cityClustersPromises.set(
      cityCode,
      fetchCache(`/data/${cityCode}/clusters.min.json`, CACHE_TIME).catch(() => ({})),
    );
  }
  return cityClustersPromises.get(cityCode);
};

// The small nationwide leftover from the same Voronoi computation covering
// only genuinely cross-city same-place edges (e.g. a city bus stop right
// next to a `railways`/`greyhound` stop) — every other (same-city) cluster
// edge lives in that city's own clusters.min.json above instead of one
// ever-growing nationwide file (see globaltransfers.py).
let crossCityClustersPromise = null;
const loadCrossCityClusters = () => {
  if (!crossCityClustersPromise) {
    crossCityClustersPromise = fetchCache('/data/all/clusters-cross-city.min.json', 24 * 60).catch(() => ({}));
  }
  return crossCityClustersPromise;
};

// Resolves a location {lat,lon} to its nearby-stop Voronoi cluster (nearest
// stop + same-cell siblings) — the exact same candidate set the location
// popover shows. Shared by the popover and the location-to-X `between`
// search so both search over identical stops. Deliberately does NOT touch
// activeSelectionCities (all-mode's viewport-unload pin) — callers manage
// pinning themselves, since a between query needs to pin candidates from
// *two* independent resolutions without one clobbering the other.
const resolveLocationStops = (lat, lon) => {
  if (IS_ALL_MODE) {
    const candidateCities = AVAILABLE_CITIES.filter((c) => {
      const b = CITY_CONFIGS[c]?.city?.bounds;
      return b && lon >= b.lowerLong && lon <= b.upperLong && lat >= b.lowerLat && lat <= b.upperLat;
    });
    return Promise.all([
      withTimeout(
        Promise.all(candidateCities.map((c) => loadCityData(c))).catch(() => {}),
        LOCATION_FETCH_TIMEOUT_MS,
        null,
      ),
      withTimeout(
        loadCrossCityClusters().catch(() => null),
        LOCATION_FETCH_TIMEOUT_MS,
        null,
      ),
    ]).then(([, crossCityClusters]) => {
      const closest = computeAllModeClosestStops(lon, lat);
      if (!closest.length || closest[0].distance > MAX_RANGE_KM) return [];
      const nearest = closest[0];
      const results = [nearest];
      // Same-city siblings come from that city's own already-loaded clusters
      // shard (raw ids, re-qualified here); the tiny nationwide cross-city
      // file covers the rare case of a different city's stop sharing the
      // same physical place (see globaltransfers.py).
      const ownClusters = cityDataMap.get(nearest.city)?.clustersData || {};
      const siblings = [
        ...(ownClusters[nearest.number] || []).map(([n, d]) => [`${nearest.city}^${n}`, d]),
        ...(crossCityClusters?.[`${nearest.city}^${nearest.number}`] || []),
      ].sort((a, b) => a[1] - b[1]);
      for (const [siblingGlobalId, distanceM] of siblings) {
        if (results.length >= NEARBY_STOPS_MAX) break;
        const caret = siblingGlobalId.indexOf('^');
        if (caret === -1) continue;
        const sCity = siblingGlobalId.slice(0, caret);
        const sNumber = siblingGlobalId.slice(caret + 1);
        const stopEntry = cityDataMap.get(sCity)?.stopsData?.[sNumber];
        if (stopEntry) results.push({ ...stopEntry, city: sCity, number: sNumber, distance: distanceM });
      }
      return results;
    });
  }
  return withTimeout(
    loadCityClusters(city).then((clusters) => workerNearbyStops(lon, lat, clusters)),
    LOCATION_FETCH_TIMEOUT_MS,
    { stops: [] },
  )
    .then(({ stops }) => stops)
    .catch(() => []);
};

// Pre-built lookup maps for O(1) normalized key lookups
let normalizedServiceKeyMap = null;
let normalizedStopKeyMap = null;

/**
 * Build normalized lookup maps for fast O(1) lookups
 * Called once after data is loaded
 */
const buildNormalizedLookupMaps = () => {
  if (servicesData && !normalizedServiceKeyMap) {
    normalizedServiceKeyMap = new Map();
    Object.keys(servicesData).forEach((key) => {
      normalizedServiceKeyMap.set(normalizeName(key, city), key);
    });
  }
  if (stopsData && Object.keys(stopsData).length > 0 && !normalizedStopKeyMap) {
    normalizedStopKeyMap = new Map();
    Object.keys(stopsData).forEach((key) => {
      normalizedStopKeyMap.set(normalizeName(key, city), key);
    });
  }
};

/**
 * Find a service by key, using normalized name comparison if enabled for the city.
 * Uses pre-built lookup map for O(1) performance.
 * @param {string} key - The service key/number to find
 * @returns {string|null} The actual service key in servicesData, or null if not found
 */
const findServiceKey = (key) => {
  if (!key || !servicesData) return null;
  // First try exact match
  if (servicesData[key]) return key;
  // Use pre-built map for O(1) lookup
  if (normalizedServiceKeyMap) {
    return normalizedServiceKeyMap.get(normalizeName(key, city)) || null;
  }
  return null;
};

/**
 * Find a stop by key, using normalized name comparison if enabled for the city.
 * Uses pre-built lookup map for O(1) performance.
 * @param {string} key - The stop key/number to find
 * @returns {string|null} The actual stop key in stopsData, or null if not found
 */
const findStopKey = (key) => {
  if (!key || !stopsData) return null;
  // First try exact match
  if (stopsData[key]) return key;
  // Use pre-built map for O(1) lookup
  if (normalizedStopKeyMap) {
    return normalizedStopKeyMap.get(normalizeName(key, city)) || null;
  }
  return null;
};

/**
 * Simple debounce utility
 * @param {Function} fn - Function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function} Debounced function
 */
const debounce = (fn, delay) => {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
};

/**
 * Simple throttle utility
 * @param {Function} fn - Function to throttle
 * @param {number} limit - Minimum time between calls in milliseconds
 * @returns {Function} Throttled function
 */
const throttle = (fn, limit) => {
  let lastCall = 0;
  return (...args) => {
    const now = performance.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      fn(...args);
    }
  };
};

// Helper function to ensure consistent hash navigation with city prefix
const navigateTo = (path, currentRoute) => {
  const prefix = path === '/' ? '' : currentRoute.cityPrefix;
  location.hash = `${prefix}${path}`;
};

const getViewportFromUrl = () => {
  try {
    const params = new URL(window.location.href).searchParams;
    const lat = parseFloat(params.get('lat'));
    const lon = parseFloat(params.get('lon'));
    const z = parseFloat(params.get('z'));
    if (!isNaN(lat) && !isNaN(lon) && !isNaN(z)) return { lat, lon, z };
  } catch (_) {}
  return null;
};

const saveViewportToUrl = (lat, lng, zoom) => {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('lat', lat.toFixed(5));
    url.searchParams.set('lon', lng.toFixed(5));
    url.searchParams.set('z', zoom.toFixed(2));
    history.replaceState(null, '', url);
  } catch (_) {}
};

// ── All-mode helpers ──────────────────────────────────────────────────────────

const viewportOverlapsBounds = (vp, b) =>
  vp.getNorth() > b.lowerLat &&
  vp.getSouth() < b.upperLat &&
  vp.getEast() > b.lowerLong &&
  vp.getWest() < b.upperLong;

const processStopsForCity = (rawStops) => {
  const cityStopsData = {};
  const cityStopsDataArr = [];
  const stopsByParent = {};

  Object.keys(rawStops).forEach((number) => {
    const [lng, lat, , , parentStopID = ''] = rawStops[number];
    if (parentStopID) {
      if (!stopsByParent[parentStopID]) stopsByParent[parentStopID] = [];
      stopsByParent[parentStopID].push({ number, lng, lat });
    }
  });

  Object.keys(rawStops).forEach((number) => {
    const [lng, lat, name, suffix = '', parentStopID = ''] = rawStops[number];
    let left = false;
    if (parentStopID && stopsByParent[parentStopID]) {
      const opp = stopsByParent[parentStopID].filter((s) => s.number !== number)[0];
      if (opp) left = ruler.bearing([lng, lat], [opp.lng, opp.lat]) > 0;
    }
    cityStopsData[number] = {
      name, suffix, number,
      parentStopID: parentStopID || null,
      interchange: /\sint$/i.test(name) && !/^(bef|aft|opp|bet)\s/i.test(name),
      coordinates: [lng, lat],
      services: [], routes: [], left,
    };
    cityStopsDataArr.push(cityStopsData[number]);
  });
  cityStopsDataArr.sort((a, b) => (a.interchange ? 1 : b.interchange ? -1 : 0));
  return { cityStopsData, cityStopsDataArr };
};

// Fetches and merges a city's stops/services/routes JSON into `cityDataMap`
// only — no map sources/layers. This is all `runAllModeBetween`'s RAPTOR
// search needs (a route-major graph to search over), so between-queries don't
// have to pay for rendering every stop of every city touched during the
// search onto the map. `loadCity` (full load, below) reuses this and adds the
// map layers on top when a city needs to actually be browsable/visible.
const loadCityDataPromises = new Map(); // cityCode → Promise<void>, data-only fetch in flight
const loadCityData = (cityCode) => {
  if (cityDataMap.has(cityCode)) return Promise.resolve();
  if (loadCityPromises.has(cityCode)) return loadCityPromises.get(cityCode);
  if (loadCityDataPromises.has(cityCode)) return loadCityDataPromises.get(cityCode);
  const promise = _fetchCityDataImpl(cityCode);
  loadCityDataPromises.set(cityCode, promise);
  promise.finally(() => loadCityDataPromises.delete(cityCode));
  return promise;
};

const _fetchCityDataImpl = async (cityCode) => {
  const dp = `/data/${cityCode}`;
  const [rawStops, citySvcsData, cityRoutesData, cityPoisData, cityClustersData] = await Promise.all([
    fetch(`${dp}/stops.min.json`).then((r) => r.json()),
    fetch(`${dp}/services.min.json`).then((r) => r.json()),
    fetch(`${dp}/routes.min.json`).then((r) => r.json()),
    isAlphaEnabled() ? fetchPois(cityCode) : Promise.resolve([]),
    loadCityClusters(cityCode),
  ]);

  const { cityStopsData, cityStopsDataArr } = processStopsForCity(rawStops);

  Object.keys(citySvcsData).forEach((svcNum) => {
    const svc = citySvcsData[svcNum];
    Object.keys(svc).forEach((dest) => {
      if (dest === 'name') return;
      svc[dest].forEach((route, vi) => {
        route.forEach((stop, stopIdx) => {
          if (!cityStopsData[stop]) return;
          if (!cityStopsData[stop].services.includes(svcNum))
            cityStopsData[stop].services.push(svcNum);
          const rk = `${svcNum}|${dest}|${vi}`;
          if (!cityStopsData[stop].routes.includes(rk)) {
            cityStopsData[stop].routes.push(rk);
            if (!cityStopsData[stop].destinationGroups) cityStopsData[stop].destinationGroups = {};
            if (!cityStopsData[stop].destinationGroups[svcNum]) cityStopsData[stop].destinationGroups[svcNum] = {};
            if (!cityStopsData[stop].destinationGroups[svcNum][dest]) {
              cityStopsData[stop].destinationGroups[svcNum][dest] = { destination: dest, routes: [], stopCount: 0 };
            }
            const dg = cityStopsData[stop].destinationGroups[svcNum][dest];
            dg.routes.push(route);
            const remaining = route.length - stopIdx - 1;
            if (remaining > dg.stopCount) dg.stopCount = remaining;
          }
        });
      });
    });
  });

  cityDataMap.set(cityCode, {
    stopsData: cityStopsData,
    stopsDataArr: cityStopsDataArr,
    servicesData: citySvcsData,
    routesData: cityRoutesData,
    poisData: cityPoisData.map((poi, id) => ({ ...poi, id })),
    clustersData: cityClustersData,
  });
};

const loadCity = (cityCode) => {
  if (loadedCities.has(cityCode)) return Promise.resolve();
  if (loadCityPromises.has(cityCode)) return loadCityPromises.get(cityCode);
  const promise = _loadCityImpl(cityCode);
  loadCityPromises.set(cityCode, promise);
  promise.finally(() => loadCityPromises.delete(cityCode));
  return promise;
};

const _loadCityImpl = async (cityCode) => {
  loadingCities.add(cityCode);
  try {
    // Reuse an in-flight/completed data-only fetch (e.g. from a between query)
    // instead of re-requesting the same JSON.
    if (!cityDataMap.has(cityCode)) {
      await (loadCityDataPromises.get(cityCode) || _fetchCityDataImpl(cityCode));
    }
    if (!map || map.getSource(`stops-${cityCode}`)) return;
    const { stopsDataArr: cityStopsDataArr, servicesData: citySvcsData, poisData: cityPoisData } = cityDataMap.get(cityCode) || {};
    if (!cityStopsDataArr) return; // data fetch failed

    const cityConfig = getConfigForCity(cityCode);
    const disableStopID = cityConfig?.disableStopID || false;

    let stopTextPartialFormat, stopTextFullFormat;
    if (disableStopID) {
      stopTextPartialFormat = ['get', 'name'];
      stopTextFullFormat = [
        'format',
        ['get', 'name'],
        {},
        [
          'case',
          ['!=', ['get', 'suffix'], null],
          ['concat', '\n', ['get', 'suffix']],
          '',
        ],
        { 'font-scale': 0.8, 'text-color': C.text },
      ];
    } else {
      stopTextPartialFormat = ['get', 'number'];
      stopTextFullFormat = [
        'format',
        ['get', 'number'],
        { 'font-scale': 0.8 },
        '\n',
        {},
        ['get', 'name'],
        { 'text-color': C.text },
      ];
    }
    // Match single-city mode's stacking (stop/rail layers added with no
    // beforeId sit above the entire base style, including road labels) —
    // the only thing per-city layers must stay under is the shared
    // stops-highlight overlay, so selection/highlight markers stay visible
    // above every city's own stops. Relative order between cities is then
    // just load order, same as single-city has only one city to order.
    const insertBefore = map.getLayer('stops-highlight') ? 'stops-highlight' : undefined;
    // Rail layers anchor to stops-highlight-circle instead — a separate,
    // permanent (never unloaded) layer added just below stops-highlight —
    // so every city's rail lines/stations stack below every city's stops,
    // rather than interleaving with them by load order. Without this, one
    // city's rail station (e.g. a metro interchange) can render on top of
    // and visually cover another city's bus stop at the same physical hub.
    const railInsertBefore = map.getLayer('stops-highlight-circle') ? 'stops-highlight-circle' : insertBefore;

    map.addSource(`stops-${cityCode}`, {
      type: 'geojson',
      tolerance: 10,
      data: {
        type: 'FeatureCollection',
        features: createFeaturesOptimized(cityStopsDataArr, (stop) => ({
          type: 'Feature',
          id: encode(stop.number),
          properties: {
            number: stop.number,
            name: stop.name,
            interchange: stop.interchange,
            left: stop.left,
            suffix: stop.suffix,
            city: cityCode,
          },
          geometry: { type: 'Point', coordinates: stop.coordinates },
        })),
      },
    });

    map.addSource(`stops-highlight-${cityCode}`, {
      type: 'geojson', tolerance: 10,
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: `stops-${cityCode}`,
      type: 'circle',
      source: `stops-${cityCode}`,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['boolean', ['feature-state', 'selected'], false], 4, 1], 14, 4, 15, ['case', ['boolean', ['feature-state', 'selected'], false], 12, 6]],
        'circle-color': ['case', ['boolean', ['feature-state', 'selected'], false], C.stopCircleBg, C.stopRed],
        'circle-stroke-color': ['case', ['boolean', ['feature-state', 'selected'], false], C.stopRed, C.stopCircleBg],
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 5, 1],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 1, 13.9, 1, 14, 0.5],
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0], 13.5, 1, 14, 0.5],
      },
    }, insertBefore);

    map.addLayer({
      id: `stops-icon-${cityCode}`,
      type: 'symbol',
      source: `stops-${cityCode}`,
      filter: ['any', ['>=', ['zoom'], 14], ['get', 'interchange']],
      layout: {
        'icon-image': 'stop',
        'icon-size': ['step', ['zoom'], 0.4, 15, 0.5, 16, 0.6],
        'icon-padding': 0.5,
        'icon-allow-overlap': true,
        'text-optional': true,
        'text-field': ['step', ['zoom'], '', 15, stopTextPartialFormat, 16, stopTextFullFormat],
        'text-size': ['step', ['zoom'], 12, 16, 14],
        'text-justify': ['case', ['boolean', ['get', 'left'], false], 'right', 'left'],
        'text-anchor': ['case', ['boolean', ['get', 'left'], false], 'right', 'left'],
        'text-offset': ['case', ['boolean', ['get', 'left'], false], ['literal', [-1, 0]], ['literal', [1, 0]]],
        'text-padding': 0.5,
        'text-font': ['Noto Sans Regular'],
        'text-max-width': 16,
        'text-line-height': 1.1,
      },
      paint: {
        'icon-opacity': ['interpolate', ['linear'], ['zoom'], 8, ['case', ['get', 'interchange'], 1, 0], 14, 1],
        'text-color': C.stopRed,
        'text-halo-width': 1,
        'text-halo-color': C.textHalo,
      },
    }, insertBefore);

    map.on('mouseenter', `stops-${cityCode}`, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', `stops-${cityCode}`, () => { map.getCanvas().style.cursor = ''; });

    // Add to search index only if not already indexed (preindexAllCities may have run first)
    AllModeIndex.addCity(cityCode, {
      services: Object.keys(citySvcsData).map((num) => ({ number: num, name: citySvcsData[num].name })),
      stops: cityStopsDataArr,
      pois: cityPoisData || [],
    });

    // Try to load rail data — not all cities have it, so 404 is expected
    try {
      const railResp = await fetch(`/data/${cityCode}/rail.json`);
      if (railResp.ok && map && !map.getSource(`rail-${cityCode}`)) {
        const railData = await railResp.json();
        const railLineFilter = ['all', ['==', ['geometry-type'], 'LineString'], ['has', 'stroke']];
        const railLineLayout = { 'line-join': 'round', 'line-cap': 'round' };
        const railInterchangeFilter = ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'interchange'], true]];
        const railStationsFilter = ['all', ['==', ['geometry-type'], 'Point'], ['has', 'name'], ['!=', ['get', 'interchange'], true]];

        map.addSource(`rail-${cityCode}`, { type: 'geojson', data: railData });

        map.addLayer({
          id: `rail-path-case-${cityCode}`,
          type: 'line',
          source: `rail-${cityCode}`,
          filter: railLineFilter,
          minzoom: 8,
          layout: railLineLayout,
          paint: {
            'line-color': ['match', ['get', 'mode'], 'metro', C.stopCircleBg, 'monorail', '#FFF', ['get', 'stroke']],
            'line-width': ['interpolate', ['linear'], ['zoom'],
              16, ['match', ['get', 'mode'], 'monorail', 0.85, 'rail', 5, 9],
              22, ['match', ['get', 'mode'], 'monorail', 12, 'rail', 7, 12],
            ],
            'line-opacity': ['match', ['get', 'mode'], 'monorail', 0.5, 'rail', 0.75, 0.5],
          },
        }, railInsertBefore);

        map.addLayer({
          id: `rail-path-${cityCode}`,
          type: 'line',
          source: `rail-${cityCode}`,
          filter: railLineFilter,
          minzoom: 8,
          layout: railLineLayout,
          paint: {
            'line-color': ['get', 'stroke'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 4, 22, 6],
            'line-opacity': ['match', ['get', 'mode'], 'monorail', 1, 'rail', 0.01, C.routeLineOpacity],
          },
        }, railInsertBefore);

        map.addLayer({
          id: `rail-path-dots-${cityCode}`,
          type: 'line',
          source: `rail-${cityCode}`,
          filter: ['all', ...railLineFilter.slice(1), ['==', ['get', 'mode'], 'rail']],
          minzoom: 8,
          layout: { ...railLineLayout, 'line-cap': 'butt' },
          paint: {
            'line-color': ['get', 'stroke'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 3, 22, 4],
            'line-opacity': 1,
            'line-dasharray': [3, 3],
          },
        }, railInsertBefore);

        map.addLayer({
          id: `rail-stations-${cityCode}`,
          type: 'symbol',
          source: `rail-${cityCode}`,
          filter: railStationsFilter,
          minzoom: 10,
          layout: {
            'icon-image': ['match', ['get', 'mode'], 'metro', 'metro-station', 'monorail', 'monorail-station', 'rail-station'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 22, 0.5],
            'icon-allow-overlap': false,
            'text-field': ['get', 'name'],
            'text-font': ['Noto Sans Bold'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 22, 16],
            'text-variable-anchor': ['left', 'right', 'top'],
            'text-radial-offset': 1.1,
            'text-optional': true,
          },
          paint: {
            'icon-color': stationIconColor,
            'icon-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 11, 1],
            ...(isDark && { 'icon-halo-color': '#000', 'icon-halo-width': 0.5, 'icon-halo-blur': 1 }),
            'text-color': stationTextColor,
            'text-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 11, 1],
            'text-halo-color': C.textHalo,
            'text-halo-width': C.stationHaloWidth,
          },
        }, railInsertBefore);

        map.addLayer({
          id: `rail-stations-interchange-${cityCode}`,
          type: 'symbol',
          source: `rail-${cityCode}`,
          filter: railInterchangeFilter,
          minzoom: 9,
          layout: {
            'icon-image': ['match', ['get', 'mode'], 'metro', 'metro-station', 'monorail', 'monorail-station', 'rail-station'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.45, 22, 0.75],
            'icon-allow-overlap': true,
            'text-field': ['get', 'name'],
            'text-font': ['Noto Sans Bold'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 22, 16],
            'text-variable-anchor': ['left', 'right', 'top'],
            'text-radial-offset': 1.1,
            'text-optional': true,
          },
          paint: {
            'icon-color': C.text,
            'icon-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0, 10, 1],
            ...(isDark && { 'icon-halo-color': '#000', 'icon-halo-width': 0.5, 'icon-halo-blur': 1 }),
            'text-color': C.text,
            'text-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0, 10, 1],
            'text-halo-color': C.textHalo,
            'text-halo-width': C.stationHaloWidth,
          },
        }, railInsertBefore);
      }
    } catch (_railErr) {
      // Rail data not available for this city
    }

    loadedCities.add(cityCode);
    onCityLoadedCallback?.(cityCode);
  } catch (err) {
    console.error(`[all-mode] Failed to load ${cityCode}:`, err);
  } finally {
    loadingCities.delete(cityCode);
  }
};

const unloadCity = (cityCode) => {
  if (!loadedCities.has(cityCode)) return;
  [
    `rail-stations-interchange-${cityCode}`,
    `rail-stations-${cityCode}`,
    `rail-path-dots-${cityCode}`,
    `rail-path-${cityCode}`,
    `rail-path-case-${cityCode}`,
    `stops-icon-${cityCode}`,
    `stops-${cityCode}`,
  ].forEach((id) => {
    if (map?.getLayer(id)) map.removeLayer(id);
  });
  [`rail-${cityCode}`, `stops-${cityCode}`, `stops-highlight-${cityCode}`].forEach((id) => {
    if (map?.getSource(id)) map.removeSource(id);
  });
  cityDataMap.delete(cityCode);
  loadedCities.delete(cityCode);
  onCityUnloadedCallback?.(cityCode);
};

// Unload any currently-loaded city that isn't pinned (`activeSelectionCities`)
// and is outside the current viewport. `checkViewport` only re-evaluates this
// on the next pan/zoom, so a selection (service view, between query) that
// pinned cities outside the viewport would otherwise leave them loaded
// indefinitely once dismissed — call this right after clearing/updating
// `activeSelectionCities` to release them immediately.
const releaseUnpinnedCities = () => {
  if (!map) return;
  const vp = map.getBounds();
  const zoom = map.getZoom();
  [...loadedCities].forEach((cityCode) => {
    if (activeSelectionCities.has(cityCode)) return;
    const minZoom = CITY_CONFIGS[cityCode]?.city?.bounds?.minZoom;
    const b = cityStopsBounds.get(cityCode);
    if (minZoom != null && b && viewportOverlapsBounds(vp, b) && zoom >= minZoom) return;
    unloadCity(cityCode);
  });
};

// Fetch lightweight name/number index for ALL cities upfront so search works globally.
// The full stop/service objects are NOT retained — just { number, name, city }.
const preindexAllCities = async () => {
  await Promise.all(
    AVAILABLE_CITIES.map(async (cityCode) => {
      if (AllModeIndex.hasCity(cityCode)) return; // already indexed
      try {
        const dp = `/data/${cityCode}`;
        const [rawStops, svcsData, cityPois] = await Promise.all([
          fetch(`${dp}/stops.min.json`).then((r) => r.json()),
          fetch(`${dp}/services.min.json`).then((r) => r.json()),
          isAlphaEnabled() ? fetchPois(cityCode) : Promise.resolve([]),
        ]);
        // Guard again — loadCity may have run concurrently
        if (AllModeIndex.hasCity(cityCode)) return;

        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        const stops = Object.keys(rawStops).map((num) => {
          const [lng, lat, name] = rawStops[num];
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          return { number: num, name };
        });
        if (minLng !== Infinity && !cityStopsBounds.has(cityCode)) {
          // Buffer the data-derived extent by 4km, using a ruler built for this
          // city's actual latitude (longitude degrees shrink towards the poles)
          const cityRuler = new CheapRuler((minLat + maxLat) / 2);
          const [lowerLong, lowerLat, upperLong, upperLat] = cityRuler.bufferBBox(
            [minLng, minLat, maxLng, maxLat],
            4, // km
          );
          cityStopsBounds.set(cityCode, { lowerLat, upperLat, lowerLong, upperLong });
        }

        AllModeIndex.addCity(cityCode, {
          services: Object.keys(svcsData).map((num) => ({ number: num, name: svcsData[num]?.name })),
          stops,
          pois: cityPois,
        });
      } catch (e) { console.warn('preindex failed for', cityCode, e); }
    }),
  );
};

// Display name for a city code, used to label all-mode search results
const cityDisplayName = (cityCode) => CITY_CONFIGS[cityCode]?.city?.name || cityCode;

// City ranking shared by every all-mode result list: loaded cities first, then
// by minZoom desc (higher = more specific/zoomed-in city ranks first)
const getMinZoom = (cityCode) => CITY_CONFIGS[cityCode]?.city?.bounds?.minZoom ?? 0;
const compareCityPriority = (a, b) => {
  const aLoaded = loadedCities.has(a) ? 1 : 0;
  const bLoaded = loadedCities.has(b) ? 1 : 0;
  if (bLoaded !== aLoaded) return bLoaded - aLoaded;
  return getMinZoom(b) - getMinZoom(a);
};

// Groups a flat list of { city, ... } items into per-city buckets ordered by
// compareCityPriority, preserving each item's relative order within its city.
const groupByCity = (items) => {
  const order = [];
  const buckets = new Map();
  for (const item of items) {
    if (!buckets.has(item.city)) {
      buckets.set(item.city, []);
      order.push(item.city);
    }
    buckets.get(item.city).push(item);
  }
  order.sort(compareCityPriority);
  return order.map((cityCode) => ({ city: cityCode, items: buckets.get(cityCode) }));
};

// Caps grouped results to a total item count, dropping whole groups once the limit is hit
const capGroups = (groups, limit) => {
  const capped = [];
  let remaining = limit;
  for (const group of groups) {
    if (remaining <= 0) break;
    const items = group.items.slice(0, remaining);
    capped.push({ city: group.city, items });
    remaining -= items.length;
  }
  return capped;
};

// Sort services for all-mode search list: loaded cities first, then by minZoom desc (higher = more specific city)
const buildAllModeSearchList = () =>
  [...allModeServicesIdx].sort((a, b) => compareCityPriority(a.city, b.city));

const App = () => {
  const { t, i18n } = useTranslation();

  const [route, setRoute] = useState(getRoute());
  const prevRoute = usePrevious(route);

  // Handle city selection and validation
  useEffect(() => {
    const { city } = route;

    // If invalid city code, redirect to default city
    if (!isCitySupported(city)) {
      location.hash = `/${DEFAULT_CITY}${route.page === 'home' ? '' : route.path}`;
      return;
    }

    // Update page title with city name
    const cityInfo = getCityInfo();
    document.title = `${cityInfo.name} Transit Routes - ${t('app.name')}`;
  }, [route]);

  const [routeLoading, setRouteLoading] = useState(true);
  const [services, setServices] = useState([]);
  const [stops, setStops] = useState([]);
  const [locations, setLocations] = useState([]); // alpha "locations" feature — local pois.csv matches
  const [liveLocations, setLiveLocations] = useState([]); // alpha "locations" feature — live Nominatim matches
  const [locationSearchEnabled, setLocationSearchEnabled] = useState(
    () => localStorage.getItem('locationSearch') === 'true',
  );
  const locationSearchEnabledRef = useRef(locationSearchEnabled);
  useEffect(() => {
    locationSearchEnabledRef.current = locationSearchEnabled;
  }, [locationSearchEnabled]);
  const [showLocationPopover, setShowLocationPopover] = useState(false);
  const [locationPopoverData, setLocationPopoverData] = useState(null);
  const [locationPopoverStops, setLocationPopoverStops] = useState([]);
  const [locationPopoverLoading, setLocationPopoverLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [stopsFirst, setStopsFirst] = useState(false);
  const [expandSearch, setExpandSearch] = useState(false);
  const [expandedSearchOnce, setExpandedSearchOnce] = useState(false);
  const [shrinkSearch, setShrinkSearch] = useState(false);
  const [stopPopoverData, setStopPopoverData] = useState(null);
  const [showStopPopover, setShowStopPopover] = useState(false);
  const [showServicePopover, setShowServicePopover] = useState(false);
  const [stopPopoverLoading, setStopPopoverLoading] = useState(false);
  const [stopPopoverError, setStopPopoverError] = useState(false);
  const [intersectStops, setIntersectStops] = useState([]);
  const [allModePreindexed, setAllModePreindexed] = useState(false);
  const [routeServices, setRouteServices] = useState([]);
  const [routeVehicles, setRouteVehicles] = useState([]);
  const [followedVehicleId, setFollowedVehicleId] = useState(null);
  const stopPopoverCancelRef = useRef(null);
  const [stopPopoverDestFilter, setStopPopoverDestFilter] = useState(
    () => new URLSearchParams(window.location.search).get('dest') ?? '',
  );
  const [stopPopoverDestFilterExact, setStopPopoverDestFilterExact] = useState(
    () => new URLSearchParams(window.location.search).get('destExact') === '1',
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    if (stopPopoverDestFilter) {
      url.searchParams.set('dest', stopPopoverDestFilter);
      if (stopPopoverDestFilterExact) {
        url.searchParams.set('destExact', '1');
      } else {
        url.searchParams.delete('destExact');
      }
    } else {
      url.searchParams.delete('dest');
      url.searchParams.delete('destExact');
    }
    history.replaceState(null, '', url);
  }, [stopPopoverDestFilter, stopPopoverDestFilterExact]);

  const [showBetweenPopover, setShowBetweenPopover] = useState(false);
  // Lags one step behind showBetweenPopover: keeps the last non-null data around
  // while the popover slides shut, so its content doesn't vanish mid-transition
  // (mirrors stopPopoverData, which is likewise never nulled on close).
  const [betweenPopoverData, setBetweenPopoverData] = useState(null);
  useEffect(() => {
    if (showBetweenPopover) setBetweenPopoverData(showBetweenPopover);
  }, [showBetweenPopover]);
  const [betweenStartStop, setBetweenStartStop] = useState(null);
  const [betweenEndStop, setBetweenEndStop] = useState(null);
  // All-mode (cross-city) `between` result: { startId, endId, startStop, endStop, itineraries, loading, error }
  const [allModeBetween, setAllModeBetween] = useState(null);
  // Same lag as betweenPopoverData, for the all-mode variant.
  const [allModeBetweenData, setAllModeBetweenData] = useState(null);
  useEffect(() => {
    if (allModeBetween) setAllModeBetweenData(allModeBetween);
  }, [allModeBetween]);
  const [directionsOrigin, setDirectionsOrigin] = useState(null);
  const [editingBetweenStop, setEditingBetweenStop] = useState(null);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [closestStops, setClosestStops] = useState([]);

  const prevStopNumber = useRef(null);
  const prevStopCity = useRef(null); // tracks source city for feature state clearing in all-mode
  const currentLocationRef = useRef(null); // kept in sync for use in non-reactive callbacks
  const closestStopsRef = useRef([]);
  const servicesList = useRef(null);
  const searchField = useRef(null);
  const searchPopover = useRef(null);
  const searchPane = useRef(null); // CupertinoPane instance for search-popover, mobile only
  const stopPopover = useRef(null);
  const stopPane = useRef(null); // CupertinoPane instance for stop-popover, mobile only
  const locationPopover = useRef(null);
  const locationPane = useRef(null); // CupertinoPane instance for location-popover, mobile only
  const locationMarkerRef = useRef(null); // alpha "locations" feature — maplibregl.Marker for the selected location
  const locationSearchSeq = useRef(0);
  // All-mode's viewport-driven city loader (defined inside the map-load
  // effect, below) — stashed here so the location route handler and
  // hideLocationPopover can force a re-check without waiting for a real
  // moveend, which a static location viewport may never produce.
  const checkViewportRef = useRef(null);
  const floatPill = useRef(null);
  const betweenPopover = useRef(null);
  const betweenPane = useRef(null); // CupertinoPane instance for between-popover, mobile only
  // Cache key for the last-run between query — lets navigating list ↔ detail
  // (which only changes route.subpage) skip re-running the RAPTOR search /
  // worker-based route computation, since the query itself hasn't changed.
  const lastAllModeBetweenQuery = useRef(null);
  const lastBetweenQuery = useRef(null);
  const servicePopover = useRef(null);
  const servicePane = useRef(null); // CupertinoPane instance for service-popover, mobile only
  const vehicleTracker = useRef(null);
  const workerReadyRef = useRef(null);
  const geolocateBtn = useRef(null);
  const geolocateControlRef = useRef(null);
  const hasPannedToLocationOnLoad = useRef(false);

  // (closest-stop calculation now runs in the data worker — see useEffect below)

  // Pan/zoom to location with geolocateSource flag
  const panToLocation = useCallback((location, geolocateControl) => {
    if (!location || !map) return;

    const checkAndPan = () => {
      const marker = geolocateControl?._dot;
      if (!marker || !marker._addedToMap) {
        requestAnimationFrame(checkAndPan);
        return;
      }

      // On mobile, adjust latitude to account for UI elements
      const center = !BREAKPOINT()
        ? [location[0], location[1] - 0.004]
        : location;

      const eventData = { geolocateSource: true };
      map.flyTo(
        {
          center,
          zoom: 15,
          duration: 2000,
        },
        eventData,
      );
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(checkAndPan);
    });
  }, []);

  // Handle location update (from GeolocateControl)
  const handleLocationUpdate = useCallback(
    (location, geolocateControl) => {
      if (!location) return;

      setCurrentLocation(location);

      // Pan/zoom on initial page load only
      if (!hasPannedToLocationOnLoad.current) {
        hasPannedToLocationOnLoad.current = true;
        panToLocation(location, geolocateControl);
      }
    },
    [panToLocation],
  );

  let previewRAF = useRef(null).current;

  const largerScreen = window.matchMedia(
    '(min-width: 1200px) and (min-height: 600px) and (orientation: landscape)',
  ).matches;

  const handleKeys = (e) => {
    switch (e.key.toLowerCase()) {
      case 'enter': {
        const link = servicesList.current?.querySelector('li a[href^="#"]');
        if (link) {
          searchField.current?.blur();
          link.click();
        }
        break;
      }
    }
  };

  const handleSearchFocus = (e) => {
    setExpandSearch(true);
    setExpandedSearchOnce(true);
    // $map.classList.add('fade-out');
    movePaneToBreak(searchPane, 'top');
    pinScrollTop();
    if (IS_ALL_MODE && !searchField.current?.value) {
      // Immediately populate with sorted index (no debounce delay)
      const sorted = buildAllModeSearchList();
      setServices(sorted);
    }
  };

  // Debounced search — stored in a ref so the debounce timeoutId survives re-renders.
  // A monotonic sequence number guards against out-of-order responses from
  // back-to-back debounce firings.
  const searchSeq = useRef(0);
  const setServicesRef = useRef(null);
  const setStopsRef = useRef(null);
  const setSearchingRef = useRef(null);
  setServicesRef.current = setServices;
  setStopsRef.current = setStops;
  setSearchingRef.current = setSearching;
  const performSearchRef = useRef(null);
  if (!performSearchRef.current) {
    performSearchRef.current = debounce(async (value) => {
      try {
        if (value) {
          const seq = ++searchSeq.current;
          const { services, stops, locations } = await workerSearch(value);
          if (seq !== searchSeq.current) return; // stale — a newer query is in flight
          // Order results by the dominant character class in the query: stop names
          // first for mostly-alphabetic input, route numbers first for numeric input.
          const letters = (value.match(/[a-z]/gi) || []).length;
          const digits = (value.match(/\d/g) || []).length;
          setStopsFirst(letters > digits);
          setServicesRef.current(services);
          setStopsRef.current(stops);
          setLocations(isAlphaEnabled() && locationSearchEnabledRef.current ? locations : []);
          setSearchingRef.current(true);
          if (!IS_ALL_MODE && servicesList.current) {
            // Scroll to top, with hack for momentum scrolling
            // https://popmotion.io/blog/20170704-manually-set-scroll-while-ios-momentum-scroll-bounces/
            servicesList.current.style['-webkit-overflow-scrolling'] = 'auto';
            servicesList.current.scrollTop = 0;
            servicesList.current.style['-webkit-overflow-scrolling'] = null;
          }
        } else {
          setServicesRef.current(IS_ALL_MODE ? buildAllModeSearchList() : servicesDataArr);
          setStopsRef.current(currentLocationRef.current ? closestStopsRef.current : []);
          setLocations([]);
          setLiveLocations([]);
          setSearchingRef.current(false);
        }
      } catch (err) { console.error('search threw:', err); }
    }, 150);
  }
  const performSearch = performSearchRef.current;

  // Separate, longer debounce for live Nominatim lookups (alpha "locations"
  // feature) — a network round trip, kept independent of the instant local
  // Fuse search above so it never blocks/slows down services/stops results.
  const geocodeSeq = useRef(0);
  const performGeocodeRef = useRef(null);
  if (!performGeocodeRef.current) {
    performGeocodeRef.current = debounce(async (value) => {
      if (!isAlphaEnabled() || !locationSearchEnabledRef.current || value.trim().length < 3) {
        setLiveLocations([]);
        return;
      }
      const seq = ++geocodeSeq.current;
      const results = await fetchGeocode(value, [lowerLat, lowerLong, upperLat, upperLong]);
      if (seq !== geocodeSeq.current) return; // stale
      setLiveLocations(results);
    }, 400);
  }
  const performGeocode = performGeocodeRef.current;

  const handleSearch = (e) => {
    const { value } = (e && e.target) || searchField;
    // Immediately show searching state for better UX
    if (value && !searching) {
      setSearching(true);
    }
    performSearch(value);
    performGeocode(value);
  };

  const handleSearchClose = () => {
    setExpandSearch(false);
    $map.classList.remove('fade-out');
    resetSearch();
    movePaneToBreak(searchPane, 'middle');
  };

  const resetSearch = () => {
    searchField.current?.blur();
    searchField.current.value = '';
    setSearching(false);
    setStopsFirst(false);
    setServices(IS_ALL_MODE ? buildAllModeSearchList() : servicesDataArr);
    // Show closest stops if location is available, otherwise empty
    setStops(currentLocation ? closestStops : []);
    setLocations([]);
    setLiveLocations([]);
  };

  const handleServicesScroll = () => {
    if (expandSearch || expandedSearchOnce) return;
    setExpandSearch(true);
    setExpandedSearchOnce(true);
    // $map.classList.add('fade-out');
  };

  // Update closest stops whenever location changes — runs in the data worker (city mode) or
  // main thread (all-mode, since cityDataMap is already loaded).
  useEffect(() => {
    closestStopsRef.current = closestStops;
  }, [closestStops]);

  useEffect(() => {
    currentLocationRef.current = currentLocation;
    if (IS_ALL_MODE) {
      if (!currentLocation) { setClosestStops([]); return; }
      setClosestStops(computeAllModeClosestStops(...currentLocation));
      return;
    }
    if (!currentLocation || !stopsDataArr?.length) {
      setClosestStops([]);
      return;
    }
    let cancelled = false;
    const [lng, lat] = currentLocation;
    workerClosestStops(lng, lat).then(({ stops }) => {
      if (!cancelled) setClosestStops(stops);
    });
    return () => {
      cancelled = true;
    };
  }, [currentLocation]);

  // `city` omitted → city-scoped stop from the single loaded city's own
  // `stops`/`stops-highlight` sources; `city` given → all-mode stop pulled
  // from that city's `stops-${city}` source (and `stopData` must be passed
  // in, since there's no single loaded-city `stopsData` to look it up in).
  const _showStopPopover = useCallback((number, { city, stopData: providedStopData } = {}) => {
    const stopData = providedStopData || stopsData[number];
    if (!stopData?.coordinates) {
      console.warn(`[stop-popover] No stop data for ${city ? `${city}^${number}` : number} — skipping`);
      return;
    }
    const { coordinates } = stopData;

    const popoverHeight = paneOrOffsetHeight(stopPopover.current);
    const offset = BREAKPOINT() ? [0, 0] : [0, -(popoverHeight || 0) / 2];
    const zoom = map.getZoom();
    if (zoom < 17) {
      map.flyTo({
        zoom: 17,
        center: coordinates,
        offset,
        animate: zoom >= 12,
      });
    } else {
      map.easeTo({ center: coordinates, offset });
    }

    // Clear previous selection (from whichever source it was selected on)
    if (prevStopNumber.current) {
      if (prevStopCity.current) {
        const prevSrc = `stops-${prevStopCity.current}`;
        if (map.getSource(prevSrc)) {
          map.setFeatureState({ source: prevSrc, id: encode(prevStopNumber.current) }, { selected: false });
        }
      } else {
        map.setFeatureState({ source: 'stops', id: encode(prevStopNumber.current) }, { selected: false });
        map.setFeatureState({ source: 'stops-highlight', id: encode(prevStopNumber.current) }, { selected: false });
      }
    }

    if (city) {
      const src = `stops-${city}`;
      if (map.getSource(src)) {
        map.setFeatureState({ source: src, id: encode(number) }, { selected: true });
      }
      // Expose city data so BusServicesArrival can resolve destination stop names
      const cityEntry = cityDataMap.get(city);
      if (cityEntry) {
        window._data = {
          stopsData: cityEntry.stopsData,
          stopsDataArr: cityEntry.stopsDataArr,
          servicesData: cityEntry.servicesData,
          routesData: cityEntry.routesData,
          servicesDataArr: [],
        };
      }
      setHead({
        title: ['stop.title', { stopNumber: number, stopName: stopData.name }],
        url: `/all/stops/${city}^${number}`,
      });
    } else {
      map.setFeatureState({ source: 'stops', id: encode(number) }, { selected: true });
      map.setFeatureState({ source: 'stops-highlight', id: encode(number) }, { selected: true });
    }

    setShrinkSearch(true);
    prevStopNumber.current = number;
    prevStopCity.current = city || null;
    setShowStopPopover(true);
    setStopPopoverData(city ? { ...stopData, city } : stopData);

    requestAnimationFrame(() => {
      // Pane-managed height is a fixed estimate (see above) rather than a
      // measured DOM value, so there's nothing to re-measure here — this
      // recompute only matters for the non-pane (DOM-driven height) path.
      if (paneAppliesHere(supportsTouch, BREAKPOINT)) return;
      if (popoverHeight === stopPopover.current?.offsetHeight) return;
      const offset = BREAKPOINT()
        ? [0, 0]
        : [0, -stopPopover.current?.offsetHeight / 2];
      const zoom = map.getZoom();
      if (zoom < 17) {
        map.flyTo({
          zoom: 17,
          center: coordinates,
          offset,
          animate: zoom >= 12,
        });
      } else {
        map.easeTo({ center: coordinates, offset });
      }
    });
  }, []);

  const hideStopPopover = (e) => {
    const { page, subpage } = route;
    if (e && (page !== 'stop' || subpage === 'routes')) {
      e.preventDefault();
    }
    const number = stopPopoverData?.number || prevStopNumber.current;
    let stopToBeHighlighted;
    if (number) {
      const stopSource = IS_ALL_MODE && prevStopCity.current
        ? `stops-${prevStopCity.current}`
        : 'stops';
      if (map?.getSource(stopSource)) {
        map.setFeatureState({ source: stopSource, id: encode(number) }, { selected: false });
      }
      if (map?.getSource('stops-highlight')) {
        map.setFeatureState({ source: 'stops-highlight', id: encode(number) }, { selected: false });
      }
      if (stopPopover.current?.classList.contains('expand')) {
        requestAnimationFrame(() => {
          stopToBeHighlighted = servicePopover.current?.querySelector(
            `a[data-stop="${number}"]`,
          );
          stopToBeHighlighted?.classList.add('flash');
          stopToBeHighlighted?.scrollIntoView({
            behaviour: 'smooth',
            block: 'center',
            inline: 'center',
          });
        });
      }
    }
    setShowStopPopover(false);
    prevStopNumber.current = null;
    prevStopCity.current = null;
    setTimeout(() => {
      stopToBeHighlighted?.classList.remove('flash');
    }, 1000);
  };

  // Alpha "locations" feature — map pin for the selected location, created
  // lazily and reused, following GeolocateControl's DOM-marker pattern
  // (locations aren't part of the GeoJSON `stops` source, so they can't use
  // setFeatureState like stop selection does).
  const showLocationMarker = ({ lat, lon, color }) => {
    if (!locationMarkerRef.current) {
      const el = document.createElement('div');
      el.className = 'location-marker';
      el.innerHTML = '<div class="location-marker-pin"></div>';
      locationMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom' });
    }
    const pin = locationMarkerRef.current.getElement().querySelector('.location-marker-pin');
    if (pin) pin.style.color = color || '';
    locationMarkerRef.current.setLngLat([lon, lat]).addTo(map);
  };

  const hideLocationMarker = () => {
    locationMarkerRef.current?.remove();
  };

  const _showLocationPopover = useCallback((locInfo) => {
    const { lat, lon } = locInfo;
    const popoverHeight = paneOrOffsetHeight(locationPopover.current);
    const offset = BREAKPOINT() ? [0, 0] : [0, -(popoverHeight || 0) / 2];
    const zoom = map.getZoom();
    if (zoom < 16) {
      map.flyTo({ zoom: 16, center: [lon, lat], offset, animate: zoom >= 12 });
    } else {
      map.easeTo({ center: [lon, lat], offset });
    }
    showLocationMarker(locInfo);

    setShrinkSearch(true);
    setShowLocationPopover(true);
    setLocationPopoverData(locInfo);
    setLocationPopoverLoading(true);
    setLocationPopoverStops([]);

    const seq = ++locationSearchSeq.current;
    if (IS_ALL_MODE) {
      // Pin bounds-guessed candidate cities immediately so the viewport
      // engine's checkViewport (which unloads any city outside the current
      // view and not "pinned") can't rip the data back out from under
      // resolveLocationStops's loadCityData calls mid-flight.
      const candidateCities = AVAILABLE_CITIES.filter((c) => {
        const b = CITY_CONFIGS[c]?.city?.bounds;
        return b && lon >= b.lowerLong && lon <= b.upperLong && lat >= b.lowerLat && lat <= b.upperLat;
      });
      activeSelectionCities.clear();
      candidateCities.forEach((c) => activeSelectionCities.add(c));
    }
    resolveLocationStops(lat, lon).then((stops) => {
      if (seq !== locationSearchSeq.current) return; // stale — a newer location is showing
      if (IS_ALL_MODE) {
        // Now that we know the real city/cities, pin exactly those (dropping
        // any other bounds-guessed candidates) so they stay loaded for as
        // long as this popover is showing them.
        activeSelectionCities.clear();
        stops.forEach((s) => activeSelectionCities.add(s.city));
        releaseUnpinnedCities();
      }
      setLocationPopoverStops(stops);
      setLocationPopoverLoading(false);
    });

    // No cached/local-POI name was available — fall back to a reverse-geocode
    // lookup, filling in the popover title once it resolves.
    if (!locInfo.name) {
      const key = locationKey(lat, lon);
      withTimeout(fetchReverseGeocode(lat, lon), LOCATION_FETCH_TIMEOUT_MS, null).then((name) => {
        if (seq !== locationSearchSeq.current) return; // stale — a newer location is showing
        const resolved = name || 'Selected Location';
        locationNameCache.set(key, { name: resolved });
        setLocationPopoverData((prev) =>
          prev && prev.lat === lat && prev.lon === lon ? { ...prev, name: resolved } : prev,
        );
      });
    }
  }, []);

  const hideLocationPopover = () => {
    setShowLocationPopover(false);
    hideLocationMarker();
    // Belt-and-suspenders for the same race the location route handler
    // guards against above — if stops still hadn't loaded for this area by
    // the time the popover closes, re-check now rather than leaving the
    // user stuck until their next pan/zoom.
    checkViewportRef.current?.();
  };

  const navBackToStop = (e) => {
    if (prevRoute?.page === 'stop') {
      e.preventDefault();
      history.back();
    }
  };

  const zoomToStop = (num) => {
    const number = num || stopPopoverData?.number;
    const stopEntry = IS_ALL_MODE
      ? (cityDataMap.get(stopPopoverData?.city)?.stopsData?.[number] || stopsData[number])
      : stopsData[number];
    const { coordinates } = stopEntry || {};
    if (!coordinates) return;
    let offset = BREAKPOINT()
      ? [0, 0]
      : [0, -paneOrOffsetHeight(stopPopover.current) / 2];
    if (showServicePopover) {
      offset = BREAKPOINT()
        ? [-servicePopover.current.offsetWidth / 3, 0]
        : [0, -paneOrOffsetHeight(servicePopover.current) / 2];
    }
    const zoom = map.getZoom();
    if (zoom < 17) {
      map.flyTo({
        zoom: 17,
        center: coordinates,
        offset,
      });
    } else {
      map.easeTo({ center: coordinates, offset });
    }
  };

  const highlightRouteTag = (service) => {
    const $servicesList = floatPill.current?.querySelector('.services-list');
    if (!$servicesList) return;
    if (service) {
      const otherServices = $servicesList.querySelectorAll('.service-tag');
      otherServices.forEach((el) => {
        el.classList.remove('highlight');
        if (el.dataset.service.trim() === service.trim()) {
          el.style.opacity = '';
        } else {
          el.style.opacity = 0.3;
        }
      });
    } else {
      $servicesList
        .querySelectorAll('.service-tag')
        .forEach((el) => (el.style.opacity = ''));
    }
  };

  const clickRoute = (e, service) => {
    const { target } = e;
    e.stopPropagation();
    if (target.classList.contains('highlight')) return;
    e.preventDefault();
    target.classList.add('highlight');
    highlightRoute(null, service, true);
    if (IS_ALL_MODE) {
      location.hash = e.currentTarget.getAttribute('href');
    } else {
      navigateTo(`/services/${encodeURIComponent(service)}`, route);
    }
  };

  const highlightRoute = (e, service, zoomIn) => {
    if (e) e.target.classList.remove('highlight');
    const hoveredRouteID = encode(service);
    map.setFeatureState(
      {
        source: 'routes-path',
        id: hoveredRouteID,
      },
      { hover: true, fadein: false },
    );

    STORE.routesPathServices?.forEach((service) => {
      const id = encode(service);
      if (hoveredRouteID === id) return;
      map.setFeatureState(
        {
          source: 'routes-path',
          id,
        },
        { hover: false, fadein: true },
      );
    });

    if (zoomIn) {
      // Fit map to route bounds
      requestAnimationFrame(() => {
        const serviceData = servicesData[service];
        if (!serviceData) return;
        const routes = [];
        Object.keys(serviceData).forEach((key) => {
          if (key !== 'name' && Array.isArray(serviceData[key])) {
            routes.push(...serviceData[key]);
          }
        });
        const coordinates = routes
          .flat()
          .map((stop) => stopsData[stop]?.coordinates)
          .filter(Boolean);
        const bounds = new maplibregl.LngLatBounds();
        coordinates.forEach((c) => {
          bounds.extend(c);
        });
        map.fitBounds(bounds, {
          padding: largerScreen
            ? {
                top: floatPill.current.offsetHeight / 2,
                right: 80,
                bottom: 80,
                left: floatPill.current.offsetHeight / 2,
              }
            : BREAKPOINT()
              ? {
                  top: 80,
                  right: Math.max(floatPill.current.offsetWidth / 2, 80),
                  bottom: 60 + 20 + floatPill.current.offsetHeight / 2,
                  left: Math.max(floatPill.current.offsetWidth / 2, 80),
                }
              : {
                  top: 80,
                  right: 80,
                  bottom: 60 + 20 + floatPill.current.offsetHeight, // height of search bar + float pill
                  left: 80,
                },
        });
      });
    }
  };

  const unhighlightRoute = (e) => {
    if (e && e.target?.classList.contains('service-tag')) {
      e.target.classList.remove('highlight');
    }
    STORE.routesPathServices?.forEach((service) => {
      const id = encode(service);
      map.setFeatureState(
        {
          source: 'routes-path',
          id,
        },
        { fadein: false, hover: false },
      );
    });
  };

  const _showBetweenPopover = (data) => {
    setShrinkSearch(true);
    setShowBetweenPopover(data);

    // Only auto-select when there's a single candidate route — with
    // multiple candidates the list itself is the useful result and should
    // stay showing. Mirrors clicking the (only) result; safe since
    // navigating to its /<n> subpage no longer wipes showBetweenPopover,
    // see the isSameBetweenQuery guard in renderRoute().
    if (data.results?.length === 1) {
      setTimeout(() => {
        const firstResult = betweenPopover.current?.querySelector('.between-item');
        firstResult?.click();
      }, 300);
    }
  };

  const cannotPreviewRoute = () => {
    const { page, subpage, value } = route;
    return (
      subpage === 'routes' ||
      (page === 'service' && value.split('~').length > 1)
    );
  };

  const previewRoute = (service) => {
    if (IS_ALL_MODE) return; // later implement preview route
    cancelAnimationFrame(previewRAF);
    if (cannotPreviewRoute()) return;
    previewRAF = requestAnimationFrame(() => {
      const routes = routesData[service];
      const geometries = routes.map((route) => decodePolyline(route));
      map.getSource('routes-path').setData({
        type: 'FeatureCollection',
        features: geometries.map((geometry) => ({
          type: 'Feature',
          id: encode(service),
          properties: {
            service,
          },
          geometry,
        })),
      });
    });
  };

  const unpreviewRoute = () => {
    cancelAnimationFrame(previewRAF);
    if (cannotPreviewRoute()) return;
    map.getSource('routes-path').setData({
      type: 'FeatureCollection',
      features: [],
    });
  };

  const isValidCoords = (coords) =>
    Array.isArray(coords) &&
    coords.length >= 2 &&
    typeof coords[0] === 'number' &&
    !isNaN(coords[0]) &&
    typeof coords[1] === 'number' &&
    !isNaN(coords[1]);

  // Draws an itinerary (legacy single-city or RAPTOR cross-city — both share
  // the {startId, legs} shape since dataWorker.js's handleBetweenRoutes was
  // normalized to match raptor.js's output) on the map: stop markers,
  // service-polyline segments per ride leg, and straight lines per walk leg.
  //
  // `resolveStop(id)` and `getServicePolylines(city, service)` are the two
  // things that differ by mode — legacy ids are bare stop numbers resolved
  // via the single loaded city's `stopsData`; RAPTOR ids are `city^number`
  // resolved via `cityDataMap`, and its polylines come from the matching
  // city's own `routesData`.
  //
  // `literalStartStop`/`literalEndStop` are legacy-only: the stop the user
  // actually picked, which can differ from `itinerary.startId`/the last
  // leg's `to` when a nearby-stop match was used — RAPTOR never needs this,
  // since its own search already bakes a real walk leg into `legs` for that
  // case. Passing them synthesizes the equivalent leading/trailing walk leg
  // here for rendering, exactly as RAPTOR itineraries already carry one.
  const renderBetweenItinerary = (
    itinerary,
    { e, resolveStop, getServicePolylines, literalStartStop, literalEndStop } = {},
  ) => {
    if (!itinerary?.legs?.length) return;

    // Selection highlighting (skipped when called without a click event, e.g.
    // restoring a selection from a deep-linked result URL)
    const clickedItem = e?.target?.closest('.between-item');
    if (clickedItem) {
      const container = clickedItem.closest('.between-block');
      if (container) {
        container.querySelectorAll('.between-item').forEach((el) => {
          el.classList.toggle('selected', el === clickedItem);
        });
      }
    }

    const renderLegs = [...itinerary.legs];
    let renderStartId = itinerary.startId;
    if (literalStartStop && String(itinerary.startId) !== String(literalStartStop.number)) {
      renderLegs.unshift({ kind: 'walk', to: itinerary.startId });
      renderStartId = literalStartStop.number;
    }
    const lastTo = itinerary.legs[itinerary.legs.length - 1].to;
    if (literalEndStop && String(lastTo) !== String(literalEndStop.number)) {
      renderLegs.push({ kind: 'walk', to: literalEndStop.number });
    }

    // Build stops for map markers
    const highlightStops = [];
    const addHighlight = (id, type) => {
      const stop = resolveStop(id);
      if (stop?.coordinates && isValidCoords(stop.coordinates)) {
        highlightStops.push({ ...stop, number: id, _type: type });
      }
    };

    addHighlight(renderStartId, 'end');
    addHighlight(renderLegs[renderLegs.length - 1].to, 'end');
    // Every intermediate leg's destination is an interchange/waypoint, not
    // the origin or destination — a transfer leg's full candidate list (see
    // dataWorker.js) is shown in full rather than just the resolved one.
    renderLegs.slice(0, -1).forEach((leg) => {
      if (leg.transferCandidates?.length) {
        leg.transferCandidates.forEach((number) => addHighlight(number, 'intersect'));
      } else {
        addHighlight(leg.to, 'intersect');
      }
    });

    // Update stops-highlight source
    const stopsHighlightSource = map.getSource('stops-highlight');
    if (stopsHighlightSource) {
      stopsHighlightSource.setData({
        type: 'FeatureCollection',
        features: highlightStops.map((stop) => ({
          type: 'Feature',
          id: encode(stop.number),
          properties: {
            name: stop.name,
            number: stop.number,
            type: stop._type,
            left: stop.left,
          },
          geometry: { type: 'Point', coordinates: stop.coordinates },
        })),
      });
    }

    requestAnimationFrame(() => {
      const geometries = [];
      let fromId = renderStartId;
      renderLegs.forEach((leg) => {
        const fromStop = resolveStop(fromId);
        const toStop = resolveStop(leg.to);
        fromId = leg.to;
        if (!fromStop?.coordinates || !toStop?.coordinates) return;

        if (leg.kind === 'walk') {
          geometries.push({
            kind: 'walk',
            geometry: { type: 'LineString', coordinates: [fromStop.coordinates, toStop.coordinates] },
          });
          return;
        }

        const servicePolylines = getServicePolylines(fromStop.city, leg.service);
        let cropped = null;
        if (servicePolylines?.length) {
          try {
            cropped = findBestRouteSegment(servicePolylines, fromStop.coordinates, toStop.coordinates, toGeoJSON);
          } catch (err) {
            console.warn(`Failed to render segment for ${leg.service}:`, err);
          }
        }
        geometries.push({
          kind: 'ride',
          geometry: cropped
            ? { type: 'LineString', coordinates: cropped }
            : { type: 'LineString', coordinates: [fromStop.coordinates, toStop.coordinates] },
        });
      });

      // Update routes-between source — the first/second *ride* segment gets
      // the start/end gradient color (see the 'routes-between' layer's
      // paint), regardless of where any walk segments fall in the sequence.
      const routesBetweenSource = map.getSource('routes-between');
      if (routesBetweenSource) {
        let rideIndex = 0;
        routesBetweenSource.setData({
          type: 'FeatureCollection',
          features: geometries.map(({ kind, geometry }) => {
            const type = kind === 'walk' ? 'walk' : rideIndex++ === 0 ? 'start' : 'end';
            return { type: 'Feature', properties: { type }, geometry };
          }),
        });
      }

      // Fit map bounds
      const bounds = new maplibregl.LngLatBounds();
      let hasValidBounds = false;
      highlightStops.forEach((stop) => {
        if (isValidCoords(stop.coordinates)) {
          bounds.extend(stop.coordinates);
          hasValidBounds = true;
        }
      });
      if (hasValidBounds) {
        map.fitBounds(bounds, {
          padding: BREAKPOINT()
            ? { top: 80, right: (betweenPopover.current?.offsetWidth || 0) + 80, bottom: 80, left: 80 }
            : { top: 80, right: 80, bottom: (betweenPopover.current?.offsetHeight || 0) + 80, left: 80 },
        });
      }
    });
  };

  const legacyResolveStop = (id) => {
    const s = stopsData?.[id];
    return s ? { ...s, city: undefined, number: id } : null;
  };
  const legacyGetServicePolylines = (city, service) => routesData?.[service];

  const allModeResolveStop = (globalId) => {
    const [city, number] = String(globalId).split('^');
    const stop = cityDataMap.get(city)?.stopsData?.[number];
    return stop ? { ...stop, city, number } : null;
  };
  const allModeGetServicePolylines = (city, service) => cityDataMap.get(city)?.routesData?.[service];

  // Nationwide precomputed indices for all-mode routing, fetched once and
  // cached: the inter-cluster walking-transfer graph (data/all/transfers.min.json)
  // and the per-stop trip-frequency index (data/all/frequency.min.json) the
  // RAPTOR search's cost function looks up synchronously (no network calls
  // inside the round loop — see raptor.js's header comment for why that
  // matters). The intra-cluster same-place stop groups come from each city's
  // own clusters.min.json (already fetched into cityDataMap by loadCityData)
  // plus the small loadCrossCityClusters() leftover, not a single nationwide
  // file — see globaltransfers.py.
  let globalTransfersPromise = null;
  const loadGlobalTransfers = () => {
    if (!globalTransfersPromise) {
      globalTransfersPromise = fetchCache('/data/all/transfers.min.json', 24 * 60);
    }
    return globalTransfersPromise;
  };
  let globalFrequencyPromise = null;
  const loadGlobalFrequency = () => {
    if (!globalFrequencyPromise) {
      globalFrequencyPromise = fetchCache('/data/all/frequency.min.json', 24 * 60);
    }
    return globalFrequencyPromise;
  };

  /**
   * All-mode `between`: runs unscoped (cross-city) RAPTOR over every city's
   * route graph. The search itself needs every city's stop/route data in
   * memory (it doesn't know upfront which cities a path will cross), so this
   * fetches data-only for every city via `loadCityData` — no map sources or
   * layers, just the routing graph. Only the cities actually touched by the
   * resulting itineraries (plus the two endpoint cities) get their stops/
   * routes fully loaded onto the map afterwards, and are pinned in
   * `activeSelectionCities` so panning the map while viewing the result can't
   * unload them. Additive to, and independent of, single-city `between`'s
   * worker-based search.
   */
  // startToken/endToken are `between` endpoint tokens (see encodeBetweenToken/
  // decodeBetweenToken) — either "{city}^{number}" for a stop, or
  // "loc:{lat},{lon}" for a location, which resolves to its whole nearby-stop
  // cluster and searches from/to all of them at once (see computeRaptorRoute's
  // startIds/endIds).
  const runAllModeBetween = async (startToken, endToken) => {
    const startEndpoint = decodeBetweenToken(startToken);
    const endEndpoint = decodeBetweenToken(endToken);
    // Computed synchronously (cache/POI lookup only, no network) so the
    // header never has to fall back to the raw "loc:{lat},{lon}" token
    // during the "Finding routes…" phase, before startStop/endStop resolve.
    const startLocation = startEndpoint?.type === 'location'
      ? { lat: startEndpoint.lat, lon: startEndpoint.lon, name: friendlyLocationName(startEndpoint.lat, startEndpoint.lon) }
      : null;
    const endLocation = endEndpoint?.type === 'location'
      ? { lat: endEndpoint.lat, lon: endEndpoint.lon, name: friendlyLocationName(endEndpoint.lat, endEndpoint.lon) }
      : null;
    activeSelectionCities.clear();
    if (startEndpoint?.type === 'stop') activeSelectionCities.add(startEndpoint.city);
    if (endEndpoint?.type === 'stop') activeSelectionCities.add(endEndpoint.city);
    setAllModeBetween({
      startId: startToken,
      endId: endToken,
      startStop: null,
      endStop: null,
      startLocation,
      endLocation,
      itineraries: [],
      loading: true,
      error: null,
    });

    try {
      const [, transfers, crossCityClusters, frequencyIndex] = await Promise.all([
        Promise.all(AVAILABLE_CITIES.map((c) => loadCityData(c))),
        loadGlobalTransfers(),
        loadCrossCityClusters(),
        loadGlobalFrequency(),
      ]);

      const resolveEndpoint = async (endpoint) => {
        if (!endpoint) return null;
        if (endpoint.type === 'stop') {
          const stop = cityDataMap.get(endpoint.city)?.stopsData?.[endpoint.number];
          return stop
            ? { ids: [`${endpoint.city}^${endpoint.number}`], displayStop: { ...stop, city: endpoint.city, number: endpoint.number } }
            : null;
        }
        const stops = await resolveLocationStops(endpoint.lat, endpoint.lon);
        return stops.length
          ? { ids: stops.map((s) => `${s.city}^${s.number}`), displayStop: stops[0] }
          : null;
      };

      const [startResolved, endResolved] = await Promise.all([
        resolveEndpoint(startEndpoint),
        resolveEndpoint(endEndpoint),
      ]);
      if (!startResolved || !endResolved) {
        setAllModeBetween((prev) =>
          prev && prev.startId === startToken && prev.endId === endToken
            ? { ...prev, loading: false, error: 'Stop not found.' }
            : prev,
        );
        return;
      }

      // Build the index and run the search inside a worker — both are
      // synchronous, CPU-bound work over every currently-loaded city's stop/
      // route data and previously ran on the main thread for every search.
      await syncRaptorWorkerCities(cityDataMap);
      const { itineraries, globalIndex } = await searchRaptorWorker({
        cityCodes: [...cityDataMap.keys()],
        transfers,
        crossCityClusters,
        frequencyIndex,
        startIds: startResolved.ids,
        endIds: endResolved.ids,
      });
      if (itineraries.length) await refineWithSchedule(itineraries, globalIndex);

      // Render/pin only the cities the result actually touches — everything
      // else stays data-only (fetched above for the search, but never added
      // to the map).
      const touchedCities = new Set(
        [...startResolved.ids, ...endResolved.ids].map((id) => id.split('^')[0]),
      );
      itineraries.forEach((it) => {
        it.legs.forEach((leg) => touchedCities.add(leg.to.split('^')[0]));
      });
      touchedCities.forEach((c) => activeSelectionCities.add(c));
      await Promise.all([...touchedCities].map((c) => loadCity(c)));
      // Release cities pinned by a previous between query that this one
      // doesn't touch and that are outside the viewport.
      releaseUnpinnedCities();

      setAllModeBetween((prev) =>
        prev && prev.startId === startToken && prev.endId === endToken
          ? {
              ...prev,
              startStop: startResolved.displayStop,
              endStop: endResolved.displayStop,
              itineraries,
              loading: false,
              error: itineraries.length ? null : 'No route found.',
            }
          : prev,
      );
    } catch (error) {
      console.error('runAllModeBetween failed:', error);
      setAllModeBetween((prev) =>
        prev && prev.startId === startToken && prev.endId === endToken
          ? { ...prev, loading: false, error: 'Something went wrong.' }
          : prev,
      );
    }
  };

  // Deep-linking a specific result (`.../between/<query>/<result-num>`) should
  // draw that itinerary on the map even if the user never clicked it — e.g. a
  // shared link, or the back/forward buttons restoring a selection.
  useEffect(() => {
    if (route.page !== 'between' || !route.subpage) return;
    const idx = parseInt(route.subpage, 10) - 1;
    if (!Number.isInteger(idx) || idx < 0) return;

    if (IS_ALL_MODE) {
      const itinerary = allModeBetween?.itineraries?.[idx];
      if (itinerary) {
        renderBetweenItinerary(itinerary, {
          resolveStop: allModeResolveStop,
          getServicePolylines: allModeGetServicePolylines,
        });
      }
    } else if (showBetweenPopover) {
      const sorted = sortAndFilterResults(
        showBetweenPopover.results || [],
        showBetweenPopover.arrivalData,
        showBetweenPopover.staticFrequency,
      );
      const itinerary = sorted[idx];
      if (itinerary) {
        renderBetweenItinerary(itinerary, {
          resolveStop: legacyResolveStop,
          getServicePolylines: legacyGetServicePolylines,
          literalStartStop: showBetweenPopover.startStop,
          literalEndStop: showBetweenPopover.endStop,
        });
      }
    }
  }, [route.page, route.subpage, allModeBetween, showBetweenPopover]);

  const defaultURL = document.querySelector('meta[property="og:url"]').content;
  const defaultImg = document.querySelector(
    'meta[property="og:image"]',
  ).content;
  const defaultHead = {
    title: ['app.title'],
    url: defaultURL,
    desc: ['app.description'],
    image: defaultImg,
  };
  const [head, setHead] = useState(defaultHead);
  useEffect(() => {
    let { title, url, desc, image } = head;
    document.title = document.querySelector(
      'meta[property="og:title"]',
    ).content = Array.isArray(title) ? t(...title) : title;
    if (!/^https?/.test(url)) {
      const { city } = route;
      const cityPrefix = city ? `/${city}` : '';
      url = `https://transitrouter.vonter.in/#${cityPrefix}${url}`;
    }
    document.querySelector('meta[property="og:url"]').content = url;
    document.querySelector('meta[name="description"]').content =
      document.querySelector('meta[property="og:description"]').content =
        Array.isArray(desc) ? t(...desc) : desc;
    document.querySelector('meta[property="og:image"]').content = image;
  }, [head]);

  const renderRoute = () => {
    const route = getRoute();

    // All-mode: viewport engine manages city data; handle stop selection via cityDataMap
    if (IS_ALL_MODE) {
      $map.classList.remove('fade-out');
      setShowServicePopover(false);
      setShowBetweenPopover(false);
      if (route.page !== 'between') setAllModeBetween(null);
      if (route.page !== 'location') {
        setShowLocationPopover(false);
        hideLocationMarker();
      }
      vehicleTracker.current?.stop();
      setRouteLoading(false);

      // Clear previous stop selection on every navigation (unless staying on same stop)
      if (prevStopNumber.current && prevStopCity.current) {
        const isStayingOnStop =
          route.page === 'stop' &&
          route.value === `${prevStopCity.current}^${prevStopNumber.current}`;
        if (!isStayingOnStop) {
          const prevSrc = `stops-${prevStopCity.current}`;
          if (map?.getSource(prevSrc)) {
            map.setFeatureState({ source: prevSrc, id: encode(prevStopNumber.current) }, { selected: false });
          }
          if (map?.getSource('stops-highlight')) {
            map.setFeatureState({ source: 'stops-highlight', id: encode(prevStopNumber.current) }, { selected: false });
          }
          prevStopNumber.current = null;
          prevStopCity.current = null;
          setShowStopPopover(false);
        }
      } else if (route.page !== 'stop') {
        setShowStopPopover(false);
      }

      if (route.page === 'service' && route.value) {
        // Leaving a between-detail view (e.g. via a leg's service-tag link)
        // must not leave its itinerary line/highlight drawn on the map -
        // the single-city path clears these unconditionally on every
        // navigation, but all-mode's per-page branches don't share that
        // reset, so this branch needs its own clear.
        map.getSource('routes-between')?.setData({ type: 'FeatureCollection', features: [] });
        map.getSource('stops-highlight')?.setData({ type: 'FeatureCollection', features: [] });

        // Parse all city^service segments from the value (supports multi-route via ~)
        const qualifiedParts = route.value.split('~').filter((p) => p.includes('^'));
        if (qualifiedParts.length) {
          // Group services by city: { cityCode → [svcNum, ...] }
          const cityGroups = {};
          qualifiedParts.forEach((qp) => {
            const c = qp.indexOf('^');
            const city = qp.slice(0, c);
            const num = qp.slice(c + 1);
            if (!cityGroups[city]) cityGroups[city] = [];
            cityGroups[city].push(num);
          });

          const renderAllModeServices = (cityEntries) => {
            // Merge data from all involved cities into module-level vars
            Object.keys(stopsData).forEach((k) => delete stopsData[k]);
            Object.keys(servicesData).forEach((k) => delete servicesData[k]);
            Object.keys(routesData).forEach((k) => delete routesData[k]);
            const mergedStopsDataArr = [];
            Object.values(cityEntries).forEach((entry) => {
              Object.assign(stopsData, entry.stopsData);
              Object.assign(servicesData, entry.servicesData);
              Object.assign(routesData, entry.routesData);
              mergedStopsDataArr.push(...entry.stopsDataArr);
            });
            window._data = {
              stopsData,
              stopsDataArr: mergedStopsDataArr,
              servicesData,
              routesData,
              servicesDataArr: [],
            };

            // All service numbers (unqualified) across cities
            const allSvcNums = Object.values(cityGroups).flat();
            const primarySvcNum = allSvcNums[0];

            activeSelectionCities.clear();
            Object.keys(cityGroups).forEach((c) => activeSelectionCities.add(c));
            releaseUnpinnedCities();
            setExpandSearch(false);
            setShrinkSearch(true);
            setRouteServices(allSvcNums);
            setShowServicePopover(true);

            // Compute intersecting stops for multi-service views
            if (allSvcNums.length > 1) {
              const routeStopsList = [];
              allSvcNums.forEach((svcNum) => {
                const serviceData = servicesData[svcNum];
                if (!serviceData) return;
                Object.keys(serviceData).forEach((key) => {
                  if (key === 'name') return;
                  const variants = serviceData[key];
                  if (!Array.isArray(variants)) return;
                  if (variants[0]) variants[0].forEach((s) => routeStopsList.push(s));
                  if (variants[1]) variants[1].forEach((s) => routeStopsList.push(s));
                });
              });
              setIntersectStops(uniqueAndIntersectingStops(routeStopsList).intersecting);
            } else {
              setIntersectStops([]);
            }

            // Page title
            if (allSvcNums.length === 1) {
              const svcName = Object.values(cityEntries)[0]?.servicesData?.[allSvcNums[0]]?.name || '';
              setHead({
                title: ['service.title', { serviceNumber: allSvcNums[0], serviceName: svcName }],
                url: `/all/services/${route.value}`,
              });
            } else {
              const serviceNumbersNames = allSvcNums.join(', ');
              setHead({
                title: ['service.titleMultiple', { serviceNumbersNames }],
                url: `/all/services/${route.value}`,
              });
            }

            // Hide all city stop layers so only route stops (stops-highlight) are visible
            loadedCities.forEach((c) => {
              if (map.getLayer(`stops-${c}`)) map.setLayoutProperty(`stops-${c}`, 'visibility', 'none');
              if (map.getLayer(`stops-icon-${c}`)) map.setLayoutProperty(`stops-icon-${c}`, 'visibility', 'none');
            });

            // Draw all route lines
            requestAnimationFrame(() => {
              const allGeometries = [];
              allSvcNums.forEach((svcNum) => {
                const routes = routesData[svcNum];
                if (routes) allGeometries.push(...routes.map((r) => decodePolyline(r)));
              });
              map.getSource('routes')?.setData({
                type: 'FeatureCollection',
                features: allGeometries.map((geometry) => ({ type: 'Feature', properties: {}, geometry })),
              });
            });

            // Collect stops for all services
            const allRouteStops = new Set();
            const endStops = new Set();
            allSvcNums.forEach((svcNum) => {
              const serviceData = servicesData[svcNum];
              if (!serviceData) return;
              Object.keys(serviceData).forEach((key) => {
                if (key === 'name') return;
                const variants = serviceData[key];
                if (!Array.isArray(variants)) return;
                if (variants[0]) {
                  variants[0].forEach((s) => allRouteStops.add(s));
                  endStops.add(variants[0][0]);
                  endStops.add(variants[0][variants[0].length - 1]);
                }
                if (variants[1]) variants[1].forEach((s) => allRouteStops.add(s));
              });
            });

            map.getSource('stops-highlight')?.setData({
              type: 'FeatureCollection',
              features: [...allRouteStops].filter((s) => stopsData[s]).map((s) => ({
                type: 'Feature',
                id: encode(s),
                properties: {
                  name: stopsData[s].name,
                  number: s,
                  type: endStops.has(s) ? 'end' : null,
                  left: stopsData[s].left,
                },
                geometry: { type: 'Point', coordinates: stopsData[s].coordinates },
              })),
            });

            // Fit map to combined bounds
            const bounds = new maplibregl.LngLatBounds();
            [...allRouteStops].forEach((s) => {
              if (stopsData[s]) bounds.extend(stopsData[s].coordinates);
            });
            if (!bounds.isEmpty()) {
              requestAnimationFrame(() => {
                map.fitBounds(bounds, {
                  padding: BREAKPOINT()
                    ? { top: 80, right: (servicePopover.current?.offsetWidth || 320) + 80, bottom: 80, left: 80 }
                    : { top: 80, right: 80, bottom: (paneOrOffsetHeight(servicePopover.current) || 200) + 20, left: 80 },
                });
              });
            }
          };

          const uniqueCities = Object.keys(cityGroups);
          Promise.all(uniqueCities.map((c) => loadCity(c))).then(() => {
            const cityEntries = {};
            uniqueCities.forEach((c) => {
              const entry = cityDataMap.get(c);
              if (entry) cityEntries[c] = entry;
            });
            if (Object.keys(cityEntries).length) renderAllModeServices(cityEntries);
          });
        }
        return;
      } else if (route.page === 'stop' && route.value) {
        // Restore city stop layers and clear service route in case we came from a service view
        loadedCities.forEach((c) => {
          if (map.getLayer(`stops-${c}`)) map.setLayoutProperty(`stops-${c}`, 'visibility', 'visible');
          if (map.getLayer(`stops-icon-${c}`)) map.setLayoutProperty(`stops-icon-${c}`, 'visibility', 'visible');
        });
        map.getSource('routes')?.setData({ type: 'FeatureCollection', features: [] });
        map.getSource('stops-highlight')?.setData({ type: 'FeatureCollection', features: [] });

        const caret = route.value.indexOf('^');
        const [stopCity, stopNum] = caret !== -1
          ? [route.value.slice(0, caret), route.value.slice(caret + 1)]
          : [null, null];
        if (stopCity && stopNum) {
          const cityData = cityDataMap.get(stopCity);
          if (cityData?.stopsData?.[stopNum]) {
            _showStopPopover(stopNum, { city: stopCity, stopData: cityData.stopsData[stopNum] });
          } else {
            // City not loaded yet — load it, then show popover
            loadCity(stopCity).then(() => {
              const loaded = cityDataMap.get(stopCity);
              if (loaded?.stopsData?.[stopNum]) {
                _showStopPopover(stopNum, { city: stopCity, stopData: loaded.stopsData[stopNum] });
              }
            });
          }
        } else {
          setShowStopPopover(false);
        }
      } else if (route.page === 'between' && route.value) {
        map.getSource('routes')?.setData({ type: 'FeatureCollection', features: [] });
        const parsedEndpoints = parseBetweenValue(route.value);
        if (!parsedEndpoints) {
          navigateTo('/', route);
        } else {
          const [startEndpoint, endEndpoint] = parsedEndpoints;
          const startToken = encodeBetweenToken(startEndpoint);
          const endToken = encodeBetweenToken(endEndpoint);
          setHead({
            title: `Directions - ${t('app.name')}`,
            url: `/all/between/${route.value}`,
          });
          setExpandSearch(false);
          setShrinkSearch(true);
          // Hide every loaded city's own stops layer only once a specific
          // itinerary is selected (route.subpage present) — the result list
          // view keeps stops visible, matching single-city between's behavior.
          loadedCities.forEach((c) => {
            const visibility = route.subpage ? 'none' : 'visible';
            if (map.getLayer(`stops-${c}`)) map.setLayoutProperty(`stops-${c}`, 'visibility', visibility);
            if (map.getLayer(`stops-icon-${c}`)) map.setLayoutProperty(`stops-icon-${c}`, 'visibility', visibility);
          });
          // Navigating back to the result list (subpage dropped, e.g. closing
          // the detail view) leaves no itinerary selected — clear the
          // previously drawn detail line/highlight so it doesn't linger.
          if (!route.subpage) {
            map.getSource('stops-highlight')?.setData({ type: 'FeatureCollection', features: [] });
            map.getSource('routes-between')?.setData({ type: 'FeatureCollection', features: [] });
          }
          const queryKey = `${startToken}|${endToken}`;
          if (lastAllModeBetweenQuery.current !== queryKey) {
            lastAllModeBetweenQuery.current = queryKey;
            runAllModeBetween(startToken, endToken);
          }
        }
      } else if (route.page === 'location' && route.value) {
        if (!isAlphaEnabled()) {
          navigateTo('/', route);
          return;
        }
        const [rawLat, rawLon] = route.value.split(',');
        const lat = parseFloat(rawLat);
        const lon = parseFloat(rawLon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          navigateTo('/', route);
          return;
        }
        setExpandSearch(false);
        setShrinkSearch(true);
        const key = locationKey(lat, lon);
        const cached = locationNameCache.get(key) || findMatchingPoi(lat, lon);
        const locInfo = {
          lat, lon,
          name: cached?.name || null,
          type: cached?.type || null,
          color: cached?.color || null,
        };
        if (cached && !locationNameCache.has(key)) locationNameCache.set(key, cached);
        setHead({
          title: `${locInfo.name || 'Location'} - ${t('app.name')}`,
          url: `/all/locations/${route.value}`,
        });
        // Restore any city stop layers a previous service view hid (mirrors
        // the 'stop' branch above), and force the viewport-driven city
        // loader to re-evaluate around this location right away — a
        // location page can center the map without the user ever panning
        // again afterward, and that loader otherwise only runs on
        // moveend/zoomend, so a city whose bounds weren't loaded yet at
        // that exact moment would never get picked up.
        loadedCities.forEach((c) => {
          if (map.getLayer(`stops-${c}`)) map.setLayoutProperty(`stops-${c}`, 'visibility', 'visible');
          if (map.getLayer(`stops-icon-${c}`)) map.setLayoutProperty(`stops-icon-${c}`, 'visibility', 'visible');
        });
        _showLocationPopover(locInfo);
        checkViewportRef.current?.();
      } else {
        activeSelectionCities.clear();
        releaseUnpinnedCities();
        setShowStopPopover(false);
        setHead(defaultHead);
        // Clear route/stop highlight sources when returning home
        map.getSource('routes')?.setData({ type: 'FeatureCollection', features: [] });
        map.getSource('routes-path')?.setData({ type: 'FeatureCollection', features: [] });
        map.getSource('routes-between')?.setData({ type: 'FeatureCollection', features: [] });
        map.getSource('stops-highlight')?.setData({ type: 'FeatureCollection', features: [] });
        // Restore city stop layers in case we came from a service view
        loadedCities.forEach((c) => {
          if (map.getLayer(`stops-${c}`)) map.setLayoutProperty(`stops-${c}`, 'visibility', 'visible');
          if (map.getLayer(`stops-icon-${c}`)) map.setLayoutProperty(`stops-icon-${c}`, 'visibility', 'visible');
        });
      }
      return;
    }

    // Navigating between subpages of the *same* between query (e.g. picking
    // a result, or closing the detail view back to the list) only changes
    // route.subpage — it must not wipe the popover/map state the 'between'
    // case below relies on still being there, since its own dedup guard
    // (lastBetweenQuery) skips re-fetching/re-populating in that case.
    const isSameBetweenQuery =
      route.page === 'between' &&
      lastBetweenQuery.current === `${route.city}|${route.value}`;

    // Reset everything
    $map.classList.remove('fade-out');
    setShowStopPopover(false);
    setShowServicePopover(false);
    if (!isSameBetweenQuery) setShowBetweenPopover(false);
    if (route.page !== 'location') {
      setShowLocationPopover(false);
      hideLocationMarker();
    }
    if (map.getLayer('dim-overlay')) {
      map.setPaintProperty('dim-overlay', 'fill-opacity', 0);
    }

    // Stop vehicle tracking when changing routes
    vehicleTracker.current?.stop();

    // Clear map sources - only clear sources that have data to avoid unnecessary re-renders
    batchClearSources(map, [
      ...(isSameBetweenQuery ? [] : ['stops-highlight', 'routes-between']),
      'routes',
      'routes-path',
      'buses-service',
    ]);
    if (prevStopNumber.current) {
      hideStopPopover();
    }

    switch (route.page) {
      case 'service': {
        const servicesValue = route.value;
        const services = servicesValue
          .split('~')
          .map((s) => findServiceKey(s))
          .filter(Boolean);
        if (!services.length) return; // No value or none of the service codes are valid

        services.forEach((service) =>
          routeMetrics(route.city, service, 'main'),
        );

        // Reset
        setExpandSearch(false);
        setShrinkSearch(true);
        resetSearch();

        // Hide all stops
        map.setLayoutProperty('stops', 'visibility', 'none');
        if (map.getLayer('stops-icon')) {
          map.setLayoutProperty('stops-icon', 'visibility', 'none');
        }

        setRouteServices(services);

        if (services.length === 1) {
          const service = services[0];
          const serviceData = servicesData[service];
          const { name } = serviceData;

          // Extract routes from all destinations
          const routes = [];
          Object.keys(serviceData).forEach((key) => {
            if (key !== 'name') {
              // Each destination has an array of route variations
              const destinationRoutes = serviceData[key];
              if (
                Array.isArray(destinationRoutes) &&
                destinationRoutes.length > 0
              ) {
                routes.push(...destinationRoutes);
              }
            }
          });

          setHead({
            title: [
              'service.title',
              {
                serviceNumber: service,
                serviceName: name,
              },
            ],
            url: `${route.cityPrefix}/services/${encodeURIComponent(service)}`,
          });

          setShowServicePopover(true);

          // Show stops of the selected service
          if (routes.length > 0 && routes[0] && routes[0].length > 0) {
            const endStops = [routes[0][0], routes[0][routes[0].length - 1]];
            if (routes[1] && routes[1].length > 0)
              endStops.push(routes[1][0], routes[1][routes[1].length - 1]);
            let routeStops = [...new Set([...routes[0], ...(routes[1] || [])])]; // Merge and unique

            // Fit map to route bounds
            const bounds = new maplibregl.LngLatBounds();
            routeStops.forEach((stop) => {
              const { coordinates } = stopsData[stop];
              bounds.extend(coordinates);
            });
            requestAnimationFrame(() => {
              const mobileBottomPad = paneOrOffsetHeight(servicePopover.current) + 20;
              map.fitBounds(bounds, {
                padding: BREAKPOINT()
                  ? {
                      top: 80,
                      right: servicePopover.current.offsetWidth + 80,
                      bottom: 80,
                      left: 80,
                    }
                  : {
                      top: 80,
                      right: 80,
                      bottom: mobileBottomPad,
                      left: 80,
                    },
              });
            });

            map.getSource('stops-highlight').setData({
              type: 'FeatureCollection',
              features: routeStops.map((stop, i) => {
                const { name, left } = stopsData[stop];
                return {
                  type: 'Feature',
                  id: encode(stop),
                  properties: {
                    name,
                    number: stop,
                    type: endStops.includes(stop) ? 'end' : null,
                    left,
                  },
                  geometry: {
                    type: 'Point',
                    coordinates: stopsData[stop].coordinates,
                  },
                };
              }),
            });

            // Show routes
            requestAnimationFrame(() => {
              const routes = routesData[service];
              const geometries = routes.map((route) => decodePolyline(route));
              map.getSource('routes').setData({
                type: 'FeatureCollection',
                features: geometries.map((geometry) => ({
                  type: 'Feature',
                  properties: {},
                  geometry,
                })),
              });
            });

            // Start vehicle tracking for this route (will fetch route ID dynamically)
            vehicleTracker.current?.start(service);
          }
        } else {
          const serviceNumbersNames = services
            .map((s) => {
              const { name } = servicesData[s];
              return `${s}: ${name}`;
            })
            .join(', ');
          setHead({
            title: ['service.titleMultiple', { serviceNumbersNames }],
            url: `${route.cityPrefix}/services/${services.map((s) => encodeURIComponent(s)).join('~')}`,
          });

          let routeStops = [];
          let endStops = [];
          let serviceGeometries = [];
          services.forEach((service) => {
            const serviceData = servicesData[service];
            // Extract routes from all destinations
            const routes = [];
            Object.keys(serviceData).forEach((key) => {
              if (key !== 'name') {
                const destinationRoutes = serviceData[key];
                if (
                  Array.isArray(destinationRoutes) &&
                  destinationRoutes.length > 0
                ) {
                  routes.push(...destinationRoutes);
                }
              }
            });

            if (routes.length > 0) {
              endStops.push(routes[0][0], routes[0][routes[0].length - 1]);
              if (routes[1]) {
                endStops.push(routes[1][0], routes[1][routes[1].length - 1]);
              }
              const allRoutes = [...new Set([...routes[0], ...(routes[1] || [])])];
              routeStops = routeStops.concat(allRoutes);
            }

            const routeGeometries = routesData[service];
            if (routeGeometries) {
              serviceGeometries = serviceGeometries.concat(
                routeGeometries.map((r) => ({
                  service,
                  geometry: decodePolyline(r),
                })),
              );
            }
          });

          // Merge and unique stops
          const { unique: dedupedRouteStops, intersecting: intersectStops } =
            uniqueAndIntersectingStops(routeStops);
          routeStops = dedupedRouteStops;
          setIntersectStops(intersectStops);

          // Fit map to route bounds
          const bounds = new maplibregl.LngLatBounds();
          routeStops.forEach((stop) => {
            const { coordinates } = stopsData[stop];
            bounds.extend(coordinates);
          });
          requestAnimationFrame(() => {
            map.fitBounds(bounds, {
              padding: largerScreen
                ? {
                    top: floatPill.current.offsetHeight / 2,
                    right: 80,
                    bottom: 80,
                    left: floatPill.current.offsetHeight / 2,
                  }
                : BREAKPOINT()
                  ? {
                      top: 80,
                      right: Math.max(floatPill.current.offsetWidth / 2, 80),
                      bottom: 60 + 20 + floatPill.current.offsetHeight / 2,
                      left: Math.max(floatPill.current.offsetWidth / 2, 80),
                    }
                  : {
                      top: 80,
                      right: 80,
                      bottom: 60 + 20 + floatPill.current.offsetHeight, // height of search bar + float pill
                      left: 80,
                    },
            });
          });

          map.getSource('stops-highlight').setData({
            type: 'FeatureCollection',
            features: routeStops.map((stop, i) => {
              const { name, left } = stopsData[stop];
              return {
                type: 'Feature',
                id: encode(stop),
                properties: {
                  name,
                  number: stop,
                  type: endStops.includes(stop)
                    ? 'end'
                    : intersectStops.includes(stop)
                      ? 'intersect'
                      : null,
                  left,
                },
                geometry: {
                  type: 'Point',
                  coordinates: stopsData[stop].coordinates,
                },
              };
            }),
          });

          // Show routes
          requestAnimationFrame(() => {
            map.getSource('routes-path').setData({
              type: 'FeatureCollection',
              features: serviceGeometries.map((sg) => ({
                type: 'Feature',
                id: encode(sg.service),
                properties: {
                  service: sg.service,
                },
                geometry: sg.geometry,
              })),
            });
            STORE.routesPathServices = serviceGeometries.map(
              (sg) => sg.service,
            );
          });
        }

        break;
      }
      case 'stop': {
        const stop = findStopKey(route.value);
        if (!stop) return;

        stopMetrics(route.city, stop, 'main');

        // Reset
        setExpandSearch(false);
        setShrinkSearch(true);
        resetSearch();

        const { routes, name, coordinates } = stopsData[stop];
        if (route.subpage === 'routes') {
          setHead({
            title: ['stop.titleRoutes', { stopNumber: stop, stopName: name }],
            url: `/stops/${stop}/routes`,
          });

          // Hide all stops
          map.setLayoutProperty('stops', 'visibility', 'none');
          if (map.getLayer('stops-icon')) {
            map.setLayoutProperty('stops-icon', 'visibility', 'none');
          }

          map.getSource('stops-highlight').setData({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                id: encode(stop),
                properties: {
                  name,
                  number: stop,
                  type: 'end',
                  left: stopsData[stop].left,
                },
                geometry: {
                  type: 'Point',
                  coordinates,
                },
              },
            ],
          });

          // Show all routes (cropped from current stop)
          // Find the polyline that passes through the current stop for each service
          const STOP_PROXIMITY_THRESHOLD = 0.0045; // ~500m, same as arrival.js
          requestAnimationFrame(() => {
            const stopCoords = coordinates; // Current stop coordinates [lng, lat]

            // Group routes by service to find the best polyline per service
            const serviceRouteKeys = {};
            routes.forEach((route) => {
              const service = route.split('|')[0];
              if (!serviceRouteKeys[service]) {
                serviceRouteKeys[service] = [];
              }
              serviceRouteKeys[service].push(route);
            });

            const serviceGeometries = Object.entries(serviceRouteKeys)
              .map(([service, routeKeys]) => {
                const serviceRoutes = routesData[service];
                if (
                  !Array.isArray(serviceRoutes) ||
                  serviceRoutes.length === 0
                ) {
                  return null;
                }

                // Find the polyline that passes closest to the current stop
                let bestPolyline = null;
                let bestClosest = null;

                for (let i = 0; i < serviceRoutes.length; i++) {
                  try {
                    const geometry = decodePolyline(serviceRoutes[i]);
                    if (
                      geometry.type !== 'LineString' ||
                      !geometry.coordinates?.length
                    )
                      continue;

                    const closest = findClosestPointOnPolyline(
                      stopCoords,
                      geometry.coordinates,
                    );

                    // Only consider polylines that pass near the stop
                    if (closest.distance < STOP_PROXIMITY_THRESHOLD) {
                      if (
                        !bestClosest ||
                        closest.distance < bestClosest.distance
                      ) {
                        bestClosest = closest;
                        bestPolyline = geometry;
                      }
                    }
                  } catch (e) {
                    // Skip invalid polyline
                  }
                }

                if (!bestPolyline || !bestClosest) {
                  return null;
                }

                // Crop polyline from the current stop
                if (bestClosest.point && bestClosest.segmentIndex >= 0) {
                  const croppedCoords = cropPolylineFromPoint(
                    bestPolyline.coordinates,
                    bestClosest.point,
                    bestClosest.segmentIndex,
                  );
                  if (croppedCoords.length >= 2) {
                    return {
                      service,
                      geometry: {
                        type: 'LineString',
                        coordinates: croppedCoords,
                      },
                    };
                  }
                }

                return {
                  service,
                  geometry: bestPolyline,
                };
              })
              .filter(Boolean);

            map.getSource('routes-path').setData({
              type: 'FeatureCollection',
              features: serviceGeometries.map((sg, i) => ({
                type: 'Feature',
                id: encode(sg.service),
                properties: {
                  service: sg.service,
                },
                geometry: sg.geometry,
              })),
            });
            STORE.routesPathServices = serviceGeometries.map(
              (sg) => sg.service,
            );

            // Fit map to rendered route bounds
            const bounds = new maplibregl.LngLatBounds();
            serviceGeometries.forEach((sg) => {
              sg.geometry.coordinates.forEach((coord) => {
                bounds.extend(coord);
              });
            });
            if (!bounds.isEmpty()) {
              map.fitBounds(bounds, {
                padding: largerScreen
                  ? {
                      top: floatPill.current.offsetHeight / 2,
                      right: 80,
                      bottom: 80,
                      left: floatPill.current.offsetHeight / 2,
                    }
                  : BREAKPOINT()
                    ? {
                        top: 80,
                        right: Math.max(floatPill.current.offsetWidth / 2, 80),
                        bottom: 60 + 20 + floatPill.current.offsetHeight / 2,
                        left: Math.max(floatPill.current.offsetWidth / 2, 80),
                      }
                    : {
                        top: 80,
                        right: 80,
                        bottom: 60 + 20 + floatPill.current.offsetHeight, // height of search bar + float pill
                        left: 80,
                      },
              });
            }
          });
        } else {
          setHead({
            title: ['stop.title', { stopNumber: stop, stopName: name }],
            url: `/stops/${stop}`,
          });
          map.setLayoutProperty('stops', 'visibility', 'visible');
          if (map.getLayer('stops-icon')) {
            map.setLayoutProperty('stops-icon', 'visibility', 'visible');
          }
          _showStopPopover(stop);
        }
        break;
      }
      case 'between': {
        if (!isAlphaEnabled()) {
          navigateTo('/', route);
          return;
        }
        const parsedEndpoints = parseBetweenValue(route.value);
        if (!parsedEndpoints) {
          alert('Invalid directions link.');
          return;
        }
        const [startEndpoint, endEndpoint] = parsedEndpoints;

        setHead({
          title: `Directions - ${t('app.name')}`,
          url: `/between/${route.value}`,
        });
        // Reset
        setExpandSearch(false);
        setShrinkSearch(true);

        // Hide stops only once a specific itinerary is selected (route.subpage
        // present) — the result list view keeps stops visible. Dim basemap
        // either way.
        {
          const visibility = route.subpage ? 'none' : 'visible';
          map.setLayoutProperty('stops', 'visibility', visibility);
          if (map.getLayer('stops-icon')) {
            map.setLayoutProperty('stops-icon', 'visibility', visibility);
          }
        }
        if (map.getLayer('dim-overlay')) {
          map.setPaintProperty('dim-overlay', 'fill-opacity', isDark ? 0.5 : 0.4);
        }

        // Navigating back to the result list (subpage dropped, e.g. closing the
        // detail view) leaves no itinerary selected — clear the previously
        // drawn detail line/highlight so it doesn't linger on the map.
        if (!route.subpage) {
          map.getSource('stops-highlight')?.setData({ type: 'FeatureCollection', features: [] });
          map.getSource('routes-between')?.setData({ type: 'FeatureCollection', features: [] });
        }

        // Fetch arrivals for start stop and filter routes — skipped if this is
        // the same query as last time (e.g. navigating list ↔ result detail,
        // which only changes route.subpage) so the worker/live-arrival fetch
        // doesn't rerun on every such navigation.
        const betweenQueryKey = `${city}|${route.value}`;
        if (lastBetweenQuery.current === betweenQueryKey) {
          break;
        }
        lastBetweenQuery.current = betweenQueryKey;
        (async () => {
          // Resolve each endpoint to a concrete stop number, plus (for a
          // location endpoint) its full nearby-stop candidate cluster —
          // same cluster the location popover itself would show.
          const resolveEndpoint = async (endpoint) => {
            if (endpoint.type === 'stop') {
              const number = findStopKey(endpoint.number);
              return number ? { number, candidateNumbers: null, location: null } : null;
            }
            const stops = await resolveLocationStops(endpoint.lat, endpoint.lon);
            return stops.length
              ? {
                  number: stops[0].number,
                  candidateNumbers: stops.map((s) => s.number),
                  location: { lat: endpoint.lat, lon: endpoint.lon, name: friendlyLocationName(endpoint.lat, endpoint.lon) },
                }
              : null;
          };
          const [startResolved, endResolved] = await Promise.all([
            resolveEndpoint(startEndpoint),
            resolveEndpoint(endEndpoint),
          ]);
          if (betweenQueryKey !== lastBetweenQuery.current) return; // a newer query has started
          if (!startResolved || !endResolved) {
            alert('One of the stops/locations could not be found nearby.');
            return;
          }
          const startStopNumber = startResolved.number;
          const endStopNumber = endResolved.number;

          const cityConfig = getConfigForCity(city);
          const ONE_HOUR_MS = 60 * 60 * 1000;
          let availableServices = new Set();
          let arrivalData = null; // Store full arrival data for scoring
          const staticFrequency = {}; // service_no → daily trip_count from schedule

          // Helper function to extract services from arrivals data
          const extractServicesFromArrivals = (services) => {
            if (!services || !Array.isArray(services)) return new Set();
            const serviceSet = new Set();
            services.forEach((service) => {
              // Check all available arrivals (next, next2, next3, or arrivals array)
              const arrivals =
                service.arrivals ||
                [service.next, service.next2, service.next3, service.next4, service.next5].filter(Boolean);

              // Check if any arrival is within the next hour
              const hasArrivalInNextHour = arrivals.some(
                (arrival) =>
                  arrival &&
                  typeof arrival.duration_ms === 'number' &&
                  arrival.duration_ms >= 0 &&
                  arrival.duration_ms <= ONE_HOUR_MS,
              );

              if (hasArrivalInNextHour) {
                serviceSet.add(String(service.no));
              }
            });
            return serviceSet;
          };

          // Helper to convert schedule to arrival format
          const convertScheduleToArrival = (scheduleData) => {
            if (!scheduleData?.services) return [];
            const now = new Date();
            const currentMinutes = now.getHours() * 60 + now.getMinutes();
            const ONE_HOUR_MS = 60 * 60 * 1000;

            const allUpcomingTrips = [];
            scheduleData.services.forEach((service) => {
              const { no, origin, destination, trips } = service;
              if (!trips || !Array.isArray(trips)) return;

              trips.forEach((timeStr) => {
                const colonIdx = timeStr.indexOf(':');
                if (colonIdx === -1) return;
                const hours = parseInt(timeStr.substring(0, colonIdx), 10);
                const minutes = parseInt(timeStr.substring(colonIdx + 1), 10);
                const tripMinutes = hours * 60 + minutes;
                const duration_ms = (tripMinutes - currentMinutes) * 60 * 1000;
                if (duration_ms >= 0 && duration_ms <= ONE_HOUR_MS) {
                  allUpcomingTrips.push({
                    no,
                    origin,
                    destination,
                    duration_ms,
                    type: 'SD',
                    load: 'SEA',
                    feature: 'WAB',
                    visit_number: 1,
                    origin_code: origin,
                    destination_code: destination,
                  });
                }
              });
            });

            // Sort by arrival time and group by service
            allUpcomingTrips.sort((a, b) => a.duration_ms - b.duration_ms);
            const serviceMap = new Map();

            allUpcomingTrips.forEach((trip) => {
              const key = `${trip.no}-${trip.destination}`;
              if (!serviceMap.has(key)) {
                serviceMap.set(key, {
                  no: trip.no,
                  destination: trip.destination,
                  frequency: 0,
                  trips: [],
                });
              }
              const service = serviceMap.get(key);
              service.trips.push(trip);
              service.frequency++;
            });

            // Convert to arrival format (next through next5)
            return Array.from(serviceMap.values()).map((service) => {
              const result = {
                no: service.no,
                destination: service.destination,
                frequency: service.frequency,
              };
              if (service.trips.length > 0) result.next = service.trips[0];
              if (service.trips.length > 1) result.next2 = service.trips[1];
              if (service.trips.length > 2) result.next3 = service.trips[2];
              if (service.trips.length > 3) result.next4 = service.trips[3];
              if (service.trips.length > 4) result.next5 = service.trips[4];
              return result;
            });
          };

          // Try to fetch live arrivals
          let liveApiFailed = false;
          if (cityConfig?.liveArrivals?.enabled) {
            try {
              const apiUrl = getApiUrl(cityConfig.liveArrivals.apiPath);
              if (apiUrl) {
                const response = await fetch(
                  `${apiUrl}?stationid=${startStopNumber}`,
                );
                if (response.ok) {
                  const data = await response.json();
                  if (data?.services?.length > 0) {
                    const filtered = data.services
                      .map(filterStaleArrivalsFromService)
                      .filter(
                        (s) => s.next || (s.arrivals && s.arrivals.length > 0),
                      );
                    arrivalData =
                      filtered.length > 0 ? filtered : data.services;
                    availableServices =
                      extractServicesFromArrivals(arrivalData);
                  }
                } else {
                  // API returned error status - this is a failure case
                  liveApiFailed = true;
                }
              } else {
                // API disabled (e.g. developer mode) - fall back to schedule
                liveApiFailed = true;
              }
            } catch (error) {
              // API request failed - this is a failure case
              liveApiFailed = true;
            }
          }

          // Fallback to schedule only when live API could not be reached
          // (network error, HTTP error, or city has no live arrivals configured).
          // A successful but empty live response is valid — don't override it.
          if (liveApiFailed || !cityConfig?.liveArrivals?.enabled) {
            try {
              const scheduleData = await fetchCache(
                `https://data.transitrouter.vonter.in/${city}/schedule/${startStopNumber}.json`,
                60,
              );
              if (scheduleData?.services) {
                const now = new Date();
                const currentMinutes =
                  now.getHours() * 60 + now.getMinutes();

                scheduleData.services.forEach((service) => {
                  const { no, trips, trip_count } = service;

                  if (trip_count > 0) {
                    staticFrequency[String(no)] =
                      (staticFrequency[String(no)] || 0) + trip_count;
                  }

                  if (!trips || !Array.isArray(trips)) return;

                  const hasTripInNextHour = trips.some((timeStr) => {
                    const colonIdx = timeStr.indexOf(':');
                    if (colonIdx === -1) return false;
                    const hours = parseInt(
                      timeStr.substring(0, colonIdx),
                      10,
                    );
                    const minutes = parseInt(
                      timeStr.substring(colonIdx + 1),
                      10,
                    );
                    const tripMinutes = hours * 60 + minutes;
                    const duration_ms =
                      (tripMinutes - currentMinutes) * 60 * 1000;
                    return duration_ms >= 0 && duration_ms <= ONE_HOUR_MS;
                  });

                  if (hasTripInNextHour) {
                    availableServices.add(String(no));
                  }
                });

                arrivalData = convertScheduleToArrival(scheduleData);
              }
            } catch (error) {
              console.log('Schedule fetch failed:', error);
            }
          }

          // Route-finding (proximity expansion + intersection) runs in the worker.
          // A location endpoint's own candidate cluster replaces the worker's
          // usual single-stop proximity expansion for that side (see
          // handleBetweenRoutes) — the plain stop number is omitted so the
          // worker doesn't also treat it as "the" literal picked stop for
          // the live-arrival service filter.
          const {
            routes: allRoutes,
            nearestStartStop,
            nearestEndStop,
          } = await workerBetweenRoutes(
            startResolved.candidateNumbers ? undefined : startStopNumber,
            endResolved.candidateNumbers ? undefined : endStopNumber,
            Array.from(availableServices),
            {
              startCandidateNumbers: startResolved.candidateNumbers || undefined,
              endCandidateNumbers: endResolved.candidateNumbers || undefined,
            },
          );

          const startStop = stopsData[startStopNumber];
          const endStop = stopsData[endStopNumber];

          _showBetweenPopover({
            startStop,
            endStop,
            startLocation: startResolved.location,
            endLocation: endResolved.location,
            nearestStartStop,
            nearestEndStop,
            startWalkMins: nearestStartStop
              ? getWalkingMinutes(
                  ruler.distance(startStop.coordinates, nearestStartStop.coordinates) * 1000,
                )
              : 0,
            endWalkMins: nearestEndStop
              ? getWalkingMinutes(
                  ruler.distance(endStop.coordinates, nearestEndStop.coordinates) * 1000,
                )
              : 0,
            arrivalData, // Pass arrival data for scoring
            staticFrequency, // Daily trip counts from schedule
            liveApiFailed, // Track if live API fetch failed
            results: allRoutes, // Single unified array
          });
        })();

        break;
      }
      case 'location': {
        if (!isAlphaEnabled()) {
          navigateTo('/', route);
          return;
        }
        const raw = route.value || '';
        const [rawLat, rawLon] = raw.split(',');
        const lat = parseFloat(rawLat);
        const lon = parseFloat(rawLon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          navigateTo('/', route);
          return;
        }

        setExpandSearch(false);
        setShrinkSearch(true);
        // Name resolution is never part of the URL — resolve in priority order:
        // a just-clicked search result's cached name, a nearby known POI, or
        // (async, once the popover is already open) a reverse-geocode lookup.
        const key = locationKey(lat, lon);
        const cached = locationNameCache.get(key) || findMatchingPoi(lat, lon);
        const locInfo = {
          lat, lon,
          name: cached?.name || null,
          type: cached?.type || null,
          color: cached?.color || null,
        };
        if (cached && !locationNameCache.has(key)) locationNameCache.set(key, cached);

        setHead({
          title: `${locInfo.name || 'Location'} - ${t('app.name')}`,
          url: `/locations/${raw}`,
        });
        // Unlike 'stop'/'between'/default, this case never turned the stops
        // layer back on — arriving here straight from a service view (which
        // hides it) or a direct link (whatever the style's initial layout
        // visibility is) left it off with nothing to turn it back on.
        map.setLayoutProperty('stops', 'visibility', 'visible');
        if (map.getLayer('stops-icon')) {
          map.setLayoutProperty('stops-icon', 'visibility', 'visible');
        }
        _showLocationPopover(locInfo);
        break;
      }
      default: {
        setHead(defaultHead);

        // Show all stops
        map.setLayoutProperty('stops', 'visibility', 'visible');
        map.setLayoutProperty('stops-icon', 'visibility', 'visible');
      }
    }

    setRouteLoading(false);
  };

  const setStartStop = (number) => {
    if (betweenEndStop && betweenEndStop != number) {
      navigateTo(`/between/${number}-${betweenEndStop}`, route);
    } else {
      setBetweenStartStop(number);
      setBetweenEndStop(null);
    }
  };

  const setEndStop = (number) => {
    if (betweenStartStop && betweenStartStop != number) {
      location.hash = `${route.cityPrefix}/between/${betweenStartStop}-${number}`;
    } else {
      setBetweenStartStop(null);
      setBetweenEndStop(number);
    }
  };

  const resetStartEndStops = () => {
    setBetweenStartStop(null);
    setBetweenEndStop(null);
  };

  const [mapLoaded, setMapLoaded] = useState(false);
  let workerReady = Promise.resolve();
  const onLoad = async () => {
    window.onhashchange = () => {
      setRoute(getRoute());
      renderRoute();
    };

    if (!IS_ALL_MODE) {
      const fetchStopsP = fetchCache(stopsJSONPath, CACHE_TIME);
      const fetchServicesP = fetchCache(servicesJSONPath, CACHE_TIME);
      const fetchRoutesP = fetchCache(routesJSONPath, CACHE_TIME);
      const fetchPoisP = isAlphaEnabled() ? fetchPois(city) : Promise.resolve([]);

      // Init data

      const stops = await fetchStopsP;
      // First pass: collect all stops with their parentStopID
      const stopsByParent = {};
      Object.keys(stops).forEach((number) => {
        const stop = stops[number];
        const [lng, lat, name, suffix = '', parentStopID = ''] = stop;
        if (parentStopID) {
          if (!stopsByParent[parentStopID]) {
            stopsByParent[parentStopID] = [];
          }
          stopsByParent[parentStopID].push({ number, lng, lat });
        }
      });

      // Second pass: process stops and calculate left based on parentStopID
      Object.keys(stops).forEach((number) => {
        const stop = stops[number];
        const [lng, lat, name, suffix = '', parentStopID = ''] = stop;
        let left = false;

        // Calculate left based on parentStopID (opposite stops)
        if (parentStopID && stopsByParent[parentStopID]) {
          const oppositeStops = stopsByParent[parentStopID].filter(
            (s) => s.number !== number,
          );
          if (oppositeStops.length > 0) {
            // Use the first opposite stop to calculate bearing
            const oppositeStop = oppositeStops[0];
            const bearing = ruler.bearing(
              [lng, lat],
              [oppositeStop.lng, oppositeStop.lat],
            );
            left = bearing > 0;
          }
        }

        stopsData[number] = {
          name,
          suffix,
          number,
          parentStopID: parentStopID || null,
          interchange:
            /\sint$/i.test(name) && !/^(bef|aft|opp|bet)\s/i.test(name),
          coordinates: [lng, lat],
          services: [],
          routes: [],
          left,
        };
        stopsDataArr.push(stopsData[number]);
      });
      stopsDataArr.sort((a, b) => (a.interchange ? 1 : b.interchange ? -1 : 0));

      servicesData = await fetchServicesP;
      Object.keys(servicesData).forEach((number) => {
        const routes = servicesData[number];
        servicesDataArr.push({
          number,
          name: routes.name,
        });

        // routes is now an object with destinations as keys, values are arrays of route variations
        Object.keys(routes).forEach((destination) => {
          if (destination === 'name') return;
          const routeVariations = routes[destination];
          // Process each route variation for this destination
          routeVariations.forEach((route, variantIdx) => {
            route.forEach((stop, stopIdx) => {
              if (stopsData[stop]) {
                // Add service to services array if not already present
                if (!stopsData[stop].services.includes(number)) {
                  stopsData[stop].services.push(number);
                }

                // Store destination-grouped data for this stop
                if (!stopsData[stop].destinationGroups) {
                  stopsData[stop].destinationGroups = {};
                }
                if (!stopsData[stop].destinationGroups[number]) {
                  stopsData[stop].destinationGroups[number] = {};
                }
                if (!stopsData[stop].destinationGroups[number][destination]) {
                  stopsData[stop].destinationGroups[number][destination] = {
                    destination: destination,
                    routes: [],
                    stopCount: 0, // Count stops from this stop to destination
                  };
                }

                // Calculate remaining stops to destination for this route
                const remainingStops = route.length - stopIdx - 1;

                // Store route info with variant index
                const routeKey = number + '|' + destination + '|' + variantIdx;
                if (!stopsData[stop].routes.includes(routeKey)) {
                  stopsData[stop].routes.push(routeKey);
                  stopsData[stop].destinationGroups[number][
                    destination
                  ].routes.push(route);
                  // Track the maximum stop count (in case of multiple route variations)
                  if (
                    remainingStops >
                    stopsData[stop].destinationGroups[number][destination]
                      .stopCount
                  ) {
                    stopsData[stop].destinationGroups[number][
                      destination
                    ].stopCount = remainingStops;
                  }
                }
              }
            });
          });
        });
      });
      servicesDataArr.sort((a, b) => sortServices(a.number, b.number));

      routesData = await fetchRoutesP;

      const rawPois = await fetchPoisP;
      poisData = rawPois.map((poi, id) => ({ ...poi, id }));

      // Build normalized lookup maps for O(1) key lookups
      buildNormalizedLookupMaps();

      // Transfer data to the worker: it builds Fuse indices and handles all
      // future search, closest-stop, and between-routes requests off-thread.
      workerReady = initDataWorker({
        stopsArr: stopsDataArr.map((s) => ({
          number: s.number,
          name: s.name,
          suffix: s.suffix,
          coordinates: s.coordinates,
          routes: s.routes,
        })),
        servicesArr: servicesDataArr.map((s) => ({
          number: s.number,
          name: s.name,
        })),
        servicesData,
        poisArr: poisData,
      });

      setServices(servicesDataArr);

      // Recalculate closest stops if location is already available
      if (currentLocation && stopsDataArr.length > 0) {
        const [lng, lat] = currentLocation;
        workerClosestStops(lng, lat).then(({ stops }) => setClosestStops(stops));
      }

      window._data = {
        servicesData,
        stopsData,
        stopsDataArr,
        routesData,
        servicesDataArr,
      };
    } // end if (!IS_ALL_MODE)

    map = window._map = new maplibregl.Map({
      container: 'map',
      style: mapStyle,
      renderWorldCopies: false,
      boxZoom: false,
      minZoom: 4,
      logoPosition: 'bottom-left',
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: supportsTouch,
      touchPitch: false,
      bounds: [lowerLong, lowerLat, upperLong, upperLat],
      fitBoundsOptions: {
        padding: BREAKPOINT()
          ? 120
          : { top: 40, bottom: window.innerHeight / 2, left: 40, right: 40 },
      },
      // Performance optimizations
      maxTileCacheSize: 100, // Limit tile cache for memory savings (default is unlimited)
      fadeDuration: supportsTouch ? 0 : 300, // Disable fade animations on touch devices for smoother UX
      collectResourceTiming: false, // Disable resource timing collection for better performance
      trackResize: true, // Keep resize tracking but it's optimized internally
      refreshExpiredTiles: false, // Don't auto-refresh expired tiles during session
      crossSourceCollisions: false, // Disable cross-source collision detection for faster rendering
    });

    if (!supportsTouch) {
      map.touchZoomRotate.disableRotation();
    }

    // Controls
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
      }),
      'bottom-right',
    );
    // GeolocateControl - map button on desktop only, search bar button on mobile
    const geolocateControl = new GeolocateControl({
      offset: () => {
        if (BREAKPOINT()) return [0, 0];
        const popover = [stopPopover, servicePopover, betweenPopover]
          .map((p) => p.current)
          .find((p) => p?.classList.contains('expand'));
        return popover ? [0, -popover.offsetHeight / 2] : [0, 0];
      },
      showMapControl: BREAKPOINT(),
      onClick: (location) => handleLocationUpdate(location, geolocateControl),
    });
    map.addControl(geolocateControl, 'top-left');
    geolocateControlRef.current = geolocateControl;
    if (geolocateBtn.current)
      geolocateControl.registerExternalButton(geolocateBtn.current);

    map.addControl(
      new maplibregl.NavigationControl({
        showCompass: true,
        showZoom: false,
      }),
      'bottom-left',
    );
    const compassButton = document.querySelector('.maplibregl-ctrl-compass');
    map.on('rotateend', () => {
      const bearing = map.getBearing();
      compassButton.classList.toggle('show', bearing !== 0);
    });

    let initialMoveStart = false;
    const initialHideSearch = (e) => {
      // Don't collapse search bar if movement is from geolocation
      if (e && e.geolocateSource) return;
      if (initialMoveStart) return;
      initialMoveStart = true;
      $logo.classList.add('fadeout');
      setShrinkSearch(true);
    };
    map.once('dragstart', initialHideSearch);
    map.once('zoomstart', initialHideSearch);

    await new Promise((resolve) => {
      map.once('styledata', () => resolve());
    });

    const loadPng = (name, path) =>
      map.loadImage(path).then((img) => map.addImage(name, img.data));

    const loadSvg = (name, path, size, opts = {}) =>
      new Promise((resolve, reject) => {
        const dpr = window.devicePixelRatio || 1;
        const img = new Image();
        img.onload = () => {
          map.addImage(name, img, {
            pixelRatio: (size / img.naturalWidth) * dpr,
            ...opts,
          });
          resolve();
        };
        img.onerror = reject;
        img.width = img.height = size * dpr;
        img.src = path;
      });

    await Promise.all([
      loadPng('stop', stopImagePath),
      loadPng('stop-end', stopEndImagePath),
      loadPng('stop-active', stopActiveImagePath),
      loadSvg('metro-station', metroStationSdfPath, 60, { sdf: true }),
      loadSvg('rail-station', railStationPath, 60, { sdf: true }),
      loadSvg('monorail-station', monorailStationPath, 60, { sdf: true }),
    ]).catch((e) => {
      console.error('Failed to load map images:', e);
    });

    // Add rail source (not used in all-mode — no single rail.json path)
    if (!IS_ALL_MODE) {
      map.addSource('rail', {
        type: 'geojson',
        data: railJSONPath,
      });
    }

    setMapLoaded(true);
  };

  useEffect(() => {
    onLoad();
  }, []);

  // stop/service/location/between popovers: mobile presentation is owned by their
  // CupertinoPane instances (see mobilePane.js). Each pane is torn down and
  // rebuilt from scratch every time one of these effects runs with its
  // popover shown — see syncMobilePane's comment for why. The dependency
  // arrays deliberately include each popover's *content* identity (not
  // just its show-state boolean): switching directly from one stop/service
  // to another can leave the boolean unchanged across the switch (React
  // only observes its final value for a render, so a reset-then-reopen
  // within the same update never visibly passes through false), and
  // without the content key here that switch wouldn't rebuild the pane at
  // all.
  // paneAppliesHere(supportsTouch, BREAKPOINT) is read at the top of every
  // pane effect below, but a window resize alone doesn't cause Preact to
  // re-render — so crossing the mobile/desktop width threshold (640px)
  // without some *other* unrelated state change happening to fire a
  // render left a pane built for one layout stuck on screen under the
  // other's CSS (wrong side of the screen, wrong width) until something
  // else eventually re-rendered the component. Bumping this on a
  // (debounced) resize forces those effects to re-check and correctly
  // build/tear down as the breakpoint is crossed.
  //
  // Only on an actual crossing: each of those effects rebuilds its pane from
  // scratch, moving the popover's DOM out of the document and back. Bumping on
  // *any* resize let a mere height change destroy every open sheet — the
  // keyboard opening blurred the input it had just opened for, closing it,
  // which resized again; the collapsing URL bar did the same on scroll.
  const [viewportTick, setViewportTick] = useState(0);
  useEffect(() => {
    let lastApplies = paneAppliesHere(supportsTouch, BREAKPOINT);
    const handler = rafThrottle(() => {
      const applies = paneAppliesHere(supportsTouch, BREAKPOINT);
      if (applies === lastApplies) return;
      lastApplies = applies;
      setViewportTick((t) => t + 1);
    });
    window.addEventListener('resize', handler);
    return () => {
      handler.cancel();
      window.removeEventListener('resize', handler);
    };
  }, []);

  // Whether each popover's pane is currently resting at its "bottom" peek
  // break (handle+header only — see computeBreaks in mobilePane.js). Drives
  // hiding the floating footer, which lives outside the pane's own clipped
  // content and so isn't hidden automatically the way the scrollable body
  // is. Reset to false on every fresh open below (buildPane always starts
  // at 'middle').
  const [stopPaneAtBottom, setStopPaneAtBottom] = useState(false);
  const [servicePaneAtBottom, setServicePaneAtBottom] = useState(false);
  const [locationPaneAtBottom, setLocationPaneAtBottom] = useState(false);
  const [betweenPaneAtBottom, setBetweenPaneAtBottom] = useState(false);

  const stopPopoverKey = stopPopoverData
    ? `${stopPopoverData.city || ''}^${stopPopoverData.number}`
    : null;
  useEffect(() => {
    if (!paneAppliesHere(supportsTouch, BREAKPOINT)) {
      // A resize just crossed from mobile into desktop width — tear the pane
      // down and release the element, so neither the stale cupertino wrapper
      // nor its leftover inline styles fight the desktop CSS layout.
      syncMobilePane(stopPane, stopPopover.current, false, { release: true });
      setStopPaneAtBottom(false);
      return;
    }
    setStopPaneAtBottom(false);
    syncMobilePane(stopPane, stopPopover.current, showStopPopover, {
      onDismiss: () => hideStopPopover(),
      paneOptions: {
        onBreakChange: (b) => setStopPaneAtBottom(b === 'bottom'),
      },
    });
    if (showStopPopover) {
      const cleanupContent = watchMobilePaneContent(stopPane, stopPopover.current);
      const cleanupResize = watchMobilePaneResize(stopPane, stopPopover.current);
      return () => {
        cleanupContent();
        cleanupResize();
      };
    }
  }, [showStopPopover, stopPopoverKey, viewportTick]);

  const servicePopoverKey = routeServices?.join(',') || null;
  useEffect(() => {
    if (!paneAppliesHere(supportsTouch, BREAKPOINT)) {
      syncMobilePane(servicePane, servicePopover.current, false, { release: true });
      setServicePaneAtBottom(false);
      return;
    }
    // stop-popover can open on top of an already-open service-popover (e.g.
    // tapping a stop highlighted on the currently-viewed service's route —
    // see the `feature.source == 'stops'` check a few hundred lines down).
    // Only one sheet is ever shown at a time: service is torn down while
    // stop is on top, and rebuilt here once showStopPopover goes false
    // (while showServicePopover is still true) — which is what makes
    // dismissing stop "go back" to service.
    const shouldShow = showServicePopover && !showStopPopover;
    setServicePaneAtBottom(false);
    syncMobilePane(servicePane, servicePopover.current, shouldShow, {
      // Navigate away (not just flip the boolean) so the map's own service
      // view — hidden stops layer, highlighted route, routes-path/
      // buses-service sources — gets torn down the same way it would from
      // any other route change. Directly setting the state here skipped
      // all of that, since a drag-dismiss doesn't go through renderRoute.
      onDismiss: () => navigateTo('/', route),
      paneOptions: {
        onBreakChange: (b) => setServicePaneAtBottom(b === 'bottom'),
      },
    });
    if (shouldShow) {
      const cleanupContent = watchMobilePaneContent(servicePane, servicePopover.current);
      const cleanupResize = watchMobilePaneResize(servicePane, servicePopover.current);
      return () => {
        cleanupContent();
        cleanupResize();
      };
    }
  }, [showServicePopover, showStopPopover, servicePopoverKey, viewportTick]);

  const locationPopoverKey = locationPopoverData
    ? `${locationPopoverData.lat},${locationPopoverData.lon}`
    : null;
  useEffect(() => {
    if (!paneAppliesHere(supportsTouch, BREAKPOINT)) {
      syncMobilePane(locationPane, locationPopover.current, false, { release: true });
      setLocationPaneAtBottom(false);
      return;
    }
    setLocationPaneAtBottom(false);
    syncMobilePane(locationPane, locationPopover.current, showLocationPopover, {
      onDismiss: () => hideLocationPopover(),
      paneOptions: {
        onBreakChange: (b) => setLocationPaneAtBottom(b === 'bottom'),
      },
    });
    if (showLocationPopover) {
      const cleanupContent = watchMobilePaneContent(locationPane, locationPopover.current);
      const cleanupResize = watchMobilePaneResize(locationPane, locationPopover.current);
      return () => {
        cleanupContent();
        cleanupResize();
      };
    }
  }, [showLocationPopover, locationPopoverKey, viewportTick]);

  const betweenShown = IS_ALL_MODE ? !!allModeBetween : showBetweenPopover;
  const betweenPopoverKey = `${route.value || ''}|${route.subpage || ''}`;
  useEffect(() => {
    if (!paneAppliesHere(supportsTouch, BREAKPOINT)) {
      syncMobilePane(betweenPane, betweenPopover.current, false, { release: true });
      setBetweenPaneAtBottom(false);
      return;
    }
    setBetweenPaneAtBottom(false);
    syncMobilePane(betweenPane, betweenPopover.current, betweenShown, {
      // The popover's own close (×) is an <a href="#.../"> — navigating
      // away is what actually hides it; setAllModeBetween(null)/
      // resetStartEndStops() are only supplementary cleanup it does
      // alongside that navigation, not the dismiss mechanism itself.
      onDismiss: () => {
        if (route.subpage) {
          // Dismissing a specific itinerary detail (route.subpage set —
          // e.g. /between/<query>/1) should land back on the results list
          // for the same query, same as the detail view's own in-page
          // back link (betweenListHref) — not skip past it to home.
          // route.cityPrefix is already `/all` in all-mode, so this
          // produces the right URL either way without an IS_ALL_MODE branch.
          navigateTo(`/between/${route.value}`, route);
        } else {
          navigateTo('/', route);
          if (IS_ALL_MODE) setAllModeBetween(null);
          else resetStartEndStops();
        }
      },
      paneOptions: {
        onBreakChange: (b) => setBetweenPaneAtBottom(b === 'bottom'),
      },
    });
    if (betweenShown) {
      const cleanupContent = watchMobilePaneContent(betweenPane, betweenPopover.current);
      const cleanupResize = watchMobilePaneResize(betweenPane, betweenPopover.current);
      return () => {
        cleanupContent();
        cleanupResize();
      };
    }
  }, [betweenShown, betweenPopoverKey, viewportTick]);

  // Shared "is anything else up" signal — used below to show/hide search,
  // and by the map-tap handler further down to decide dismiss vs. collapse.
  // Deliberately not shrinkSearch: that's set on every popover open but
  // only ever reset back to false from a couple of directions-specific
  // spots, not on a plain "close and return home" — it can stay stuck
  // true long after every popover is actually gone.
  const anyPopoverOpen = showStopPopover || betweenShown || showServicePopover || showLocationPopover;

  // search-popover: unlike the other four, it isn't a distinct "session"
  // with its own content identity — it's the app's default/home surface,
  // present whenever nothing else is and torn down the instant something
  // else takes over. No content-key dependency needed here for the same
  // reason. It also has no .popover-handle and no drag-to-dismiss — its
  // break is driven entirely by handleSearchFocus/handleSearchClose, the
  // keyboard-height effect, and the map-tap handler below, all via
  // movePaneToBreak().
  useEffect(() => {
    if (!paneAppliesHere(supportsTouch, BREAKPOINT)) {
      syncMobilePane(searchPane, searchPopover.current, false, { release: true });
      return;
    }
    syncMobilePane(searchPane, searchPopover.current, !anyPopoverOpen, {
      paneOptions: {
        dragHandleSelector: null,
        computeBreaksFn: computeSearchBreaks,
        bottomClose: false,
        fastSwipeClose: false,
      },
    });
    if (!anyPopoverOpen) return watchMobilePaneResize(searchPane, searchPopover.current);
  }, [anyPopoverOpen, viewportTick]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let lastKh = -1;
    const update = () => {
      const kh = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // Only write when it actually changes so iOS toolbar-collapse scrolls
      // don't churn the custom property and trigger transform repaints.
      if (kh === lastKh) return;
      const wasOpen = lastKh > 0;
      lastKh = kh;
      document.documentElement.style.setProperty(
        '--keyboard-height',
        `${kh}px`,
      );
      // The on-screen keyboard just went away (mobile "back" while it's up
      // does this before it ever touches history/hash) — search should
      // settle back to its default half-screen resting position rather
      // than staying expanded to fit a keyboard that's no longer there.
      if (wasOpen && kh === 0) {
        movePaneToBreak(searchPane, 'middle');
      }
    };
    vv.addEventListener('resize', update);
    return () => {
      vv.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    if (!mapLoaded) return;
    const mapCanvas = map.getCanvas();

    map.addSource('stops', {
      type: 'geojson',
      tolerance: 10,
      data: {
        type: 'FeatureCollection',
        features: createFeaturesOptimized(stopsDataArr, (stop) => ({
          type: 'Feature',
          id: encode(stop.number),
          properties: {
            number: stop.number,
            name: stop.name,
            interchange: stop.interchange,
            left: stop.left,
            suffix: stop.suffix,
          },
          geometry: {
            type: 'Point',
            coordinates: stop.coordinates,
          },
        })),
      },
    });

    // Check if stop IDs should be disabled for this city
    const cityConfig = getConfigForCity(route.city);
    const disableStopID = cityConfig?.disableStopID || false;

    let stopTextPartialFormat, stopTextFullFormat;
    if (disableStopID) {
      stopTextPartialFormat = ['get', 'name'];
      stopTextFullFormat = [
        'format',
        ['get', 'name'],
        {},
        [
          'case',
          ['!=', ['get', 'suffix'], null],
          ['concat', '\n', ['get', 'suffix']],
          '',
        ],
        { 'font-scale': 0.8, 'text-color': C.text },
      ];
    } else {
      stopTextPartialFormat = ['get', 'number'];
      stopTextFullFormat = [
        'format',
        ['get', 'number'],
        { 'font-scale': 0.8 },
        '\n',
        {},
        ['get', 'name'],
        { 'text-color': C.text },
      ];
    }

    const stopText = {
      layout: {
        'text-optional': true,
        'text-field': [
          'step',
          ['zoom'],
          '',
          15,
          stopTextPartialFormat,
          16,
          stopTextFullFormat,
        ],
        'text-size': ['step', ['zoom'], 12, 16, 14],
        'text-justify': [
          'case',
          ['boolean', ['get', 'left'], false],
          'right',
          'left',
        ],
        'text-anchor': [
          'case',
          ['boolean', ['get', 'left'], false],
          'right',
          'left',
        ],
        'text-offset': [
          'case',
          ['boolean', ['get', 'left'], false],
          ['literal', [-1, 0]],
          ['literal', [1, 0]],
        ],
        // 'text-justify': 'auto',
        // 'text-variable-anchor': ['left', 'right'],
        // 'text-radial-offset': 1,
        'text-padding': 0.5,
        // 'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
        'text-font': ['Noto Sans Regular'],
        'text-max-width': 16,
        'text-line-height': 1.1,
      },
      paint: {
        'text-color': C.stopRed,
        'text-halo-width': 1,
        'text-halo-color': C.textHalo,
      },
    };

    map.addLayer({
      id: 'stops',
      type: 'circle',
      source: 'stops',
      layout: {
        visibility: 'none',
      },
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          10,
          ['case', ['boolean', ['feature-state', 'selected'], false], 4, 1],
          14,
          4,
          15,
          ['case', ['boolean', ['feature-state', 'selected'], false], 12, 6],
        ],
        'circle-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          C.stopCircleBg,
          C.stopRed,
        ],
        'circle-stroke-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          C.stopRed,
          C.stopCircleBg,
        ],
        'circle-stroke-width': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          5,
          1,
        ],
        'circle-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          10,
          1,
          13.9,
          1,
          14,
          0.5,
        ],
        'circle-stroke-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          10,
          ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
          13.5,
          1,
          14,
          0.5,
        ],
      },
    });

    map.addLayer({
      id: 'stops-icon',
      type: 'symbol',
      source: 'stops',
      filter: ['any', ['>=', ['zoom'], 14], ['get', 'interchange']],
      layout: {
        visibility: 'none',
        // 'symbol-z-order': 'source',
        'icon-image': 'stop',
        'icon-size': ['step', ['zoom'], 0.4, 15, 0.5, 16, 0.6],
        // 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.4, 16, 0.6],
        'icon-padding': 0.5,
        'icon-allow-overlap': true,
        // 'icon-ignore-placement': true,
        ...stopText.layout,
      },
      paint: {
        'icon-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          8,
          ['case', ['get', 'interchange'], 1, 0],
          14,
          1,
        ],
        ...stopText.paint,
      },
    });

    // Rail layer specs
    const railLineFilter = ['all', ['==', ['geometry-type'], 'LineString'], ['has', 'stroke']];
    const railLineLayout = { 'line-join': 'round', 'line-cap': 'round' };
    const railInterchangeFilter = ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'interchange'], true]];
    const railStationsFilter = ['all', ['==', ['geometry-type'], 'Point'], ['has', 'name'], ['!=', ['get', 'interchange'], true]];

    const railInterchangeLayout = {
      'icon-image': ['match', ['get', 'mode'], 'metro', 'metro-station', 'monorail', 'monorail-station', 'rail-station'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.45, 22, 0.75],
      'icon-allow-overlap': true,
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 22, 16],
      'text-variable-anchor': ['left', 'right', 'top'],
      'text-radial-offset': 1.1,
      'text-optional': true,
    };
    const railInterchangePaint = {
      'icon-color': C.text,
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0, 10, 1],
      ...(isDark && { 'icon-halo-color': '#000', 'icon-halo-width': 0.5, 'icon-halo-blur': 1 }),
      'text-color': C.text,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0, 10, 1],
      'text-halo-color': C.textHalo,
      'text-halo-width': C.stationHaloWidth,
    };
    const railStationsLayout = {
      'icon-image': ['match', ['get', 'mode'], 'metro', 'metro-station', 'monorail', 'monorail-station', 'rail-station'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 22, 0.5],
      'icon-allow-overlap': false,
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 22, 16],
      'text-variable-anchor': ['left', 'right', 'top'],
      'text-radial-offset': 1.1,
      'text-optional': true,
    };
    const railStationsPaint = {
      'icon-color': stationIconColor,
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 11, 1],
      ...(isDark && { 'icon-halo-color': '#000', 'icon-halo-width': 0.5, 'icon-halo-blur': 1 }),
      'text-color': stationTextColor,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 11, 1],
      'text-halo-color': C.textHalo,
      'text-halo-width': C.stationHaloWidth,
    };

    // Rail layers — single-city mode only (all-mode loads rail per city in loadCity)
    // Everything here — line paths and station icons alike — stays below the
    // 'stops' layer, so a rail/metro station never visually covers a bus stop
    // marker at the same physical hub.
    if (!IS_ALL_MODE) {
      map.addLayer({
        id: 'rail-path',
        type: 'line',
        source: 'rail',
        filter: railLineFilter,
        minzoom: 8,
        layout: railLineLayout,
        paint: {
          'line-color': ['get', 'stroke'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 4, 22, 6],
          // Fade metro lines down as the map zooms past the subway-entrance
          // threshold (z15) so other features become easier to read
          'line-opacity': ['interpolate', ['linear'], ['zoom'],
            15, ['match', ['get', 'mode'], 'monorail', 1, 'rail', 0.01, C.routeLineOpacity],
            18, ['match', ['get', 'mode'], 'monorail', 1, 'rail', 0.01, C.routeLineOpacity * 0.45],
          ],
        },
      }, 'stops');
      map.addLayer({
        id: 'rail-path-dots',
        type: 'line',
        source: 'rail',
        filter: ['all', ...railLineFilter.slice(1), ['==', ['get', 'mode'], 'rail']],
        minzoom: 8,
        layout: { ...railLineLayout, 'line-cap': 'butt' },
        paint: {
          'line-color': ['get', 'stroke'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 3, 22, 4],
          'line-opacity': 1,
          'line-dasharray': [3, 3],
        },
      }, 'stops');
      map.addLayer(
        {
          id: 'rail-path-case',
          type: 'line',
          source: 'rail',
          filter: railLineFilter,
          minzoom: 8,
          layout: railLineLayout,
          paint: {
            'line-color': ['match', ['get', 'mode'], 'metro', C.stopCircleBg, 'monorail', '#FFF', ['get', 'stroke']],
            'line-width': ['interpolate', ['linear'], ['zoom'],
              16, ['match', ['get', 'mode'], 'monorail', 0.85, 'rail', 5, 9],
              22, ['match', ['get', 'mode'], 'monorail', 12, 'rail', 7, 12],
            ],
            'line-opacity': ['interpolate', ['linear'], ['zoom'],
              15, ['match', ['get', 'mode'], 'monorail', 0.5, 'rail', 0.75, 0.5],
              18, ['match', ['get', 'mode'], 'monorail', 0.5, 'rail', 0.75, 0.15],
            ],
          },
        },
        'rail-path',
      );
      map.addLayer({
        id: 'rail-stations',
        type: 'symbol',
        source: 'rail',
        filter: railStationsFilter,
        minzoom: 10,
        layout: railStationsLayout,
        paint: railStationsPaint,
      }, 'stops');
      map.addLayer({
        id: 'rail-stations-interchange',
        type: 'symbol',
        source: 'rail',
        filter: railInterchangeFilter,
        minzoom: 9,
        layout: railInterchangeLayout,
        paint: railInterchangePaint,
      }, 'stops');
    } // end if (!IS_ALL_MODE) for rail layers

    // Create stops-highlight source and layers BEFORE setting up event handlers
    // that query this layer to avoid "layer does not exist" errors
    map.addSource('stops-highlight', {
      type: 'geojson',
      tolerance: 10,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
    map.addLayer({
      id: 'stops-highlight-circle',
      type: 'circle',
      source: 'stops-highlight',
      minzoom: 4,
      maxzoom: 14,
      filter: [
        'all',
        ['!=', ['get', 'type'], 'end'],
        ['!=', ['get', 'type'], 'intersect'],
      ],
      paint: {
        'circle-radius': ['step', ['zoom'], 2, 12, 3],
        'circle-color': C.stopCircleBg,
        'circle-stroke-color': C.stopRed,
        'circle-stroke-width': ['step', ['zoom'], 1.5, 12, 2],
      },
    });
    map.addLayer({
      id: 'stops-highlight',
      type: 'symbol',
      source: 'stops-highlight',
      filter: [
        'any',
        ['>=', ['zoom'], 14],
        ['==', ['get', 'type'], 'end'],
        ['==', ['get', 'type'], 'intersect'],
      ],
      layout: {
        // Simplified with 'match' expression for better performance
        'icon-image': [
          'match',
          ['get', 'type'],
          'end',
          'stop-end',
          'intersect',
          'stop-active',
          'stop', // default
        ],
        'icon-size': [
          'step',
          ['zoom'],
          0.3,
          10,
          [
            'match',
            ['get', 'type'],
            'end',
            0.3,
            'intersect',
            0.6,
            0.45, // default
          ],
          15,
          [
            'match',
            ['get', 'type'],
            'end',
            0.45,
            'intersect',
            0.9,
            0.6, // default
          ],
        ],
        // Simplified: both 'end' and 'intersect' use 'bottom', others use 'center'
        'icon-anchor': [
          'match',
          ['get', 'type'],
          ['end', 'intersect'],
          'bottom',
          'center', // default
        ],
        'icon-padding': 0.5,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'text-optional': true,
        'text-field': [
          'step',
          ['zoom'],
          [
            'case',
            ['any',
              ['==', ['get', 'type'], 'end'],
              ['==', ['get', 'type'], 'intersect'],
            ],
            stopTextFullFormat,
            '',
          ],
          14,
          [
            'case',
            ['any',
              ['==', ['get', 'type'], 'end'],
              ['==', ['get', 'type'], 'intersect'],
            ],
            stopTextFullFormat,
            stopTextPartialFormat,
          ],
          16,
          stopTextFullFormat,
        ],
        'text-size': [
          'step',
          ['zoom'],
          [
            'case',
            ['any',
              ['==', ['get', 'type'], 'end'],
              ['==', ['get', 'type'], 'intersect'],
            ],
            14,
            11,
          ],
          16,
          14,
        ],
        'text-justify': [
          'case',
          ['boolean', ['get', 'left'], false],
          'right',
          'left',
        ],
        'text-anchor': [
          'case',
          ['boolean', ['get', 'left'], false],
          'right',
          'left',
        ],
        'text-offset': [
          'case',
          ['boolean', ['get', 'left'], false],
          ['literal', [-0.8, 0]],
          ['literal', [0.8, 0]],
        ],
        'text-padding': 0.5,
        'text-font': ['Noto Sans Regular'],
        'text-max-width': 16,
        'text-line-height': 1.1,
      },
      paint: {
        ...stopText.paint,
        'text-halo-width': [
          'case',
          ['any',
            ['==', ['get', 'type'], 'end'],
            ['==', ['get', 'type'], 'intersect'],
          ],
          2,
          1,
        ],
      },
    });
    // Add stops-highlight-selected layer, checking if stops-highlight exists first
    const stopsHighlightLayer = map.getLayer('stops-highlight');
    const beforeLayerForSelected = stopsHighlightLayer
      ? 'stops-highlight'
      : 'stops';
    map.addLayer(
      {
        id: 'stops-highlight-selected',
        type: 'circle',
        source: 'stops-highlight',
        filter: ['any', ['>', ['zoom'], 10], ['==', ['get', 'type'], 'end']],
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            4,
            15,
            // Simplified: both 'end' and 'intersect' get 4, default 12
            [
              'match',
              ['get', 'type'],
              ['end', 'intersect'],
              4,
              12, // default
            ],
          ],
          'circle-color': '#fff',
          'circle-stroke-color': '#f01b48',
          'circle-stroke-width': 5,
          'circle-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            0.5,
            0,
          ],
          'circle-stroke-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            0.5,
            0,
          ],
        },
      },
      beforeLayerForSelected,
    );

    // Cursor and dismiss handlers are lightweight — attach immediately
    map.on('mouseenter', 'stops', () => {
      mapCanvas.style.cursor = 'pointer';
    });
    map.on('mouseleave', 'stops', () => {
      mapCanvas.style.cursor = '';
      hideStopTooltip();
    });
    map.on('mouseout', hideStopTooltip);
    map.on('movestart', hideStopTooltip);
    map.on('mouseenter', 'stops-highlight', () => {
      mapCanvas.style.cursor = 'pointer';
    });
    map.on('mouseleave', 'stops-highlight', () => {
      mapCanvas.style.cursor = '';
    });

    // Defer the queryRenderedFeatures hover handler until idle (guaranteed within 2s)
    if (supportsHover) {
      requestIdleCallback(() => {
        let lastFeature = null;
        // RAF-throttled mousemove handler for smooth 60fps updates
        const handleMouseMove = rafThrottle((e) => {
          if (map.isMoving() || map.getZoom() >= 16) {
            if (lastFeature) {
              lastFeature = null;
              hideStopTooltip();
            }
            return;
          }
          const { point } = e;
          // Build layers array, only including layers that exist
          let queryLayers;
          if (IS_ALL_MODE) {
            queryLayers = [];
            loadedCities.forEach((c) => {
              if (map.getLayer(`stops-${c}`)) queryLayers.push(`stops-${c}`);
            });
            if (map.getLayer('stops-highlight')) queryLayers.push('stops-highlight');
          } else {
            queryLayers = ['stops'].filter((l) => map.getLayer(l));
            if (map.getLayer('stops-highlight')) queryLayers.push('stops-highlight');
          }
          const features = map.queryRenderedFeatures(point, {
            layers: queryLayers,
            validate: false,
          });
          if (features.length) {
            if (lastFeature && features[0].id === lastFeature.id) {
              return;
            }
            lastFeature = features[0];
            const stopID = decode(features[0].id);
            let data;
            if (IS_ALL_MODE) {
              const featureCity = features[0].properties?.city
                || features[0].source?.replace(/^stops-/, '');
              data = featureCity
                ? cityDataMap.get(featureCity)?.stopsData?.[stopID]
                : null;
            } else {
              data = stopsData[stopID];
            }
            showStopTooltip({
              ...data,
              ...point,
            });
          } else if (lastFeature) {
            lastFeature = null;
            hideStopTooltip();
          }
        });
        map.on('mousemove', handleMouseMove);
      }, { timeout: 2000 });
    }

    // Transit service routes
    map.addSource('routes', {
      type: 'geojson',
      tolerance: 1,
      buffer: 0,
      lineMetrics: true,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    map.addLayer(
      {
        id: 'routes',
        type: 'line',
        source: 'routes',
        layout: {
          'line-cap': 'round',
        },
        paint: {
          'line-color': C.routeLine,
          'line-gradient': routeLineGradient,
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0.9,
            16,
            0.4,
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            2,
            16,
            5,
            22,
            10,
          ],
          'line-offset': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0,
            16,
            -3,
            22,
            -8,
          ],
        },
      },
      'stops',
    );

    map.addLayer(
      {
        id: 'routes-bg',
        type: 'line',
        source: 'routes',
        maxzoom: 20, // Stop rendering when nearly transparent (opacity approaches 0)
        layout: {
          'line-cap': 'round',
        },
        paint: {
          'line-color': C.routeCasing,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 1, 22, 0],
          'line-width': 6,
          'line-offset': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0,
            16,
            -3,
            22,
            -8,
          ],
        },
      },
      'routes',
    );

    map.addLayer(
      {
        id: 'route-arrows',
        type: 'symbol',
        source: 'routes',
        minzoom: 10, // Only show arrows when zoomed in enough to see direction
        maxzoom: 18, // Hide at very high zooms where direction is obvious from line
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 100,
          'text-field': '→',
          'text-size': 16,
          // 'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-font': ['Noto Sans Regular'],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-keep-upright': false,
          'text-anchor': 'bottom',
          'text-padding': 0,
          'text-line-height': 1,
          'text-offset': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            ['literal', [0, 0]],
            22,
            ['literal', [0, -2]],
          ],
        },
        paint: {
          'text-color': C.metroPurple,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 11, 0.9, 16, 0.9, 18, 0],
          'text-halo-color': C.textHalo,
          'text-halo-width': 2,
        },
      },
      'stops',
    );

    // Transit service routes (passing, overlapping)
    map.addSource('routes-path', {
      type: 'geojson',
      tolerance: 1,
      buffer: 0,
      lineMetrics: true,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    map.addLayer(
      {
        id: 'routes-path',
        type: 'line',
        source: 'routes-path',
        layout: {
          'line-cap': 'round',
        },
        paint: {
          'line-color': C.routeLine,
          'line-gradient': routeLineGradient,
          'line-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            1,
            ['boolean', ['feature-state', 'fadein'], false],
            0.07,
            0.5, // default
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            2,
            16,
            5,
            22,
            10,
          ],
        },
      },
      'stops',
    );

    map.addLayer(
      {
        id: 'routes-path-bg',
        type: 'line',
        source: 'routes-path',
        layout: {
          'line-cap': 'round',
        },
        maxzoom: 20,
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'fadein'], false],
            'transparent',
            C.routeCasing,
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            6,
            16,
            10,
            22,
            16,
          ],
        },
      },
      'routes-path',
    );

    map.addLayer({
      id: 'route-path-labels',
      type: 'symbol',
      source: 'routes-path',
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 300,
        // 'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
        'text-font': ['Noto Sans Regular'],
        'text-field': '{service}',
        'text-size': 14,
        'text-rotation-alignment': 'viewport',
        'text-padding': 0,
        'text-line-height': 1,
      },
      paint: {
        'text-color': C.serviceGreen,
        'text-halo-color': C.serviceGreenHalo,
        'text-halo-width': 2,
        'text-opacity': [
          'case',
          ['boolean', ['feature-state', 'fadein'], false],
          0.1,
          1,
        ],
      },
    });

    map.addLayer(
      {
        id: 'route-path-arrows',
        type: 'symbol',
        source: 'routes-path',
        minzoom: 10, // Only show arrows when zoomed in enough
        maxzoom: 18, // Hide at very high zooms
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 200,
          'text-field': '→',
          'text-size': 16,
          // 'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-font': ['Noto Sans Regular'],
          // 'text-allow-overlap': true,
          // 'text-ignore-placement': true,
          'text-keep-upright': false,
          'text-anchor': 'bottom',
          'text-padding': 0,
          'text-line-height': 1,
          'text-offset': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            ['literal', [0, 0]],
            22,
            ['literal', [0, -2]],
          ],
        },
        paint: {
          'text-color': C.metroPurple,
          'text-halo-color': C.textHalo,
          'text-halo-width': 2,
          'text-opacity': [
            'case',
            ['boolean', ['feature-state', 'fadein'], false],
            0.1,
            1,
          ],
        },
      },
      'stops',
    );

    requestIdleCallback(() => {
      let hoveredRouteID;
      map.on('mouseenter', 'routes-path', () => {
        mapCanvas.style.cursor = 'pointer';
      });
      map.on('click', 'routes-path', (e) => {
        if (e.features.length) {
          const { id } = e.features[0];
          navigateTo(`/services/${encodeURIComponent(decode(id))}`, route);
        }
      });
      // RAF-throttled mousemove for smooth route highlighting
      const handleRoutesPathMouseMove = rafThrottle((e) => {
        if (e.features.length) {
          const currentHoveredRouteID = e.features[0].id;
          if (hoveredRouteID && hoveredRouteID === currentHoveredRouteID)
            return;

          hoveredRouteID = currentHoveredRouteID;

          // Build batch updates for all routes
          const updates = [];
          updates.push({
            id: hoveredRouteID,
            state: { hover: true, fadein: false },
          });

          STORE.routesPathServices?.forEach((service) => {
            const id = encode(service);
            if (hoveredRouteID !== id) {
              updates.push({ id, state: { hover: false, fadein: true } });
            }
          });

          // Apply all feature state updates efficiently
          replaceFeatureStates(map, 'routes-path', updates);
          highlightRouteTag(decode(hoveredRouteID));
        }
      });
      map.on('mousemove', 'routes-path', handleRoutesPathMouseMove);
      map.on('mouseleave', 'routes-path', () => {
        mapCanvas.style.cursor = '';
        if (hoveredRouteID) {
          // Clear all feature states at once instead of iterating
          map.removeFeatureState({ source: 'routes-path' });
          hoveredRouteID = null;
          highlightRouteTag();
        }
      });
    });

    // Service live buses
    map.addSource('buses-service', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    map
      .loadImage(busTinyImagePath)
      .then((img) => {
        map.addImage('bus-tiny', img.data);
      })
      .catch((e) => {
        console.error('Failed to load bus-tiny image:', e);
      });
    map.addLayer({
      id: 'buses-service',
      type: 'symbol',
      source: 'buses-service',
      minzoom: 4,
      layout: {
        'icon-image': 'bus-tiny',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': ['step', ['zoom'], 0.5, 14, 0.6, 15, 0.7, 16, 0.8],
        'text-field': ['get', 'vehicleNumber'],
        'text-optional': true,
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12,
          12,
          14,
          14,
          16,
          16,
        ],
        'text-font': ['Noto Sans Regular'],
        'text-variable-anchor': ['left', 'right', 'bottom', 'top'],
        'text-justify': 'auto',
        'text-offset': [0.5, 1],
        'text-padding': 4,
      },
      paint: {
        'text-color': C.text,
        'text-halo-color': C.textHalo,
        'text-halo-width': 2,
      },
    });

    // Dim overlay — sits below between-route layers to fade the basemap
    map.addSource('dim-overlay', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]],
        },
      },
    });
    map.addLayer(
      {
        id: 'dim-overlay',
        type: 'fill',
        source: 'dim-overlay',
        paint: {
          'fill-color': isDark ? '#000' : '#fff',
          'fill-opacity': 0,
          'fill-opacity-transition': { duration: 300 },
        },
      },
      'stops',
    );

    // Between routes
    map.addSource('routes-between', {
      type: 'geojson',
      tolerance: 1,
      buffer: 0,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    map.addLayer(
      {
        id: 'routes-between',
        type: 'line',
        source: 'routes-between',
        filter: ['!=', ['get', 'type'], 'walk'],
        layout: {
          'line-cap': 'round',
        },
        paint: {
          'line-color': [
            'match',
            ['get', 'type'],
            'start',
            C.routeLine,
            'end',
            C.routeLineMid,
            C.routeLine,
          ],
          'line-opacity': 0.7,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            2,
            16,
            5,
            22,
            10,
          ],
          'line-offset': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0,
            16,
            -3,
            22,
            -8,
          ],
        },
      },
      'stops',
    );

    // Add routes-between-walk layer, checking if stops-highlight exists first
    const beforeLayer = map.getLayer('stops-highlight')
      ? 'stops-highlight'
      : 'stops';
    map.addLayer(
      {
        id: 'routes-between-walk',
        type: 'line',
        source: 'routes-between',
        filter: ['==', ['get', 'type'], 'walk'],
        paint: {
          'line-color': C.linkBlue,
          'line-dasharray': [2, 2],
          'line-opacity': 0.7,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            2,
            16,
            5,
            22,
            10,
          ],
        },
      },
      beforeLayer,
    );

    map.addLayer(
      {
        id: 'routes-between-bg',
        type: 'line',
        source: 'routes-between',
        layout: {
          'line-cap': 'round',
        },
        maxzoom: 14,
        paint: {
          'line-color': C.routeCasing,
          'line-width': 6,
        },
      },
      'routes-between',
    );

    map.addLayer({
      id: 'route-between-arrows',
      type: 'symbol',
      source: 'routes-between',
      minzoom: 10, // Only show arrows when zoomed in enough
      maxzoom: 18, // Hide at very high zooms
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 100,
        'text-field': '→',
        'text-size': 16,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-keep-upright': false,
        'text-anchor': 'bottom',
        'text-padding': 0,
        'text-line-height': 1,
        'text-offset': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12,
          ['literal', [0, 0]],
          22,
          ['literal', [0, -2]],
        ],
      },
      paint: {
        'text-color': C.metroPurple,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 11, 0.8, 16, 0.8, 18, 0],
        'text-halo-color': C.textHalo,
        'text-halo-width': 2,
      },
    });

    renderRoute();

    // Re-run search if the user typed something while the worker was initialising
    workerReady.then(() => {
      if (searchField.current?.value) handleSearch();
    });

    // In all-mode, attach viewport engine to load/unload cities as user pans
    if (IS_ALL_MODE) {
      const checkViewport = throttle(() => {
        if (!map) return;
        const vp = map.getBounds();
        const zoom = map.getZoom();
        // Persist viewport so returning to /#/all restores position
        try {
          const c = map.getCenter();
          localStorage.setItem('allModeViewport', JSON.stringify({ lng: c.lng, lat: c.lat, zoom }));
          saveViewportToUrl(c.lat, c.lng, map.getZoom());
        } catch (_) {}
        AVAILABLE_CITIES.forEach((cityCode) => {
          const minZoom = CITY_CONFIGS[cityCode]?.city?.bounds?.minZoom;
          // Data-derived (stops.min.json extent + 4km buffer) bounds — not yet
          // available if this city's preindex fetch hasn't resolved
          const b = cityStopsBounds.get(cityCode);
          if (minZoom == null || !b) return;
          if (viewportOverlapsBounds(vp, b) && zoom >= minZoom) {
            loadCity(cityCode);
          } else if (!activeSelectionCities.has(cityCode)) {
            unloadCity(cityCode);
          }
        });
      }, 200);
      checkViewportRef.current = checkViewport;
      map.on('moveend', checkViewport);
      map.on('zoomend', checkViewport);

      // Restore initial position: URL params → localStorage → geolocation
      const urlViewport = getViewportFromUrl();
      if (urlViewport) {
        map.jumpTo({ center: [urlViewport.lon, urlViewport.lat], zoom: urlViewport.z });
      } else {
        const savedViewport = (() => { try { return JSON.parse(localStorage.getItem('allModeViewport')); } catch (_) { return null; } })();
        if (savedViewport?.lng != null) {
          map.jumpTo({ center: [savedViewport.lng, savedViewport.lat], zoom: savedViewport.zoom });
        } else if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            ({ coords }) => {
              map.flyTo({ center: [coords.longitude, coords.latitude], zoom: 11, animate: true });
            },
            () => {}, // denied — stay on default India view
            { timeout: 5000 },
          );
        }
      }

      // Run once after the viewport is settled (not before) so it evaluates the
      // restored position rather than the pre-jump default — `checkViewport` is
      // leading-edge throttled, so calling it before jumpTo would have this call
      // win the throttle window and silently swallow jumpTo's own moveend firing.
      checkViewport();

      // Pre-index all cities for global search (lightweight — name+number only)
      // Called immediately (no debounce) so search updates as soon as a city loads or unloads.
      const refreshSearch = () => {
        const currentValue = searchField.current?.value || '';
        if (currentValue) {
          const q = currentValue.toLowerCase();
          const matched = allModeServicesIdx
            .filter((s) => s.number.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
            .sort((a, b) => compareCityPriority(a.city, b.city));
          setServices(matched);
        } else {
          setServices(buildAllModeSearchList());
        }
      };
      onCityLoadedCallback = (cityCode) => {
        refreshSearch();
        if (currentLocationRef.current) {
          setClosestStops(computeAllModeClosestStops(...currentLocationRef.current));
        }
        // Keep newly loaded city stops hidden while a service is being shown
        if (getRoute().page === 'service') {
          if (map?.getLayer(`stops-${cityCode}`)) map.setLayoutProperty(`stops-${cityCode}`, 'visibility', 'none');
          if (map?.getLayer(`stops-icon-${cityCode}`)) map.setLayoutProperty(`stops-icon-${cityCode}`, 'visibility', 'none');
        }
      };
      onCityUnloadedCallback = refreshSearch;
      preindexAllCities().then(() => {
        setAllModePreindexed(true);
        initDataWorker({ stopsArr: allModeStopsIdx, servicesArr: allModeServicesIdx, servicesData: {}, poisArr: allModePoisIdx });
        refreshSearch();
        // Bounds for cities whose preindex fetch was still in flight during the
        // last checkViewport() call are only available now — re-evaluate so
        // that a static viewport (no further pan/zoom) still loads them
        checkViewport();
      });
    }

    // All-mode only: persist/restore viewport via URL so a shared link keeps its
    // map position across cities. City-scoped mode never writes lat/lon/z to
    // the URL — the hash route alone determines its viewport.

    // GeolocateControl automatically acquires location on page load if permission is 'granted'
    // The handleLocationUpdate callback will be triggered when location is acquired and marker is rendered
  }, [mapLoaded]);

  // destEndpoint: {type:'stop', number, city} | {type:'location', lat, lon} —
  // completes whichever picking mode is active (editing one side of an
  // existing query, or picking a fresh destination for directionsOrigin)
  // by building a `between` URL with the new ~-joined, location-aware token
  // format (see encodeBetweenToken). Returns false if neither picking mode
  // is active, so callers can fall through to their normal click behavior.
  const finishDirectionsPick = (destEndpoint) => {
    if (editingBetweenStop) {
      const { role, fixedStop } = editingBetweenStop;
      setEditingBetweenStop(null);
      const destToken = encodeBetweenToken(destEndpoint);
      if (fixedStop != destToken) {
        const start = role === 'origin' ? destToken : fixedStop;
        const end = role === 'origin' ? fixedStop : destToken;
        location.hash = `${route.cityPrefix}/between/${start}~${end}`;
      }
      return true;
    }
    if (!directionsOrigin) return false;
    const originToken = encodeBetweenToken(directionsOrigin);
    setDirectionsOrigin(null);
    const destToken = encodeBetweenToken(destEndpoint);
    if (originToken !== destToken) {
      const prefix = IS_ALL_MODE ? '/all' : route.cityPrefix;
      location.hash = `${prefix}/between/${originToken}~${destToken}`;
    }
    return true;
  };

  const selectDirectionsDestination = (stopNumber, destCity) =>
    finishDirectionsPick({ type: 'stop', number: stopNumber, city: destCity });

  // Alpha "location-to-location directions" feature — completes a directions
  // pick with a location endpoint (map click or a location search result
  // clicked while origin-picking/edit-picking is active).
  const selectLocationDirectionsDestination = (lat, lon) =>
    finishDirectionsPick({ type: 'location', lat, lon });

  // Starts picking a destination FROM a location (mirrors the stop
  // popover's "Directions" button, which sets directionsOrigin to a plain
  // stop object — encodeBetweenToken treats anything without
  // type:'location' as a stop, so that path is untouched).
  const startDirectionsFromLocation = (locInfo) => {
    setDirectionsOrigin({ type: 'location', lat: locInfo.lat, lon: locInfo.lon, name: locInfo.name });
    hideLocationPopover();
    setShrinkSearch(false);
  };

  useEffect(() => {
    if (!mapLoaded) return;
    const handleMapClick = (e) => {
      if (e.originalEvent.altKey) {
        const layers = map.queryRenderedFeatures(e.point, {
          validate: false,
        });
      }
      const { point } = e;
      // Build layers array, only including layers that exist
      const queryLayers = ['stops', 'stops-icon'].filter((layerId) =>
        map.getLayer(layerId),
      );
      // Only add stops-highlight if it exists
      if (map.getLayer('stops-highlight')) {
        queryLayers.push('stops-highlight');
      }
      // In all-mode, also query city-scoped stop layers
      if (IS_ALL_MODE) {
        loadedCities.forEach((cityCode) => {
          if (map.getLayer(`stops-${cityCode}`)) queryLayers.push(`stops-${cityCode}`);
          if (map.getLayer(`stops-icon-${cityCode}`)) queryLayers.push(`stops-icon-${cityCode}`);
        });
      }
      const features = map.queryRenderedFeatures(point, {
        layers: queryLayers,
        validate: false,
      });
      if (features.length) {
        const zoom = map.getZoom();
        const feature = features[0];
        const center = feature.geometry.coordinates;
        if (zoom < 12) {
          // Slowly zoom in first
          map.flyTo({ zoom: zoom + 2, center });
          setShrinkSearch(true);
        } else if (selectDirectionsDestination(feature.properties.number, feature.properties.city)) {
          // Handled by directions mode
        } else if (IS_ALL_MODE && feature.properties.city) {
          location.hash = `#/all/stops/${feature.properties.city}^${feature.properties.number}`;
        } else {
          if (feature.source == 'stops') {
            navigateTo(`/stops/${feature.properties.number}`, route);
          } else {
            _showStopPopover(feature.properties.number);
          }
        }
      } else {
        const hadDirectionsContext = directionsOrigin !== null || editingBetweenStop !== null;
        // Mid-pick, a bare map click completes the pick with that point as a
        // location endpoint, rather than cancelling — this is what makes
        // stop→location and location→location directions reachable from the
        // map, not just via search results.
        if (hadDirectionsContext && isAlphaEnabled() && locationSearchEnabledRef.current) {
          const { lng, lat } = e.lngLat;
          selectLocationDirectionsDestination(lat, lng);
          return;
        }
        if (directionsOrigin !== null) setDirectionsOrigin(null);
        if (editingBetweenStop !== null) setEditingBetweenStop(null);

        // A bare map tap collapses search out of the way (no-ops if search
        // isn't currently the thing presented, e.g. another popover is up).
        // Blur first so the on-screen keyboard doesn't stay open over a
        // sheet that's no longer expanded to make room for it.
        searchField.current?.blur();
        movePaneToBreak(searchPane, 'bottom');

        // A bare map tap while any popover (stop/service/between/location)
        // is open collapses it first — same "peek" break a drag-to-bottom
        // would rest at (handle+header only) — and only actually dismisses
        // it on a *second* tap once it's already resting there. On desktop
        // (no pane involved) there's no peek state to collapse to, so a tap
        // there still dismisses immediately, same as before.
        if (anyPopoverOpen) {
          if (paneAppliesHere(supportsTouch, BREAKPOINT)) {
            const activePaneRef = showLocationPopover
              ? locationPane
              : betweenShown
                ? betweenPane
                : showServicePopover
                  ? servicePane
                  : stopPane;
            const activePane = activePaneRef.current;
            const atBottom =
              activePane?.isPanePresented?.() && activePane.currentBreak() === 'bottom';
            if (!atBottom) {
              movePaneToBreak(activePaneRef, 'bottom');
              return;
            }
          }
          if (showLocationPopover) {
            hideLocationPopover();
          } else if (showServicePopover || showBetweenPopover) {
            navigateTo('/', route);
          } else {
            const { page, subpage } = route;
            if (page === 'stop' && subpage !== 'routes') {
              navigateTo('/', route);
            } else {
              hideStopPopover();
            }
          }
          return;
        }

        // Alpha "locations" feature: clicking bare map (no stop hit, not mid
        // directions-picking, nothing else open) opens the location popover
        // for that point.
        if (isAlphaEnabled() && locationSearchEnabledRef.current) {
          const { lng, lat } = e.lngLat;
          location.hash = `${route.cityPrefix}/locations/${lat.toFixed(6)},${lng.toFixed(6)}`;
        }
      }
    };
    map.on('click', handleMapClick);
    return () => map.off('click', handleMapClick);
  }, [
    mapLoaded,
    route.page,
    route.subpage,
    _showStopPopover,
    hideStopPopover,
    hideLocationPopover,
    directionsOrigin,
    editingBetweenStop,
    showStopPopover,
    showBetweenPopover,
    showServicePopover,
    showLocationPopover,
  ]);

  const popoverIsUp = useMemo(
    () =>
      (!!showStopPopover || !!showBetweenPopover || !!showServicePopover) &&
      !largerScreen,
    [showStopPopover, showBetweenPopover, showServicePopover, largerScreen],
  );

  // Global shortcuts
  useEffect(() => {
    const handler = (e) => {
      const isFormField =
        e.target &&
        e.target.tagName &&
        /input|textarea|button|select/i.test(e.target.tagName);
      const keydown = e.key.toLowerCase();
      switch (keydown) {
        case '/': {
          console.log('/', isFormField, searchField.current);
          if (isFormField) return;
          if (popoverIsUp) return;
          e.preventDefault();
          searchField.current.focus();
          break;
        }
        case 'escape': {
          if (expandSearch) {
            handleSearchClose();
          } else if (showStopPopover) {
            hideStopPopover();
          } else if (showBetweenPopover) {
            navigateTo('/', route);
          } else if (showServicePopover) {
            navigateTo('/', route);
          }
          break;
        }
        default: {
          if (e.shiftKey && e.altKey) {
            document.body.classList.add('alt-mode');
          }
        }
      }
    };
    const keyupHandler = () => {
      document.body.classList.remove('alt-mode');
    };
    document.addEventListener('keydown', handler);
    document.addEventListener('keyup', keyupHandler);
    return () => {
      document.removeEventListener('keydown', handler);
      document.removeEventListener('keyup', keyupHandler);
    };
  }, [
    expandSearch,
    showStopPopover,
    showBetweenPopover,
    showServicePopover,
    popoverIsUp,
  ]);

  // Initialize vehicle tracker when map loads (or when effective city changes in all-mode)
  const trackerCity = IS_ALL_MODE ? (route.value?.split('^')[0] || null) : route.city;
  useEffect(() => {
    if (!mapLoaded || !map) return;

    const cityConfig = getConfigForCity(trackerCity);
    vehicleTracker.current = createVehicleTracker({
      cityConfig,
      map,
      setRafInterval,
      clearRafInterval,
    });

    // Subscribe to vehicle updates
    const unsubscribe = vehicleTracker.current.subscribe((vehicles) => {
      setRouteVehicles(vehicles);
    });

    // Cleanup on unmount
    return () => {
      unsubscribe();
      vehicleTracker.current?.stop();
    };
  }, [mapLoaded, trackerCity]);

  // Auto-start vehicle tracking if a single service route is loaded initially
  useEffect(() => {
    if (!vehicleTracker.current || !mapLoaded || !servicesData) return;

    const currentRoute = getRoute();

    // Check if we're on a service page with a single service
    if (currentRoute.page === 'service' && currentRoute.value) {
      const parts = currentRoute.value.split('~');

      // In all-mode, only track for single-city single-service views
      if (IS_ALL_MODE) {
        if (parts.length === 1 && parts[0].includes('^')) {
          const svcNum = parts[0].slice(parts[0].indexOf('^') + 1);
          if (servicesData[svcNum]) vehicleTracker.current.start(svcNum);
        }
      } else {
        const services = parts.map((s) => findServiceKey(s)).filter(Boolean);
        if (services.length === 1) vehicleTracker.current.start(services[0]);
      }
    }
  }, [mapLoaded, routeServices]);

  // Follow selected vehicle on the map
  useEffect(() => {
    if (!mapLoaded || !followedVehicleId || !routeVehicles.length) return;

    const vehicle = routeVehicles.find(
      (v) => v.vehicleId === followedVehicleId,
    );
    if (!vehicle || !vehicle.location) return;

    const { lat, lng } = vehicle.location;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;

    // Zoom to and follow the vehicle
    map.easeTo({
      center: [lng, lat],
      zoom: Math.max(map.getZoom(), 16),
      duration: 800,
    });
  }, [followedVehicleId, routeVehicles, mapLoaded]);

  const showServicesFloatPill =
    route.page === 'service' && servicesData && routeServices.length > 1;
  // In all-mode, the float pill stop data comes from cityDataMap, not stopsData
  const pillCaret = IS_ALL_MODE && route.page === 'stop' && route.subpage === 'routes'
    ? (route.value || '').indexOf('^')
    : -1;
  const pillStopCity = pillCaret !== -1 ? route.value.slice(0, pillCaret) : null;
  const pillStopNum = pillCaret !== -1 ? route.value.slice(pillCaret + 1) : null;
  const pillStopData = pillStopCity
    ? cityDataMap.get(pillStopCity)?.stopsData?.[pillStopNum] ?? null
    : null;

  const showPassingRoutesFloatPill =
    route.page === 'stop' &&
    route.subpage === 'routes' &&
    (IS_ALL_MODE ? !!pillStopData : (stopsData && findStopKey(route.value)));

  const servicesResults = services.length
    ? (expandedSearchOnce ? services : services.slice(0, 25)).map((s) => {
        const isServicePage = route.page === 'service';
        const checked =
          route.value && route.value.split('~').includes(s.number);
        return (
          <li key={s.number}>
            <a
              href={`#${route.cityPrefix}/services/${encodeURIComponent(s.number)}`}
              class={checked ? 'current' : ''}
              onMouseEnter={() => previewRoute(s.number)}
              onMouseLeave={unpreviewRoute}
            >
              <b class="service-tag">{s.number}</b> {s.name}
            </a>
            <label hidden={!isServicePage}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  const { checked } = e.target;
                  let newServices = [];
                  if (checked) {
                    newServices = route.value.split('~').concat(s.number);
                  } else {
                    newServices = route.value
                      .split('~')
                      .filter((service) => service !== s.number);
                  }
                  newServices.sort(sortServices);
                  setTimeout(() => {
                    if (newServices.length) {
                      navigateTo(
                        `/services/${newServices.map((s) => encodeURIComponent(s)).join('~')}`,
                        route,
                      );
                    } else {
                      navigateTo('/', route);
                    }
                  }, 250);
                }}
              />
            </label>
          </li>
        );
      })
    : !searching &&
      !closestStops.length &&
      [1, 2, 3, 4, 5, 6, 7, 8].map((s, i) => (
        <li key={s}>
          <a href={`#${route.cityPrefix}/`}>
            <b class="service-tag">&nbsp;&nbsp;&nbsp;</b>
            <span class="placeholder">
              █████{i % 3 == 0 ? '███' : ''} ███
              {i % 2 == 0 ? '████' : ''}
            </span>
          </a>
        </li>
      ));

  const stopsResults =
    searching &&
    !!stops.length &&
    stops.map((s) => (
      <li key={s.number}>
        <a
          href={`#${route.cityPrefix}/stops/${s.number}`}
          onClick={(e) => {
            if (directionsOrigin || editingBetweenStop) {
              e.preventDefault();
              selectDirectionsDestination(s.number);
            }
          }}
        >
          <b class="stop-tag">{s.number}</b>
          <span class="stop-name-with-suffix">
            <span class="stop-name">{s.name}</span>
            {s.suffix && <span class="stop-suffix">{s.suffix}</span>}
          </span>
        </a>
      </li>
    ));

  // `#/all/between/<query>/<result-num>` (1-based) or `${cityPrefix}/between/<query>/<result-num>` —
  // selects a single itinerary/result to show as a vertical detail card instead of the list.
  const betweenSelectedIdx = (() => {
    if (route.page !== 'between' || !route.subpage) return null;
    const idx = parseInt(route.subpage, 10) - 1;
    return Number.isInteger(idx) && idx >= 0 ? idx : null;
  })();
  const betweenListUrl = IS_ALL_MODE
    ? `/all/between/${route.value}`
    : `${route.cityPrefix}/between/${route.value}`;
  const betweenListHref = `#${betweenListUrl}`;

  // Derived per-stop view for the multi-service popover's intersecting-stops list —
  // memoized so the O(cities) city lookup and O(services) filter+sort per stop only
  // rerun when the underlying data actually changes, not on every popover re-render.
  const intersectingStopsView = useMemo(
    () =>
      intersectStops.map((s) => {
        const stop = stopsData[s];
        const stopCity = IS_ALL_MODE
          ? [...activeSelectionCities].find((c) => cityDataMap.get(c)?.stopsData?.[s])
          : null;
        const servicesLabel =
          routeServices.length > 2
            ? stop.services
                .filter((svc) => routeServices.includes(svc))
                .sort(sortServices)
                .join(' ')
            : null;
        return { id: s, stop, stopCity, servicesLabel };
      }),
    [intersectStops, stopsData, routeServices],
  );

  // Extracted so the same buttons can render in both places: nested inside
  // the popover (desktop's floating card, where it's naturally sized to
  // fit) and in a separate always-on-screen floating bar for mobile — see
  // the .mobile-floating-footer siblings right after the stop/service
  // divs below. cupertino-pane keeps a popover as one continuous box sized
  // to its tallest enabled break and only reveals part of it via
  // transform; a footer in normal flow at the bottom of that box is only
  // ever visible once dragged almost to the top, not at the default
  // resting position. Only `stopPopoverData &&`-gated call sites should
  // invoke this.
  const renderStopFooter = () => (
    <div class="popover-footer">
      <div class="popover-buttons footer-actions">
        <a
          href={`/arrival/${stopPopoverDestFilter ? `?dest=${encodeURIComponent(stopPopoverDestFilter)}${stopPopoverDestFilterExact ? '&destExact=1' : ''}` : ''}#/${stopPopoverData.city || route.city}/${stopPopoverData.number}`}
          class="popover-button primary footer-arrivals"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          {t('glossary.busArrivals')}
        </a>
        {isAlphaEnabled() && (
          <a
            href={`/beta/timetable/#/${stopPopoverData.city || route.city}/${stopPopoverData.number}`}
            class="popover-button footer-secondary"
            target="_blank"
            title="Timetable"
          >
            {TIMETABLE_SVG}
          </a>
        )}
        {stopPopoverData.services.length > 1 && (
          <a
            href={IS_ALL_MODE && stopPopoverData.city
              ? `#/all/stops/${stopPopoverData.city}^${stopPopoverData.number}/routes`
              : `#${route.cityPrefix}/stops/${stopPopoverData.number}/routes`}
            class="popover-button footer-secondary"
            title={t('glossary.passingRoutes')}
          >
            <img
              src={passingRoutesBlueImagePath}
              width="16"
              height="16"
              alt=""
            />
          </a>
        )}
        {isAlphaEnabled() && (
          <a
            href={`/diagram/#/${stopPopoverData.city || route.city}/${stopPopoverData.number}`}
            class="popover-button footer-secondary"
            target="_blank"
            title="Diagram"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
          </a>
        )}
      </div>
    </div>
  );

  // Same reasoning as renderStopFooter above. Only rendered for the
  // single-service alpha view (matches the original inline condition).
  const renderServiceFooter = () =>
    isAlphaEnabled() && (
      <div class="popover-footer">
        <div class="popover-buttons footer-actions">
          <a
            href={`/beta/timetable/#/${IS_ALL_MODE ? route.value?.split('^')[0] : route.city}/route/${encodeURIComponent(routeServices[0])}`}
            class="popover-button footer-arrivals"
            target="_blank"
            title="Timetable"
          >
            {TIMETABLE_SVG}
            Timetable
          </a>
          <a
            href={`/beta/visualization/?city=${IS_ALL_MODE ? route.value?.split('^')[0] : route.city}#services/${routeServices[0]}`}
            class="popover-button footer-arrivals"
            target="_blank"
            title="3D Visualization"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            3D Visualize
          </a>
        </div>
      </div>
    );

  return (
    <>
      <div
        id="search-popover"
        ref={searchPopover}
        class={`popover ${expandSearch ? 'expand' : ''} ${
          shrinkSearch ? 'shrink' : ''
        } ${routeLoading ? 'loading' : ''} ${
          !anyPopoverOpen && paneAppliesHere(supportsTouch, BREAKPOINT) ? 'pane-managed' : ''
        }`}
      >
        <div
          id="popover-float"
          hidden={!(showServicesFloatPill || showPassingRoutesFloatPill)}
        >
          <div class="float-pill" ref={floatPill}>
            <a href={`#${route.cityPrefix}/`} class="popover-close">
              &times;
            </a>
            {showServicesFloatPill && (
              <>
                <div class="service-flex">
                  <h1>
                    {t('multiRoute.showingServices', {
                      count: routeServices.length,
                    })}
                  </h1>
                </div>
                <div class="services-list">
                  <div>
                    {(() => {
                      // In all-mode, route.value contains city-qualified IDs like 'blr^12F~chennai^104P'
                      // Build a map from service number → qualified segment for URL construction
                      const qualifiedParts = IS_ALL_MODE
                        ? (route.value || '').split('~').filter((p) => p.includes('^'))
                        : [];
                      const svcToQualified = Object.fromEntries(
                        qualifiedParts.map((p) => [p.slice(p.indexOf('^') + 1), p]),
                      );
                      return routeServices.sort(sortServices).map((service) => {
                        const svcHref = IS_ALL_MODE && svcToQualified[service]
                          ? `#/all/services/${svcToQualified[service]}`
                          : `#${route.cityPrefix}/services/${encodeURIComponent(service)}`;
                        return (
                          <>
                            <a
                              href={svcHref}
                              onClick={(e) => clickRoute(e, service)}
                              onMouseEnter={(e) => highlightRoute(e, service)}
                              onMouseLeave={unhighlightRoute}
                              class="service-tag"
                              data-service={service}
                            >
                              {service}
                              <span
                                class="close"
                                title="Remove this service"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (IS_ALL_MODE) {
                                    const remaining = qualifiedParts.filter(
                                      (p) => p.slice(p.indexOf('^') + 1) !== service,
                                    );
                                    location.hash = remaining.length
                                      ? `/all/services/${remaining.join('~')}`
                                      : '/all/';
                                  } else {
                                    const newRouteServices = routeServices.filter((s) => s !== service);
                                    location.hash = `${route.cityPrefix}/services/${newRouteServices.map((s) => encodeURIComponent(s)).join('~')}`;
                                  }
                                  unhighlightRoute();
                                }}
                              >
                                &times;
                              </span>
                            </a>
                          </>
                        );
                      });
                    })()}
                    <button
                      type="button"
                      class="plus"
                      onClick={() => {
                        setExpandSearch(true);
                        setExpandedSearchOnce(true);
                      }}
                      title={t('multiRoute.addRoute')}
                    />
                  </div>
                  {!!intersectStops.length && (
                    <>
                      <h2>
                        {t('multiRoute.intersectingStops', {
                          count: intersectStops.length,
                        })}
                      </h2>
                      <ul class="simple-stops-list">
                        {intersectingStopsView.map(({ id, stop, stopCity, servicesLabel }) => (
                          <li key={stop.number}>
                            <a
                              href={IS_ALL_MODE && stopCity
                                ? `#/all/stops/${stopCity}^${stop.number}`
                                : `#${route.cityPrefix}/stops/${stop.number}`}
                              onClick={(e) => {
                                e.preventDefault();
                                zoomToStop(id);
                              }}
                            >
                              <b class="stop-tag">{stop.number}</b>{' '}
                              <span class="stop-name">{stop.name}</span>{' '}
                              {servicesLabel && (
                                <span class="services-meta-list">{servicesLabel}</span>
                              )}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </>
            )}
            {showPassingRoutesFloatPill && (() => {
              const activeStop = IS_ALL_MODE ? pillStopData : stopsData[findStopKey(route.value)];
              const activeStopKey = IS_ALL_MODE ? pillStopNum : route.value;
              const pillCity = IS_ALL_MODE ? pillStopCity : null;
              const cityConfig = getConfigForCity(IS_ALL_MODE ? pillStopCity : route.city);
              const disableStopID = cityConfig?.disableStopID || false;
              const makeMultiRouteHref = (services) => {
                const sorted = [...services].sort(sortServices);
                return IS_ALL_MODE && pillCity
                  ? `#/all/services/${sorted.map((s) => `${pillCity}^${encodeURIComponent(s)}`).join('~')}`
                  : `#${route.cityPrefix}/services/${sorted.map((s) => encodeURIComponent(s)).join('~')}`;
              };
              const makeServiceHref = (service) =>
                IS_ALL_MODE && pillCity
                  ? `#/all/services/${pillCity}^${encodeURIComponent(service)}`
                  : `#${route.cityPrefix}/services/${encodeURIComponent(service)}`;
              return (
                <>
                  <div class="service-flex">
                    {disableStopID ? (
                      <div>
                        <h1>
                          <span class="stop-name-with-suffix">
                            <span class="stop-name">{activeStop.name}</span>
                            {activeStop.suffix && (
                              <span class="stop-suffix">{activeStop.suffix}</span>
                            )}
                          </span>
                        </h1>
                      </div>
                    ) : (
                      <>
                        <span class="stop-tag">{activeStopKey}</span>
                        <div>
                          <h1>{activeStop.name}</h1>
                        </div>
                      </>
                    )}
                  </div>
                  <div class="services-list" onClick={unhighlightRoute}>
                    <h2>
                      {t('passingRoutes.passingRoutes', {
                        count: activeStop.services.length,
                      })}{' '}
                      ·{' '}
                      <a href={makeMultiRouteHref(activeStop.services)}>
                        {t('glossary.multiRouteMode')} ⊕
                      </a>
                    </h2>
                    {[...activeStop.services].sort(sortServices).map((service) => (
                      <a
                        href={makeServiceHref(service)}
                        onClick={IS_ALL_MODE ? undefined : (e) => clickRoute(e, service)}
                        onMouseEnter={IS_ALL_MODE ? undefined : (e) => highlightRoute(e, service)}
                        onMouseLeave={IS_ALL_MODE ? undefined : unhighlightRoute}
                        class="service-tag"
                        data-service={service}
                      >
                        {service}
                      </a>
                    ))}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
        <div class="popover-inner">
          <div class="popover-search">
            <div class="search-input-wrapper">
              <input
                type="search"
                placeholder={t('search.placeholder')}
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                ref={searchField}
                onfocus={handleSearchFocus}
                oninput={handleSearch}
                onkeydown={handleKeys}
                disabled={!IS_ALL_MODE && !searching && !services.length}
              />
              <button
                type="button"
                class="cancel-btn"
                onclick={handleSearchClose}
                title={t('common.cancel')}
                dangerouslySetInnerHTML={{ __html: CLOSE_SVG }}
              />
            </div>
            <button
              type="button"
              class="geolocate-btn"
              title={t('search.geolocate')}
              ref={geolocateBtn}
              onClick={() => geolocateControlRef.current?.trigger()}
              dangerouslySetInnerHTML={{ __html: GEOLOCATE_SVG }}
            />
          </div>
          {isAlphaEnabled() && (
            <div class="location-search-row">
              <span class="location-search-row-label">Search locations</span>
              <div
                class={`dev-toggle-track${locationSearchEnabled ? ' active' : ''}`}
                role="switch"
                aria-checked={locationSearchEnabled}
                aria-label="Search locations"
                tabIndex={0}
                onClick={() => {
                  const next = !locationSearchEnabled;
                  localStorage.setItem('locationSearch', String(next));
                  setLocationSearchEnabled(next);
                  if (!next) {
                    setLocations([]);
                    setLiveLocations([]);
                  } else if (searchField.current?.value) {
                    performSearch(searchField.current.value);
                    performGeocode(searchField.current.value);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.currentTarget.click();
                  }
                }}
              >
                <span class="dev-toggle-thumb" />
              </div>
            </div>
          )}
          <ul
            class={`popover-list ${
              IS_ALL_MODE
                ? allModePreindexed ? '' : 'loading'
                : services.length || searching || (closestStops.length && !searching)
                  ? ''
                  : 'loading'
            } ${searching ? 'searching' : ''}`}
            ref={servicesList}
            onScroll={handleServicesScroll}
            overflow-y="true"
          >
            {/* Show closest stops first when not searching and location is available */}
            {!searching &&
              closestStops.length > 0 &&
              (IS_ALL_MODE ? groupByCity(closestStops) : [{ city: null, items: closestStops }]).map(
                (group) => (
                  <Fragment key={group.city ?? 'closest'}>
                    {group.city && (
                      <li class="popover-city-header">
                        <strong>{cityDisplayName(group.city)}</strong>
                      </li>
                    )}
                    {group.items.map((s) => (
                      <li key={IS_ALL_MODE ? `${s.city}^${s.number}` : s.number}>
                        <a href={IS_ALL_MODE && s.city ? `#/all/stops/${s.city}^${s.number}` : `#${route.cityPrefix}/stops/${s.number}`}>
                          <b class="stop-tag">{s.number}</b>
                          <span class="stop-name-with-suffix">
                            <span class="stop-name">{s.name}</span>
                            {s.suffix && <span class="stop-suffix">{s.suffix}</span>}
                          </span>
                        </a>
                      </li>
                    ))}
                  </Fragment>
                ),
              )}
            {searching && (locations.length > 0 || liveLocations.length > 0) && (
              <>
                {locations.map((loc) => (
                  <li key={`poi-${loc.id}`}>
                    <a
                      href={`#${route.cityPrefix}/locations/${loc.lat},${loc.lon}`}
                      onClick={(e) => {
                        locationNameCache.set(locationKey(loc.lat, loc.lon), {
                          name: loc.name, type: loc.type, color: loc.color,
                        });
                        if (directionsOrigin || editingBetweenStop) {
                          e.preventDefault();
                          selectLocationDirectionsDestination(loc.lat, loc.lon);
                        }
                      }}
                    >
                      <b class="location-tag">{'●'}</b>
                      <span class="location-name">{loc.name}</span>
                    </a>
                  </li>
                ))}
                {liveLocations.map((loc) => (
                  <li key={`live-${loc.placeId}`}>
                    <a
                      href={`#${route.cityPrefix}/locations/${loc.lat},${loc.lon}`}
                      onClick={(e) => {
                        locationNameCache.set(locationKey(loc.lat, loc.lon), { name: loc.name });
                        if (directionsOrigin || editingBetweenStop) {
                          e.preventDefault();
                          selectLocationDirectionsDestination(loc.lat, loc.lon);
                        }
                      }}
                    >
                      <b class="location-tag">{'●'}</b>
                      <span class="location-name">{loc.name}</span>
                    </a>
                  </li>
                ))}
              </>
            )}
            {services.length
              ? capGroups(
                  IS_ALL_MODE ? groupByCity(services) : [{ city: null, items: services }],
                  expandedSearchOnce ? Infinity : 25,
                ).map((group) => (
                  <Fragment key={group.city ?? 'services'}>
                    {group.city && (
                      <li class="popover-city-header">
                        <strong>{cityDisplayName(group.city)}</strong>
                      </li>
                    )}
                    {group.items.map((s) => {
                      const isServicePage = route.page === 'service';
                      // In all-mode route.value uses 'city^num' segments; plain num otherwise
                      const qualifiedId = IS_ALL_MODE && s.city ? `${s.city}^${s.number}` : s.number;
                      const checked = route.value && route.value.split('~').includes(
                        IS_ALL_MODE ? qualifiedId : s.number,
                      );
                      return (
                        <li key={qualifiedId}>
                          <a
                            href={IS_ALL_MODE && s.city
                              ? `#/all/services/${s.city}^${encodeURIComponent(s.number)}`
                              : `#${route.cityPrefix}/services/${encodeURIComponent(s.number)}`}
                            class={checked ? 'current' : ''}
                            onMouseEnter={() => previewRoute(s.number)}
                            onMouseLeave={unpreviewRoute}
                          >
                            <b class="service-tag">{s.number}</b> {s.name}
                          </a>
                          <label hidden={!isServicePage}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                const { checked } = e.target;
                                let newServices = [];
                                if (checked) {
                                  newServices = route.value
                                    .split('~')
                                    .concat(qualifiedId);
                                } else {
                                  newServices = route.value
                                    .split('~')
                                    .filter((service) => service !== qualifiedId);
                                }
                                newServices.sort(sortServices);
                                setTimeout(() => {
                                  if (newServices.length) {
                                    navigateTo(
                                      `/services/${newServices.map((s) => encodeURIComponent(s)).join('~')}`,
                                      route,
                                    );
                                  } else if (IS_ALL_MODE) {
                                    location.hash = '/all/';
                                  } else {
                                    navigateTo('/', route);
                                  }
                                }, 250);
                              }}
                            />
                          </label>
                        </li>
                      );
                    })}
                  </Fragment>
                ))
              : !searching &&
                (!IS_ALL_MODE || !allModePreindexed) &&
                !closestStops.length &&
                [1, 2, 3, 4, 5, 6, 7, 8].map((s, i) => (
                  <li key={s}>
                    <a href={`#${route.cityPrefix}/`}>
                      <b class="service-tag">&nbsp;&nbsp;&nbsp;</b>
                      <span class="placeholder">
                        █████{i % 3 == 0 ? '███' : ''} ███
                        {i % 2 == 0 ? '████' : ''}
                      </span>
                    </a>
                  </li>
                ))}
            {searching &&
              !!stops.length &&
              (IS_ALL_MODE ? groupByCity(stops) : [{ city: null, items: stops }]).map(
                (group) => (
                  <Fragment key={group.city ?? 'stops'}>
                    {group.city && (
                      <li class="popover-city-header">
                        <strong>{cityDisplayName(group.city)}</strong>
                      </li>
                    )}
                    {group.items.map((s) => (
                      <li key={IS_ALL_MODE && s.city ? `${s.city}^${s.number}` : s.number}>
                        <a
                          href={IS_ALL_MODE && s.city
                            ? `#/all/stops/${s.city}^${s.number}`
                            : `#${route.cityPrefix}/stops/${s.number}`}
                          onClick={(e) => {
                            if (directionsOrigin || editingBetweenStop) {
                              e.preventDefault();
                              selectDirectionsDestination(s.number, s.city);
                            }
                          }}
                        >
                          <b class="stop-tag">{s.number}</b>
                          <span class="stop-name-with-suffix">
                            <span class="stop-name">{s.name}</span>
                            {s.suffix && <span class="stop-suffix">{s.suffix}</span>}
                          </span>
                        </a>
                      </li>
                    ))}
                  </Fragment>
                ),
              )}
            {searching && !stops.length && !services.length && (
              <li class="nada">No results.</li>
            )}
          </ul>
        </div>
      </div>
      <div
        id="stop-popover"
        ref={stopPopover}
        class={`popover ${showStopPopover ? 'expand' : ''} ${
          showStopPopover && paneAppliesHere(supportsTouch, BREAKPOINT) ? 'pane-managed' : ''
        }`}
      >
        <div class="popover-handle">
          <span></span>
        </div>
        {stopPopoverData && (
          <>
            <a
              href={`#${route.cityPrefix}/`}
              onClick={hideStopPopover}
              class="popover-close"
            >
              &times;
            </a>
            <header>
              {(stopPopoverLoading || stopPopoverError) && (
                <span
                  class={`live-data-loading-container ${
                    stopPopoverError ? 'error' : ''
                  }`}
                  title={
                    stopPopoverError
                      ? 'Live data unavailable. Estimated based on timetable schedule.'
                      : 'Fetching live information'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    const container = e.currentTarget;
                    container.classList.toggle('show-tooltip');
                    const closeTooltip = (event) => {
                      if (!container.contains(event.target)) {
                        container.classList.remove('show-tooltip');
                        document.removeEventListener('click', closeTooltip);
                      }
                    };
                    setTimeout(() => {
                      document.addEventListener('click', closeTooltip);
                    }, 0);
                  }}
                >
                  {stopPopoverError ? (
                    <span class="live-data-warning">⚠</span>
                  ) : (
                    <span class="live-data-loading" />
                  )}
                </span>
              )}
              <div class="stop-header-row">
                <h1 onClick={() => zoomToStop(stopPopoverData.number)}>
                  {!getConfigForCity(stopPopoverData.city || city)?.disableStopID && (
                    <b class="stop-tag">{stopPopoverData.number}</b>
                  )}
                  <span class="stop-name-with-suffix">
                    <span class="stop-name">{stopPopoverData.name}</span>
                    {stopPopoverData.suffix && (
                      <span class="stop-suffix">{stopPopoverData.suffix}</span>
                    )}
                  </span>
                </h1>
                {isAlphaEnabled() && (
                  <button
                    class="directions-btn"
                    title="Directions"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDirectionsOrigin(stopPopoverData);
                      hideStopPopover();
                      setShrinkSearch(false);
                    }}
                  >
                    {DIRECTIONS_SVG}
                  </button>
                )}
              </div>
            </header>
            {stopPopoverData.services.length > 0 && (
              <div class="dest-filter-wrapper">
                <div class="dest-filter-row">
                  <svg
                    class="dest-filter-icon"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    width="16"
                    height="16"
                    aria-hidden="true"
                  >
                    <path
                      fill-rule="evenodd"
                      d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
                      clip-rule="evenodd"
                    />
                  </svg>
                  <div class="dest-filter-input-wrapper">
                    <input
                      type="search"
                      class="dest-filter"
                      placeholder="Search for stop…"
                      value={stopPopoverDestFilter}
                      onInput={(e) => {
                        setStopPopoverDestFilter(e.target.value);
                        setStopPopoverDestFilterExact(false);
                      }}
                    />
                    {stopPopoverDestFilter && (
                      <button
                        class="dest-filter-clear"
                        onClick={() => {
                          setStopPopoverDestFilter('');
                          setStopPopoverDestFilterExact(false);
                        }}
                        aria-label="Clear search"
                      >
                        <svg
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          width="16"
                          height="16"
                        >
                          <path
                            fill-rule="evenodd"
                            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                            clip-rule="evenodd"
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
            <ScrollableContainer class="popover-scroll" overflow-y="true">
              <BusServicesArrival
                active={showStopPopover}
                map={map}
                showBusesOnMap={route.page !== 'service'}
                id={stopPopoverData.number}
                services={stopPopoverData.services}
                stopData={stopPopoverData}
                cityCode={stopPopoverData.city || undefined}
                stopsData={IS_ALL_MODE && stopPopoverData.city
                  ? cityDataMap.get(stopPopoverData.city)?.stopsData
                  : undefined}
                onLoadingChange={(loading) => {
                  setStopPopoverLoading(loading);
                  if (loading) {
                    setStopPopoverError(false);
                  }
                }}
                onErrorChange={setStopPopoverError}
                cancelRef={stopPopoverCancelRef}
                destFilter={stopPopoverDestFilter}
                destFilterExact={stopPopoverDestFilterExact}
                onDestFilterChange={(value, exact = false) => {
                  setStopPopoverDestFilter(value);
                  setStopPopoverDestFilterExact(exact);
                }}
              />
            </ScrollableContainer>
            {renderStopFooter()}
          </>
        )}
      </div>
      {/* Mobile-only always-on-screen twin of the footer above — see
          renderStopFooter's comment for why the nested one can end up
          permanently below the fold once pane-managed. */}
      {stopPopoverData && (
        <div
          class={`mobile-floating-footer ${
            showStopPopover && !stopPaneAtBottom ? 'show' : ''
          }`}
        >
          {renderStopFooter()}
        </div>
      )}
      {isAlphaEnabled() && (
        <div
          ref={locationPopover}
          id="location-popover"
          class={`popover ${showLocationPopover ? 'expand' : ''} ${
            showLocationPopover && paneAppliesHere(supportsTouch, BREAKPOINT) ? 'pane-managed' : ''
          }`}
        >
          <div class="popover-handle">
            <span></span>
          </div>
          <a
            href={`#${route.cityPrefix}/`}
            onClick={hideLocationPopover}
            class="popover-close"
          >
            &times;
          </a>
          {locationPopoverData && (
            <>
              <header>
                <h1>
                  <b class="location-tag">{'●'}</b>
                  {locationPopoverData.name || 'Locating…'}
                  {isAlphaEnabled() && (
                    <button
                      class="directions-btn"
                      title="Directions"
                      onClick={(e) => {
                        e.stopPropagation();
                        startDirectionsFromLocation(locationPopoverData);
                      }}
                    >
                      {DIRECTIONS_SVG}
                    </button>
                  )}
                </h1>
              </header>
              <div class="popover-scroll" overflow-y="true">
                {locationPopoverLoading && (
                  <p class="placeholder">Finding nearby stops&hellip;</p>
                )}
                {!locationPopoverLoading && !locationPopoverStops.length && (
                  <p class="nada">No nearby stops found.</p>
                )}
                {locationPopoverStops.map((stop) => (
                  <div class="location-nearby-stop" key={IS_ALL_MODE ? `${stop.city}^${stop.number}` : stop.number}>
                    <h3
                      onClick={() => {
                        hideLocationPopover();
                        if (IS_ALL_MODE && stop.city) {
                          location.hash = `#/all/stops/${stop.city}^${stop.number}`;
                        } else {
                          _showStopPopover(stop.number);
                        }
                      }}
                    >
                      <b class="stop-tag">{stop.number}</b> {stop.name}
                    </h3>
                    <div class="location-service-list">
                      {(stop.services || []).map((svc) => (
                        <a
                          key={svc}
                          href={IS_ALL_MODE && stop.city
                            ? `#/all/services/${stop.city}^${encodeURIComponent(svc)}`
                            : `#${route.cityPrefix}/services/${encodeURIComponent(svc)}`}
                          class="service-tag"
                        >
                          {svc}
                        </a>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <div
        ref={servicePopover}
        id="service-popover"
        class={`popover ${showServicePopover ? 'expand' : ''} ${
          showServicePopover && !showStopPopover && paneAppliesHere(supportsTouch, BREAKPOINT)
            ? 'pane-managed'
            : ''
        } ${
          isAlphaEnabled() && routeServices.length > 0 ? 'has-floating-footer' : ''
        }`}
        key={``}
      >
        <div class="popover-handle">
          <span></span>
        </div>
        <a
          href={`#${route.cityPrefix}/`}
          onClick={navBackToStop}
          class="popover-close"
        >
          &times;
        </a>
        {routeServices.length &&
          (IS_ALL_MODE
            ? cityDataMap.get(route.value?.split('^')[0])?.servicesData?.[routeServices[0]]
            : servicesData[routeServices[0]]) &&
          (() => {
            // Service numbers aren't unique across cities — in all-mode, look
            // this up in the current city's own servicesData (like stopsData
            // below already does) rather than the module-level `servicesData`,
            // which merges every city touched this session and can silently
            // collide when two cities reuse the same service number.
            const serviceData = IS_ALL_MODE
              ? cityDataMap.get(route.value?.split('^')[0])?.servicesData?.[routeServices[0]]
              : servicesData[routeServices[0]];
            // Extract routes from all destinations
            const routes = [];
            Object.keys(serviceData).forEach((key) => {
              if (key !== 'name') {
                const destinationRoutes = serviceData[key];
                if (
                  Array.isArray(destinationRoutes) &&
                  destinationRoutes.length > 0
                ) {
                  routes.push(...destinationRoutes);
                }
              }
            });

            return (
              <>
                <header>
                  <h1>
                    <b class="service-tag">{routeServices[0]}</b>
                    {serviceData.name}
                  </h1>
                </header>
                <ScrollableContainer
                  class="popover-scroll"
                  overflow-y="true"
                  scrollToTopKey={`sttk-${routeServices[0]}`}
                >
                  <h2>
                    {t('glossary.nRoutes', {
                      count: routes.length,
                    })}{' '}
                    ∙{' '}
                    {routes
                      .map((route) =>
                        t('glossary.nStops', { count: route.length }),
                      )
                      .join(' ∙ ')}
                    &nbsp;&nbsp;
                    <button
                      type="button"
                      class="plus"
                      onClick={() => {
                        setExpandSearch(true);
                        setExpandedSearchOnce(true);
                      }}
                      title={t('multiRoute.addRoute')}
                    />
                  </h2>
                  <StopsList
                    routes={routes}
                    stopsData={IS_ALL_MODE
                      ? (cityDataMap.get(route.value?.split('^')[0])?.stopsData ?? stopsData)
                      : stopsData}
                    cityCode={IS_ALL_MODE ? route.value?.split('^')[0] : undefined}
                    vehicles={routeVehicles}
                    onVehicleClick={(vehicleId) =>
                      setFollowedVehicleId(vehicleId)
                    }
                  />
                </ScrollableContainer>
                {renderServiceFooter()}
              </>
            );
          })()}
      </div>
      {/* Mobile-only always-on-screen twin — see renderStopFooter's comment. */}
      {isAlphaEnabled() && routeServices.length > 0 && (
        <div
          class={`mobile-floating-footer ${
            showServicePopover && !showStopPopover && !servicePaneAtBottom ? 'show' : ''
          }`}
        >
          {renderServiceFooter()}
        </div>
      )}
      <div
        id="between-popover"
        ref={betweenPopover}
        class={`popover ${(IS_ALL_MODE ? allModeBetween : showBetweenPopover) ? 'expand' : ''} ${
          betweenShown && paneAppliesHere(supportsTouch, BREAKPOINT) ? 'pane-managed' : ''
        }`}
      >
        <div class="popover-handle">
          <span></span>
        </div>
        {(() => {
          // Both modes lag one render behind their "live" open state (see
          // betweenPopoverData/allModeBetweenData's own effects) so content
          // doesn't vanish mid-close-transition \u2014 same shape either way:
          // {startStop, endStop, startLocation, endLocation, ...mode-specific}.
          const data = IS_ALL_MODE ? allModeBetweenData : betweenPopoverData;
          if (!data) return null;
          const { startStop, endStop, startLocation, endLocation } = data;

          // route.cityPrefix is already `/all` whenever IS_ALL_MODE is true
          // (the city segment of the URL literally is "all"), so most
          // hash-building below doesn't need to branch on mode at all.
          const tokenFor = (stop, loc) => {
            if (loc) return encodeBetweenToken({ type: 'location', lat: loc.lat, lon: loc.lon });
            return IS_ALL_MODE ? `${stop.city}^${stop.number}` : stop.number;
          };

          const editStop = (role) => {
            const fixedIsOrigin = role !== 'origin';
            const fixedStop = fixedIsOrigin ? startStop : endStop;
            const fixedLocation = fixedIsOrigin ? startLocation : endLocation;
            setEditingBetweenStop({
              role,
              fixedStop: tokenFor(fixedStop, fixedLocation),
              label: fixedLocation?.name || fixedStop.name || fixedStop.number,
            });
            setShrinkSearch(false);
            navigateTo('/', route);
          };

          const startLabel = startLocation?.name || startStop?.name || 'Selected Location';
          const endLabel = endLocation?.name || endStop?.name || 'Selected Location';
          const canSwap = !IS_ALL_MODE || (!data.loading && startStop && endStop);

          return [
            <a
              href={betweenSelectedIdx != null ? betweenListHref : `#${route.cityPrefix}/`}
              onClick={() => {
                if (betweenSelectedIdx != null) return;
                if (IS_ALL_MODE) setAllModeBetween(null);
                else resetStartEndStops();
              }}
              class="popover-close"
            >
              &times;
            </a>,
            <header>
              <div class="between-header-row">
                <div class="between-header-stops">
                  <button class="between-stop-edit" title="Change origin" onClick={() => editStop('origin')}>
                    {startLabel}
                  </button>
                  <span class="between-stop-arrow">{'\u2192'}</span>
                  <button class="between-stop-edit" title="Change destination" onClick={() => editStop('destination')}>
                    {endLabel}
                  </button>
                </div>
                {canSwap && (
                  <button
                    class="between-swap-btn"
                    title="Swap origin and destination"
                    onClick={() => {
                      location.hash = `${route.cityPrefix}/between/${tokenFor(endStop, endLocation)}~${tokenFor(startStop, startLocation)}`;
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                  </button>
                )}
              </div>
            </header>,
            <div class="popover-scroll" overflow-y="true">
              {IS_ALL_MODE && data.loading && (
                <div class="between-block between-nada">Finding routes…</div>
              )}
              {IS_ALL_MODE && !data.loading && data.error && (
                <div class="between-block between-nada">{data.error}</div>
              )}
              {(!IS_ALL_MODE || (!data.loading && !data.error)) && (
                <BetweenRoutes
                  results={IS_ALL_MODE ? undefined : (data.results || [])}
                  itineraries={IS_ALL_MODE ? data.itineraries : undefined}
                  stopsData={IS_ALL_MODE ? undefined : stopsData}
                  cityDataMap={IS_ALL_MODE ? cityDataMap : undefined}
                  arrivalData={data.arrivalData}
                  staticFrequency={data.staticFrequency}
                  startStop={startStop}
                  endStop={endStop}
                  startLocation={startLocation}
                  endLocation={endLocation}
                  selectedIndex={betweenSelectedIdx}
                  getServiceHref={
                    IS_ALL_MODE
                      ? (service, city) => `#/all/services/${city}^${encodeURIComponent(service)}`
                      : (service) => `#${route.cityPrefix}/services/${encodeURIComponent(service)}`
                  }
                  onClickRoute={(e, itinerary, i) => {
                    renderBetweenItinerary(itinerary, IS_ALL_MODE ? {
                      e,
                      resolveStop: allModeResolveStop,
                      getServicePolylines: allModeGetServicePolylines,
                    } : {
                      e,
                      resolveStop: legacyResolveStop,
                      getServicePolylines: legacyGetServicePolylines,
                      literalStartStop: startStop,
                      literalEndStop: endStop,
                    });
                    location.hash = `${betweenListUrl}/${i + 1}`;
                  }}
                />
              )}
            </div>,
          ];
        })()}
      </div>
      {(directionsOrigin || editingBetweenStop) && (() => {
        const isEditingOrigin = editingBetweenStop?.role === 'origin';
        const label = editingBetweenStop?.label
          || directionsOrigin?.name || directionsOrigin?.number || 'Selected Location';
        return (
          <div class="directions-banner">
            <div class="directions-banner-inner">
              {DIRECTIONS_SVG}
              <span>
                {isEditingOrigin
                  ? <>{'Select origin \u2192 '}<b>{label}</b></>
                  : <><b>{label}</b>{' \u2192 Select destination'}</>}
              </span>
              {currentLocation && (
                <button
                  class="directions-banner-mylocation"
                  title="Use my location"
                  onClick={() => {
                    const [lng, lat] = currentLocation;
                    finishDirectionsPick({ type: 'location', lat, lon: lng });
                  }}
                  dangerouslySetInnerHTML={{ __html: GEOLOCATE_SVG }}
                />
              )}
              <button
                class="directions-banner-close"
                onClick={() => {
                  setDirectionsOrigin(null);
                  setEditingBetweenStop(null);
                }}
                aria-label="Cancel"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
              </button>
            </div>
          </div>
        );
      })()}
    </>
  );
};

render(<App />, document.getElementById('app'));

if (
  'serviceWorker' in navigator &&
  window.location.hostname !== 'localhost' &&
  window.location.hostname !== '127.0.0.1'
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(
      new URL('../service-worker.js', import.meta.url),
      { type: 'module' },
    );
  });
} else if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => registration.unregister());
  });
}

if (window.navigator.standalone) {
  document.body.classList.add('standalone');

  // Refresh map size when dismissing software keyboard
  // https://stackoverflow.com/a/19464029/20838
  document.addEventListener('focusout', () => {
    if (_map) _map.resize();
  });

  // Enable CSS active states
  document.addEventListener('touchstart', () => {}, false);
}

const isSafari = navigator.vendor && navigator.vendor.indexOf('Apple') !== -1;
if (isSafari && !window.navigator.standalone) {
  setTimeout(function () {
    const ratio = window.devicePixelRatio;
    const canvas = document.createElement('canvas');
    const w = (canvas.width = window.screen.width * ratio);
    const h = (canvas.height = window.screen.height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F9F5ED';
    ctx.fillRect(0, 0, w, h);
    const icon = new Image();
    icon.onload = () => {
      const aspectRatio = icon.width / icon.height;
      icon.width = w / 2;
      icon.height = w / 2 / aspectRatio;
      ctx.drawImage(
        icon,
        (w - icon.width) / 2,
        (h - icon.height) / 2,
        icon.width,
        icon.height,
      );
      document.head.insertAdjacentHTML(
        'beforeend',
        `<link rel="apple-touch-startup-image" href="${canvas.toDataURL()}">`,
      );
    };
    icon.src = iconSVGPath;
  }, 5000);
}
