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
import { getApiUrl, isDevMode, isAlphaEnabled } from './city-config';
import { normalizeName } from './utils/normalizeNames';
import {
  pointDistance,
  closestPointOnSegment,
  findClosestPointOnPolyline,
  cropPolylineFromPoint,
  cropPolylineBetweenPoints,
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
} from './utils/workerClient';

import { encode, decode } from './utils/specialID';
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
  batchClearSources,
  rafThrottle,
  replaceFeatureStates,
  createFeaturesOptimized,
} from './utils/mapOptimizations';

import BusServicesArrival from './components/BusServicesArrival';
import { CLOSE_SVG } from './components/CloseControl';
import GeolocateControl, { GEOLOCATE_SVG } from './components/GeolocateControl';
import BetweenRoutes from './components/BetweenRoutes';
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

const city = getCurrentCity();
const dataPath = `/data/${city}`;
const routesJSONPath = `${dataPath}/routes.min.json`;
const stopsJSONPath = `${dataPath}/stops.min.json`;
const servicesJSONPath = `${dataPath}/services.min.json`;
const railJSONPath = `${dataPath}/rail.json`;

const $map = document.getElementById('map');
const STORE = {};
const BREAKPOINT = () => window.innerWidth > 640;
const supportsHover =
  window.matchMedia && matchMedia('(any-hover: hover)').matches;
const supportsTouch =
  (window.matchMedia && matchMedia('(any-pointer: coarse)').matches) ||
  'ontouchstart' in window ||
  navigator.MaxTouchPoints > 0 ||
  navigator.msMaxTouchPoints > 0;
const ruler = new CheapRuler(1.3);

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

// ── Popover drag-to-snap (mobile) ──────────────────────────────────────────
function initPopoverDrag(popoverEl, onDismiss) {
  if (!supportsTouch || BREAKPOINT()) return;

  const handle = popoverEl.querySelector('.popover-handle');
  if (!handle) return;

  let startY, startH, dragging, lastY, lastTime, velocity;
  const vh = () => window.innerHeight;

  const onStart = (e) => {
    if (!popoverEl.classList.contains('expand')) return;
    const touch = e.touches[0];
    startY = touch.clientY;
    startH = popoverEl.getBoundingClientRect().height;
    lastY = startY;
    lastTime = Date.now();
    velocity = 0;
    dragging = true;
    popoverEl.classList.add('dragging');
    // Attach move/end listeners only for the duration of this drag so that
    // passive:false on touchmove doesn't block scrolling when no drag is active.
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
  };

  const onMove = (e) => {
    if (!dragging) return;
    e.preventDefault();
    const touch = e.touches[0];
    const y = touch.clientY;
    const delta = y - startY;
    const newH = Math.max(50, Math.min(vh() - 40, startH - delta));
    popoverEl.style.maxHeight = newH + 'px';
    // Also update transform so the popover bottom stays anchored to viewport bottom
    popoverEl.style.transform =
      'translateY(calc(-' + newH + 'px - var(--keyboard-height, 0px)))';

    const now = Date.now();
    const dt = now - lastTime;
    if (dt > 10) {
      velocity = (y - lastY) / dt; // px/ms — positive = downward
      lastY = y;
      lastTime = now;
    }
  };

  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
    document.removeEventListener('touchcancel', onEnd);

    const currentH = popoverEl.getBoundingClientRect().height;
    popoverEl.style.maxHeight = '';
    popoverEl.style.transform = '';
    popoverEl.classList.remove('dragging');
    popoverEl.classList.remove('snap-full', 'snap-collapsed');

    const v = vh();
    const ratio = currentH / v;
    const fast = Math.abs(velocity) > 0.4;

    if (fast && velocity > 0.4) {
      // Fast swipe down
      if (ratio > 0.3) {
        popoverEl.classList.add('snap-collapsed');
      } else {
        onDismiss?.();
      }
    } else if (fast && velocity < -0.4) {
      // Fast swipe up
      popoverEl.classList.add('snap-full');
    } else {
      // Snap by position
      if (ratio > 0.65) {
        popoverEl.classList.add('snap-full');
      } else if (ratio < 0.2) {
        onDismiss?.();
      } else if (ratio < 0.35) {
        popoverEl.classList.add('snap-collapsed');
      }
      // else mid (default, no class)
    }
  };

  handle.addEventListener('touchstart', onStart, { passive: true });
}

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

// Auto-locate nearest city when default is "auto" and user is at root
if (
  localStorage.getItem('defaultCity') === 'auto' &&
  (!location.hash || location.hash === '#' || location.hash === '#/')
) {
  navigator.geolocation?.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
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
      // If no city bbox contains the user, fall back to FALLBACK_CITY (blr)
      if ((nearest || city) !== city) {
        location.hash = `/${nearest}/`;
        location.reload();
      }
    },
    () => {},
    { timeout: 5000 },
  );
}

let rafST;
const rafScrollTop = () => {
  window.scrollTo(0, 0);
  rafST = requestAnimationFrame(rafScrollTop);
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
let servicesData;
let stopsData = {};
let routesData;

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
  const [searching, setSearching] = useState(false);
  const [expandSearch, setExpandSearch] = useState(false);
  const [expandedSearchOnce, setExpandedSearchOnce] = useState(false);
  const [shrinkSearch, setShrinkSearch] = useState(false);
  const [stopPopoverData, setStopPopoverData] = useState(null);
  const [showStopPopover, setShowStopPopover] = useState(false);
  const [showServicePopover, setShowServicePopover] = useState(false);
  const [stopPopoverLoading, setStopPopoverLoading] = useState(false);
  const [stopPopoverError, setStopPopoverError] = useState(false);
  const [intersectStops, setIntersectStops] = useState(0);
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
  const [betweenStartStop, setBetweenStartStop] = useState(null);
  const [betweenEndStop, setBetweenEndStop] = useState(null);
  const [directionsOrigin, setDirectionsOrigin] = useState(null);
  const [editingBetweenStop, setEditingBetweenStop] = useState(null);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [closestStops, setClosestStops] = useState([]);

  const prevStopNumber = useRef(null);
  const servicesList = useRef(null);
  const searchField = useRef(null);
  const searchPopover = useRef(null);
  const stopPopover = useRef(null);
  const floatPill = useRef(null);
  const betweenPopover = useRef(null);
  const servicePopover = useRef(null);
  const vehicleTracker = useRef(null);
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

  let labelLayerId;

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
    rafScrollTop();
    searchPopover.current?.addEventListener('transitionend', (e) => {
      cancelAnimationFrame(rafST);
    }, { once: true });
  };

  // Debounced search — runs in the data worker to keep the main thread free.
  // A monotonic sequence number guards against out-of-order responses from
  // back-to-back debounce firings.
  const searchSeq = useRef(0);
  const performSearch = useCallback(
    debounce(async (value) => {
      if (value) {
        const seq = ++searchSeq.current;
        const { services, stops } = await workerSearch(value);
        if (seq !== searchSeq.current) return; // stale — a newer query is in flight
        setServices(services);
        setStops(stops);
        setSearching(true);
        // Scroll to top, with hack for momentum scrolling
        // https://popmotion.io/blog/20170704-manually-set-scroll-while-ios-momentum-scroll-bounces/
        if (servicesList.current) {
          servicesList.current.style['-webkit-overflow-scrolling'] = 'auto';
          servicesList.current.scrollTop = 0;
          servicesList.current.style['-webkit-overflow-scrolling'] = null;
        }
      } else {
        setServices(servicesDataArr);
        // Show closest stops if location is available, otherwise empty
        setStops(currentLocation ? closestStops : []);
        setSearching(false);
      }
    }, 150),
    [],
  );

  const handleSearch = (e) => {
    const { value } = (e && e.target) || searchField;
    // Immediately show searching state for better UX
    if (value && !searching) {
      setSearching(true);
    }
    performSearch(value);
  };

  const handleSearchClose = () => {
    setExpandSearch(false);
    $map.classList.remove('fade-out');
    resetSearch();
  };

  const resetSearch = () => {
    searchField.current?.blur();
    searchField.current.value = '';
    setSearching(false);
    setServices(servicesDataArr);
    // Show closest stops if location is available, otherwise empty
    setStops(currentLocation ? closestStops : []);
  };

  const handleServicesScroll = () => {
    if (expandSearch || expandedSearchOnce) return;
    setExpandSearch(true);
    setExpandedSearchOnce(true);
    // $map.classList.add('fade-out');
  };

  // Update closest stops whenever location changes — runs in the data worker.
  useEffect(() => {
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

  const _showStopPopover = useCallback((number) => {
    const stopData = stopsData[number];
    const { services, coordinates, name } = stopData;

    const popoverHeight = stopPopover.current?.offsetHeight;
    const offset = BREAKPOINT() ? [0, 0] : [0, -popoverHeight / 2];
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

    if (prevStopNumber.current) {
      map.setFeatureState(
        {
          source: 'stops',
          id: encode(prevStopNumber.current),
        },
        {
          selected: false,
        },
      );
      map.setFeatureState(
        {
          source: 'stops-highlight',
          id: encode(prevStopNumber.current),
        },
        {
          selected: false,
        },
      );
    }
    map.setFeatureState(
      {
        source: 'stops',
        id: encode(number),
      },
      {
        selected: true,
      },
    );
    map.setFeatureState(
      {
        source: 'stops-highlight',
        id: encode(number),
      },
      {
        selected: true,
      },
    );

    setShrinkSearch(true);
    prevStopNumber.current = number;
    setShowStopPopover(true);
    setStopPopoverData(stopData);

    requestAnimationFrame(() => {
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
      map.setFeatureState(
        {
          source: 'stops',
          id: encode(number),
        },
        {
          selected: false,
        },
      );
      map.setFeatureState(
        {
          source: 'stops-highlight',
          id: encode(number),
        },
        {
          selected: false,
        },
      );
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
    setTimeout(() => {
      stopToBeHighlighted?.classList.remove('flash');
    }, 1000);
  };

  const navBackToStop = (e) => {
    if (prevRoute?.page === 'stop') {
      e.preventDefault();
      history.back();
    }
  };

  const zoomToStop = (num) => {
    const number = num || stopPopoverData?.number;
    const { coordinates } = stopsData[number];
    let offset = BREAKPOINT()
      ? [0, 0]
      : [0, -stopPopover.current.offsetHeight / 2];
    if (showServicePopover) {
      offset = BREAKPOINT()
        ? [-servicePopover.current.offsetWidth / 3, 0]
        : [0, -servicePopover.current.offsetHeight / 2];
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
    // Navigate to the service route with city prefix
    navigateTo(`/services/${encodeURIComponent(service)}`, route);
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
        const { routes } = servicesData[service];
        const coordinates = routes[0]
          .concat(routes[1] || [])
          .map((stop) => stopsData[stop].coordinates);
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

    // Auto-select first result
    setTimeout(() => {
      const firstResult = betweenPopover.current.querySelector('.between-item');
      firstResult.click();
    }, 300);
  };

  const cannotPreviewRoute = () => {
    const { page, subpage, value } = route;
    return (
      subpage === 'routes' ||
      (page === 'service' && value.split('~').length > 1)
    );
  };

  const previewRoute = (service) => {
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

  const renderBetweenRoute = ({ e, startStop, endStop, result }) => {
    if (!result?.startRoute || !startStop?.coordinates || !endStop?.coordinates)
      return;

    // Selection highlighting
    const clickedItem = e.target.closest('.between-item');
    if (clickedItem) {
      const container = clickedItem.closest('.between-block');
      if (container) {
        container.querySelectorAll('.between-item').forEach((el) => {
          el.classList.toggle('selected', el === clickedItem);
        });
      }
    }

    const isValidCoords = (coords) =>
      Array.isArray(coords) &&
      coords.length >= 2 &&
      typeof coords[0] === 'number' &&
      !isNaN(coords[0]) &&
      typeof coords[1] === 'number' &&
      !isNaN(coords[1]);

    // Build stops for map markers
    const stops = [];
    const addStop = (stop, type) => {
      if (stop?.coordinates && isValidCoords(stop.coordinates)) {
        stops.push({ ...stop, _type: type });
      }
    };

    // User-selected origin and destination always get 'end' (destination pin)
    addStop(startStop, 'end');
    addStop(endStop, 'end');

    // Nearby route stops get 'intersect' — they are intermediate boarding/alighting
    // points, not the actual origin/destination the user selected
    if (
      result.startStop &&
      String(result.startStop.number) !== String(startStop.number)
    ) {
      addStop(result.startStop, 'intersect');
    }
    if (
      result.endStop &&
      String(result.endStop.number) !== String(endStop.number)
    ) {
      addStop(result.endStop, 'intersect');
    }

    // Transfer stops between services
    if (result.stopsBetween?.length) {
      result.stopsBetween.forEach((number) => {
        addStop(stopsData[number], 'intersect');
      });
    }

    // Update stops-highlight source
    const stopsHighlightSource = map.getSource('stops-highlight');
    if (stopsHighlightSource) {
      stopsHighlightSource.setData({
        type: 'FeatureCollection',
        features: stops.map((stop) => ({
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
      const getRouteSegment = (routeKey, fromCoords, toCoords) => {
        if (!isValidCoords(fromCoords) || !isValidCoords(toCoords)) return null;
        const service = routeKey?.split('|')[0];
        const servicePolylines = routesData?.[service];
        if (!service || !servicePolylines?.length) return null;

        try {
          // Find the polyline variant whose shape best matches both endpoints
          let bestCropped = null;
          let bestDistance = Infinity;

          for (let i = 0; i < servicePolylines.length; i++) {
            const polyline = decodePolyline(servicePolylines[i]);
            if (!polyline?.coordinates?.length) continue;

            const startClosest = findClosestPointOnPolyline(
              fromCoords,
              polyline.coordinates,
            );
            const endClosest = findClosestPointOnPolyline(
              toCoords,
              polyline.coordinates,
            );
            if (!startClosest.point || !endClosest.point) continue;

            const totalDist = startClosest.distance + endClosest.distance;
            if (totalDist < bestDistance) {
              bestDistance = totalDist;
              const cropped = cropPolylineBetweenPoints(
                polyline.coordinates,
                fromCoords,
                toCoords,
              );
              if (
                Array.isArray(cropped) &&
                cropped.length >= 2 &&
                cropped.every((c) => Array.isArray(c) && c.length >= 2)
              ) {
                bestCropped = cropped;
              }
            }
          }

          if (bestCropped) {
            return { type: 'LineString', coordinates: bestCropped };
          }
        } catch (err) {
          console.warn(`Failed to render segment for ${routeKey}:`, err);
        }
        return null;
      };

      const actualStart =
        result.startStop?.coordinates ? result.startStop : startStop;
      const actualEnd =
        result.endStop?.coordinates ? result.endStop : endStop;

      const geometries = [];

      if (result.endRoute) {
        // Transfer route: find the interchange stop from stopsBetween
        const interchangeNumber = result.stopsBetween?.[0];
        const interchangeStop = interchangeNumber
          ? stopsData[interchangeNumber]
          : null;

        if (interchangeStop?.coordinates) {
          const seg1 = getRouteSegment(
            result.startRoute,
            actualStart.coordinates,
            interchangeStop.coordinates,
          );
          if (seg1) geometries.push(seg1);

          const seg2 = getRouteSegment(
            result.endRoute,
            interchangeStop.coordinates,
            actualEnd.coordinates,
          );
          if (seg2) geometries.push(seg2);
        }
      } else {
        // Direct route
        const seg = getRouteSegment(
          result.startRoute,
          actualStart.coordinates,
          actualEnd.coordinates,
        );
        if (seg) geometries.push(seg);
      }

      // Walking segments for nearby stops
      if (
        result.startStop?.coordinates &&
        String(result.startStop.number) !== String(startStop.number) &&
        startStop.coordinates
      ) {
        geometries.push({
          type: 'LineString',
          coordinates: [result.startStop.coordinates, startStop.coordinates],
        });
      }
      if (
        result.endStop?.coordinates &&
        String(result.endStop.number) !== String(endStop.number) &&
        endStop.coordinates
      ) {
        geometries.push({
          type: 'LineString',
          coordinates: [result.endStop.coordinates, endStop.coordinates],
        });
      }

      // Update routes-between source
      const routesBetweenSource = map.getSource('routes-between');
      if (routesBetweenSource) {
        routesBetweenSource.setData({
          type: 'FeatureCollection',
          features: geometries.map((geometry, i) => {
            let type = 'walk';
            if (i === 0) type = 'start';
            else if (i === 1 && result.endRoute) type = 'end';
            return { type: 'Feature', properties: { type }, geometry };
          }),
        });
      }

      // Fit map bounds
      const bounds = new maplibregl.LngLatBounds();
      let hasValidBounds = false;
      stops.forEach((stop) => {
        if (isValidCoords(stop.coordinates)) {
          bounds.extend(stop.coordinates);
          hasValidBounds = true;
        }
      });
      if (hasValidBounds) {
        map.fitBounds(bounds, {
          padding: BREAKPOINT()
            ? {
                top: 80,
                right: betweenPopover.current?.offsetWidth
                  ? betweenPopover.current.offsetWidth + 80
                  : 80,
                bottom: 80,
                left: 80,
              }
            : {
                top: 80,
                right: 80,
                bottom: betweenPopover.current?.offsetHeight
                  ? betweenPopover.current.offsetHeight + 80
                  : 80,
                left: 80,
              },
        });
      }
    });
  };

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

    // Reset everything
    $map.classList.remove('fade-out');
    setShowStopPopover(false);
    setShowServicePopover(false);
    setShowBetweenPopover(false);
    if (map.getLayer('dim-overlay')) {
      map.setPaintProperty('dim-overlay', 'fill-opacity', 0);
    }

    // Stop vehicle tracking when changing routes
    vehicleTracker.current?.stop();

    // Clear map sources - only clear sources that have data to avoid unnecessary re-renders
    batchClearSources(map, [
      'stops-highlight',
      'routes',
      'routes-path',
      'routes-between',
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
            let routeStops = [...routes[0], ...(routes[1] || [])].filter(
              (el, pos, arr) => arr.indexOf(el) == pos,
            ); // Merge and unique

            // Fit map to route bounds
            const bounds = new maplibregl.LngLatBounds();
            routeStops.forEach((stop) => {
              const { coordinates } = stopsData[stop];
              bounds.extend(coordinates);
            });
            requestAnimationFrame(() => {
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
                      bottom: servicePopover.current.offsetHeight + 20,
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
              const allRoutes = [...routes[0], ...(routes[1] || [])].filter(
                (el, pos, arr) => {
                  return arr.indexOf(el) === pos;
                },
              );
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
          const intersectStops = [];
          routeStops = routeStops.filter((el, pos, arr) => {
            const unique = arr.indexOf(el) === pos;
            if (!unique && !intersectStops.includes(el))
              intersectStops.push(el);
            return unique;
          });
          intersectStops.sort();
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
        const coords = route.value;
        const [rawStartStop, rawEndStop] = coords.split(/[,-]/).map(String);
        const startStopNumber = findStopKey(rawStartStop);
        const endStopNumber = findStopKey(rawEndStop);
        if (!startStopNumber || !endStopNumber) {
          alert('One of the stop numbers are not found.');
          return;
        }

        setHead({
          title: `Routes between ${startStopNumber} and ${endStopNumber} - ${t(
            'app.name',
          )}`,
          url: `/between/${startStopNumber}-${endStopNumber}`,
        });
        // Reset
        setExpandSearch(false);
        setShrinkSearch(true);

        // Hide stops and dim basemap
        map.setLayoutProperty('stops', 'visibility', 'none');
        if (map.getLayer('stops-icon')) {
          map.setLayoutProperty('stops-icon', 'visibility', 'none');
        }
        if (map.getLayer('dim-overlay')) {
          map.setPaintProperty('dim-overlay', 'fill-opacity', isDark ? 0.5 : 0.4);
        }

        // Fetch arrivals for start stop and filter routes
        (async () => {
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
          const {
            routes: allRoutes,
            nearestStartStop,
            nearestEndStop,
          } = await workerBetweenRoutes(
            startStopNumber,
            endStopNumber,
            Array.from(availableServices),
          );

          const startStop = stopsData[startStopNumber];
          const endStop = stopsData[endStopNumber];

          _showBetweenPopover({
            startStop,
            endStop,
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
  const onLoad = async () => {
    window.onhashchange = () => {
      setRoute(getRoute());
      renderRoute();
    };

    const fetchStopsP = fetchCache(stopsJSONPath, CACHE_TIME);
    const fetchServicesP = fetchCache(servicesJSONPath, CACHE_TIME);
    const fetchRoutesP = fetchCache(routesJSONPath, CACHE_TIME);

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

    // Build normalized lookup maps for O(1) key lookups
    buildNormalizedLookupMaps();

    // Transfer data to the worker: it builds Fuse indices and handles all
    // future search, closest-stop, and between-routes requests off-thread.
    const workerReady = initDataWorker({
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

    await new Promise((resolve, reject) => {
      map.once('styledata', () => {
        const layers = map.getStyle().layers;

        labelLayerId = layers.find(
          (l) => l.type == 'symbol' && l.layout['text-field'],
        ).id;

        resolve();
      });
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

    // Add rail source
    map.addSource('rail', {
      type: 'geojson',
      data: railJSONPath,
    });

    // Rail layer specs
    const railLineFilter = ['all', ['==', ['geometry-type'], 'LineString'], ['has', 'stroke']];
    const railLineLayout = { 'line-join': 'round', 'line-cap': 'round' };
    const railInterchangeFilter = ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'interchange'], true]];
    const railStationsFilter = ['all', ['==', ['geometry-type'], 'Point'], ['has', 'name'], ['!=', ['get', 'interchange'], true]];

    const railInterchangeLayout = {
      'icon-image': ['match', ['get', 'mode'], 'metro', 'metro-station', 'monorail', 'monorail-station', 'rail-station'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.45, 22, 0.75],
      'icon-allow-overlap': false,
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 22, 16],
      'text-variable-anchor': ['left', 'right', 'top'],
      'text-radial-offset': 1.1,
      'text-optional': true,
    };
    const railInterchangePaint = {
      'icon-color': C.text,
      ...(isDark && { 'icon-halo-color': '#000', 'icon-halo-width': 0.5, 'icon-halo-blur': 1 }),
      'text-color': C.text,
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
      ...(isDark && { 'icon-halo-color': '#000', 'icon-halo-width': 0.5, 'icon-halo-blur': 1 }),
      'text-color': stationTextColor,
      'text-halo-color': C.textHalo,
      'text-halo-width': C.stationHaloWidth,
    };


    setMapLoaded(true);

    // Init popover drag-to-snap on mobile
    requestIdleCallback(() => {
      initPopoverDrag(stopPopover.current, () => hideStopPopover());
      initPopoverDrag(servicePopover.current, () => {
        setShowServicePopover(false);
      });
      initPopoverDrag(betweenPopover.current, () => resetStartEndStops());
    });
  };

  useEffect(() => {
    onLoad();
  }, []);

  // Reset snap classes when popovers open
  useEffect(() => {
    if (showStopPopover)
      stopPopover.current?.classList.remove('snap-full', 'snap-collapsed');
  }, [showStopPopover]);
  useEffect(() => {
    if (showServicePopover)
      servicePopover.current?.classList.remove('snap-full', 'snap-collapsed');
  }, [showServicePopover]);
  useEffect(() => {
    if (showBetweenPopover)
      betweenPopover.current?.classList.remove('snap-full', 'snap-collapsed');
  }, [showBetweenPopover]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const kh = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty(
        '--keyboard-height',
        `${kh}px`,
      );
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  useEffect(() => {
    if (!mapLoaded) return;
    const mapCanvas = map.getCanvas();

    map.addSource('stops', {
      type: 'geojson',
      tolerance: 10,
      buffer: 0,
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
      ...(isDark && { 'icon-halo-color': '#000', 'icon-halo-width': 0.5, 'icon-halo-blur': 1 }),
      'text-color': C.text,
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
      ...(isDark && { 'icon-halo-color': '#000', 'icon-halo-width': 0.5, 'icon-halo-blur': 1 }),
      'text-color': stationTextColor,
      'text-halo-color': C.textHalo,
      'text-halo-width': C.stationHaloWidth,
    };

    // Rail layers — always above bus stops
    map.addLayer({
      id: 'rail-path',
      type: 'line',
      source: 'rail',
      filter: railLineFilter,
      minzoom: 9,
      layout: railLineLayout,
      paint: {
        'line-color': ['get', 'stroke'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 4, 22, 6],
        'line-opacity': ['match', ['get', 'mode'],
          'monorail', 1,
          'rail', 0.01,
          C.routeLineOpacity,
        ],
      },
    });
    map.addLayer({
      id: 'rail-path-dots',
      type: 'line',
      source: 'rail',
      filter: ['all', ...railLineFilter.slice(1), ['==', ['get', 'mode'], 'rail']],
      minzoom: 9,
      layout: { ...railLineLayout, 'line-cap': 'butt' },
      paint: {
        'line-color': ['get', 'stroke'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 3, 22, 4],
        'line-opacity': 1,
        'line-dasharray': [3, 3],
      },
    });
    map.addLayer(
      {
        id: 'rail-path-case',
        type: 'line',
        source: 'rail',
        filter: railLineFilter,
        minzoom: 9,
        layout: railLineLayout,
        paint: {
          'line-color': ['match', ['get', 'mode'], 'metro', C.stopCircleBg, 'monorail', '#FFF', ['get', 'stroke']],
          'line-width': ['interpolate', ['linear'], ['zoom'],
            16, ['match', ['get', 'mode'], 'monorail', 0.85, 'rail', 5, 9],
            22, ['match', ['get', 'mode'], 'monorail', 12, 'rail', 7, 12],
          ],
          'line-opacity': ['match', ['get', 'mode'], 'monorail', 0.5, 'rail', 0.75, 0.5],
        },
      },
      'rail-path',
    );
    map.addLayer({
      id: 'rail-stations',
      type: 'symbol',
      source: 'rail',
      filter: railStationsFilter,
      minzoom: 11,
      layout: railStationsLayout,
      paint: railStationsPaint,
    });
    map.addLayer({
      id: 'rail-stations-interchange',
      type: 'symbol',
      source: 'rail',
      filter: railInterchangeFilter,
      minzoom: 10,
      layout: railInterchangeLayout,
      paint: railInterchangePaint,
    });

    // Create stops-highlight source and layers BEFORE setting up event handlers
    // that query this layer to avoid "layer does not exist" errors
    map.addSource('stops-highlight', {
      type: 'geojson',
      tolerance: 10,
      buffer: 0,
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

    requestIdleCallback(() => {
      map.on('mouseenter', 'stops', () => {
        mapCanvas.style.cursor = 'pointer';
      });

      if (supportsHover) {
        let lastFeature = null;
        // RAF-throttled mousemove handler for smooth 60fps updates
        const handleMouseMove = rafThrottle((e) => {
          const { point } = e;
          // Build layers array, only including layers that exist
          const queryLayers = ['stops'].filter((layerId) =>
            map.getLayer(layerId),
          );
          // Only add stops-highlight if it exists
          if (map.getLayer('stops-highlight')) {
            queryLayers.push('stops-highlight');
          }
          const features = map.queryRenderedFeatures(point, {
            layers: queryLayers,
            validate: false,
          });
          if (features.length && map.getZoom() < 16 && !map.isMoving()) {
            if (lastFeature && features[0].id === lastFeature.id) {
              return;
            }
            lastFeature = features[0];
            const stopID = decode(features[0].id);
            const data = stopsData[stopID];
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
      }
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
    });

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
            ['*', ['zoom'], -3],
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
            ['*', ['zoom'], -3],
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
          'text-opacity': 0.9,
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
          'text-opacity': 0.9,
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
            ['*', ['zoom'], -3],
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
        'text-opacity': 0.8,
        'text-halo-color': C.textHalo,
        'text-halo-width': 2,
      },
    });

    renderRoute();

    // Re-run search if the user typed something while the worker was initialising
    workerReady.then(() => {
      if (searchField.current?.value) handleSearch();
    });

    // GeolocateControl automatically acquires location on page load if permission is 'granted'
    // The handleLocationUpdate callback will be triggered when location is acquired and marker is rendered
  }, [mapLoaded]);

  const selectDirectionsDestination = (stopNumber) => {
    if (editingBetweenStop) {
      const { role, fixedStop } = editingBetweenStop;
      setEditingBetweenStop(null);
      if (fixedStop != stopNumber) {
        const start = role === 'origin' ? stopNumber : fixedStop;
        const end = role === 'origin' ? fixedStop : stopNumber;
        location.hash = `${route.cityPrefix}/between/${start}-${end}`;
      }
      return true;
    }
    if (!directionsOrigin) return false;
    const originNumber = directionsOrigin.number;
    setDirectionsOrigin(null);
    if (originNumber != stopNumber) {
      location.hash = `${route.cityPrefix}/between/${originNumber}-${stopNumber}`;
    }
    return true;
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
        } else if (selectDirectionsDestination(feature.properties.number)) {
          // Handled by directions mode
        } else {
          if (feature.source == 'stops') {
            navigateTo(`/stops/${feature.properties.number}`, route);
          } else {
            _showStopPopover(feature.properties.number);
          }
        }
      } else {
        if (directionsOrigin !== null) setDirectionsOrigin(null);
        if (editingBetweenStop !== null) setEditingBetweenStop(null);
        const { page, subpage } = route;
        if (page === 'stop' && subpage !== 'routes') {
          navigateTo('/', route);
        } else {
          hideStopPopover();
        }
      }
    };
    map.on('click', handleMapClick);
    return () => map.off('click', handleMapClick);
  }, [mapLoaded, route.page, route.subpage, _showStopPopover, hideStopPopover, directionsOrigin, editingBetweenStop]);

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

  // Initialize vehicle tracker when map loads
  useEffect(() => {
    if (!mapLoaded || !map) return;

    // Create vehicle tracker instance
    const cityConfig = getConfigForCity(route.city);
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
  }, [mapLoaded, route.city]);

  // Auto-start vehicle tracking if a single service route is loaded initially
  useEffect(() => {
    if (!vehicleTracker.current || !mapLoaded || !servicesData) return;

    const currentRoute = getRoute();

    // Check if we're on a service page with a single service
    if (currentRoute.page === 'service' && currentRoute.value) {
      const services = currentRoute.value
        .split('~')
        .map((s) => findServiceKey(s))
        .filter(Boolean);

      // Only start tracking for single service routes
      if (services.length === 1) {
        const service = services[0];
        vehicleTracker.current.start(service);
      }
    }
  }, [mapLoaded, servicesData]);

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
  const showPassingRoutesFloatPill =
    route.page === 'stop' &&
    route.subpage === 'routes' &&
    stopsData &&
    findStopKey(route.value);

  return (
    <>
      <div
        id="search-popover"
        ref={searchPopover}
        class={`popover ${expandSearch ? 'expand' : ''} ${
          shrinkSearch ? 'shrink' : ''
        } ${routeLoading ? 'loading' : ''}`}
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
                    {routeServices.sort(sortServices).map((service) => (
                      <>
                        <a
                          href={`#${route.cityPrefix}/services/${encodeURIComponent(service)}`}
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
                              const newRouteServices = routeServices.filter(
                                (s) => s !== service,
                              );
                              location.hash = `${route.cityPrefix}/services/${newRouteServices.map((s) => encodeURIComponent(s)).join('~')}`;
                              unhighlightRoute();
                            }}
                          >
                            &times;
                          </span>
                        </a>
                      </>
                    ))}
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
                        {intersectStops.map((s) => {
                          const stop = stopsData[s];
                          return (
                            <li key={stop.number}>
                              <a
                                href={`#${route.cityPrefix}/stops/${stop.number}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  zoomToStop(s);
                                }}
                              >
                                <b class="stop-tag">{stop.number}</b>{' '}
                                <span class="stop-name">{stop.name}</span>{' '}
                                {routeServices.length > 2 && (
                                  <span class="services-meta-list">
                                    {stopsData[stop.number].services
                                      .filter((s) => routeServices.includes(s))
                                      .sort(sortServices)
                                      .join(' ')}
                                  </span>
                                )}
                              </a>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </div>
              </>
            )}
            {showPassingRoutesFloatPill && (
              <>
                <div class="service-flex">
                  {(() => {
                    const cityConfig = getConfigForCity(route.city);
                    const disableStopID = cityConfig?.disableStopID || false;

                    if (disableStopID) {
                      return (
                        <div>
                          <h1>
                            <span class="stop-name-with-suffix">
                              <span class="stop-name">
                                {stopsData[route.value].name}
                              </span>
                              {stopsData[route.value].suffix && (
                                <span class="stop-suffix">
                                  {stopsData[route.value].suffix}
                                </span>
                              )}
                            </span>
                          </h1>
                        </div>
                      );
                    } else {
                      return (
                        <>
                          <span class="stop-tag">{route.value}</span>
                          <div>
                            <h1>{stopsData[route.value].name}</h1>
                          </div>
                        </>
                      );
                    }
                  })()}
                </div>
                <div class="services-list" onClick={unhighlightRoute}>
                  <h2>
                    {t('passingRoutes.passingRoutes', {
                      count: stopsData[route.value].services.length,
                    })}{' '}
                    ·{' '}
                    <a
                      href={`#${route.cityPrefix}/services/${stopsData[
                        route.value
                      ].services
                        .sort(sortServices)
                        .map((s) => encodeURIComponent(s))
                        .join('~')}`}
                    >
                      {t('glossary.multiRouteMode')} ⊕
                    </a>
                  </h2>
                  {stopsData[route.value].services
                    .sort(sortServices)
                    .map((service) => (
                      <a
                        href={`#${route.cityPrefix}/services/${encodeURIComponent(service)}`}
                        onClick={(e) => clickRoute(e, service)}
                        onMouseEnter={(e) => highlightRoute(e, service)}
                        onMouseLeave={unhighlightRoute}
                        class="service-tag"
                        data-service={service}
                      >
                        {service}
                      </a>
                    ))}
                </div>
              </>
            )}
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
                disabled={!searching && !services.length}
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
          <ul
            class={`popover-list ${
              services.length ||
              searching ||
              (closestStops.length && !searching)
                ? ''
                : 'loading'
            } ${searching ? 'searching' : ''}`}
            ref={servicesList}
            onScroll={handleServicesScroll}
          >
            {/* Show closest stops first when not searching and location is available */}
            {!searching &&
              closestStops.length > 0 &&
              closestStops.map((s) => (
                <li key={s.number}>
                  <a href={`#${route.cityPrefix}/stops/${s.number}`}>
                    <b class="stop-tag">{s.number}</b>
                    <span class="stop-name-with-suffix">
                      <span class="stop-name">{s.name}</span>
                      {s.suffix && <span class="stop-suffix">{s.suffix}</span>}
                    </span>
                  </a>
                </li>
              ))}
            {services.length
              ? (expandedSearchOnce ? services : services.slice(0, 25)).map(
                  (s) => {
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
                                newServices = route.value
                                  .split('~')
                                  .concat(s.number);
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
                  },
                )
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
                ))}
            {searching &&
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
              ))}
            {searching && !stops.length && !services.length && (
              <li class="nada">No results.</li>
            )}
          </ul>
        </div>
      </div>
      <div
        id="stop-popover"
        ref={stopPopover}
        class={`popover ${showStopPopover ? 'expand' : ''}`}
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
                  {!getConfigForCity(city)?.disableStopID && (
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
            <ScrollableContainer class="popover-scroll">
              <BusServicesArrival
                active={showStopPopover}
                map={map}
                showBusesOnMap={route.page !== 'service'}
                id={stopPopoverData.number}
                services={stopPopoverData.services}
                stopData={stopPopoverData}
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
            <div class="popover-footer">
              <div class="popover-buttons footer-actions">
                <a
                  href={`/arrival/${stopPopoverDestFilter ? `?dest=${encodeURIComponent(stopPopoverDestFilter)}${stopPopoverDestFilterExact ? '&destExact=1' : ''}` : ''}#${route.cityPrefix}/${stopPopoverData.number}`}
                  class="popover-button primary footer-arrivals"
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  {t('glossary.busArrivals')}
                </a>
                {isAlphaEnabled() && (
                  <a
                    href={`/beta/timetable/#${route.cityPrefix}/${stopPopoverData.number}`}
                    class="popover-button footer-secondary"
                    target="_blank"
                    title="Timetable"
                  >
                    {TIMETABLE_SVG}
                  </a>
                )}
                {stopPopoverData.services.length > 1 && (
                  <a
                    href={`#${route.cityPrefix}/stops/${stopPopoverData.number}/routes`}
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
                    href={`/diagram/#${route.cityPrefix}/${stopPopoverData.number}`}
                    class="popover-button footer-secondary"
                    target="_blank"
                    title="Diagram"
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                  </a>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <div
        ref={servicePopover}
        id="service-popover"
        class={`popover ${showServicePopover ? 'expand' : ''}`}
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
        {servicesData &&
          routeServices.length &&
          (() => {
            const serviceData = servicesData[routeServices[0]];
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
                    stopsData={stopsData}
                    vehicles={routeVehicles}
                    onStopClick={_showStopPopover}
                    onVehicleClick={(vehicleId) =>
                      setFollowedVehicleId(vehicleId)
                    }
                  />
                </ScrollableContainer>
                {isAlphaEnabled() && (
                  <div class="popover-footer">
                    <div class="popover-buttons footer-actions">
                      <a
                        href={`/beta/timetable/#${route.cityPrefix}/route/${encodeURIComponent(routeServices[0])}`}
                        class="popover-button footer-arrivals"
                        target="_blank"
                        title="Timetable"
                      >
                        {TIMETABLE_SVG}
                        Timetable
                      </a>
                      <a
                        href={`/beta/visualization/?city=${route.city}#services/${routeServices[0]}`}
                        class="popover-button footer-arrivals"
                        target="_blank"
                        title="3D Visualization"
                      >
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                        3D Visualize
                      </a>
                    </div>
                  </div>
                )}
              </>
            );
          })()}
      </div>
      <div
        id="between-popover"
        ref={betweenPopover}
        class={`popover ${showBetweenPopover ? 'expand' : ''}`}
      >
        <div class="popover-handle">
          <span></span>
        </div>
        {showBetweenPopover && [
          <a
            href={`#${route.cityPrefix}/`}
            onClick={resetStartEndStops}
            class="popover-close"
          >
            &times;
          </a>,
          (() => {
            const { startStop, endStop } = showBetweenPopover;
            const editStop = (role) => {
              const fixed = role === 'origin' ? endStop : startStop;
              setEditingBetweenStop({
                role,
                fixedStop: fixed.number,
                label: fixed.name || fixed.number,
              });
              setShrinkSearch(false);
              navigateTo('/', route);
            };
            return (
              <header>
                <div class="between-header-row">
                  <div class="between-header-stops">
                    <button class="between-stop-edit" title="Change origin" onClick={() => editStop('origin')}>
                      {startStop.name || startStop.number}
                    </button>
                    <span class="between-stop-arrow">{'\u2192'}</span>
                    <button class="between-stop-edit" title="Change destination" onClick={() => editStop('destination')}>
                      {endStop.name || endStop.number}
                    </button>
                  </div>
                  <button
                    class="between-swap-btn"
                    title="Swap origin and destination"
                    onClick={() => {
                      location.hash = `${route.cityPrefix}/between/${endStop.number}-${startStop.number}`;
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                  </button>
                </div>
              </header>
            );
          })(),
          <div class="popover-scroll">
            <BetweenRoutes
              results={showBetweenPopover.results || []}
              stopsData={stopsData}
              arrivalData={showBetweenPopover.arrivalData}
              staticFrequency={showBetweenPopover.staticFrequency}
              onClickRoute={(e, result) =>
                renderBetweenRoute({
                  e,
                  startStop: showBetweenPopover.startStop,
                  endStop: showBetweenPopover.endStop,
                  result,
                })
              }
            />
          </div>,
        ]}
      </div>
      {(directionsOrigin || editingBetweenStop) && (() => {
        const isEditingOrigin = editingBetweenStop?.role === 'origin';
        const label = editingBetweenStop?.label
          || directionsOrigin?.name || directionsOrigin?.number;
        return (
          <div class="directions-banner">
            <div class="directions-banner-inner">
              {DIRECTIONS_SVG}
              <span>
                {isEditingOrigin
                  ? <>{'Select origin \u2192 '}<b>{label}</b></>
                  : <><b>{label}</b>{' \u2192 Select destination'}</>}
              </span>
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
