import * as d3 from 'd3';
import maplibregl from 'maplibre-gl';
import QRCode from 'qrcode';
import bmtcSvgUrl from 'url:../images/bmtc.svg';
import ksrtcSvgUrl from 'url:../images/ksrtc.svg';
import railwaysSvgUrl from 'url:../images/railways.svg';
import {
  getStopName,
  groupRoutesByForwardStops,
  orderGroupsBySimilarity,
  applyTrackOverrides,
} from './algorithms';
import { computeSpiderLayout, fitDiagramArea } from './layout.mjs';
import {
  SVG_WIDTH,
  SVG_ASPECT,
  HDR1_H,
  HEADER_LOGO_X,
  HEADER_LOGO_Y,
  HEADER_LOGO_W,
  HEADER_LOGO_H,
  HEADER_NAME_X,
  HDR_KN_Y,
  HDR_KN_SIZE,
  HDR_KN_EN_Y,
  HDR_KN_EN_SIZE,
  HDR_KN_TOWARDS_Y,
  HDR_KN_TOWARDS_SIZE,
  HDR_EN_Y,
  HDR_EN_SIZE,
  HDR_EN_TOWARDS_Y,
  HDR_EN_TOWARDS_SIZE,
  BADGE_H,
  BADGE_GAP_X,
  BADGE_TOP_PAD,
  BADGE_BOT_PAD,
  BADGE_PADDING_H,
  BADGE_ROW_MARGIN,
  BADGE_INNER_GAP,
  BADGE_ICON_TEXT_GAP,
  BADGE_CHAR_SCALE,
  BUS_ICON_W,
  BUS_ICON_H,
  BADGE_FONT_SIZE,
  DIAGRAM_TOP_PAD,
  CLUSTER_SPACING,
  CLUSTER_LABEL_BAND,
  BRANCH_CORNER_R,
  ROUTE_LINE_START_X,
  ROUTE_AREA_END_PCT,
  ROUTE_LINE_MIN_EXTEND,
  STOP_SPACING_MIN,
  STOP_SPACING_MAX,
  LABEL_AREA_END_X,
  LABEL_GAP,
  LABEL_BOX_H,
  LABEL_BOX_RX,
  LABEL_BOX_FONT_SIZE,
  LABEL_BOX_CHAR_W,
  LABEL_BOX_PAD,
  PILL_W_SMALL,
  PILL_OVERHANG,
  TERMINAL_RADIUS,
  CURRENT_PILL_W,
  DIAGRAM_BOTTOM_PAD,
  LABEL_ROT,
  LABEL_FONT_SIZE,
  LABEL_CHAR_WIDTH,
  LABEL_ROW_OFFSET,
  LABEL_ICON_GAP,
  LABEL_MAX_LINE_CHARS,
  LABEL_HORIZ_GAP,
  LABEL_LINE_SPACING_EXTRA,
  LABEL_STACK_GAP,
  LABEL_MAX_ROWS,
  LABEL_POI_ICON_SIZE,
  LABEL_POI_ICON_GAP,
  INFO_PANEL_H,
  LEGEND_INNER_W,
  LEGEND_VERT_PAD,
  LEGEND_ICON_TOP,
  LEGEND_ICON_SIZE,
  LEGEND_ICON_TEXT_GAP,
  MAP_STOP_ICON_SIZE,
  QR_MAX_SIZE,
  QR_PAD,
  C,
  FONT,
  FONT_KN,
} from './theme.mjs';
import { STOP_ICON_ORDER } from './stopIcons';

// ══════════════════════════════════════════════════════════════════════════════
// SVG icon path data — sourced from the SVG files in the project root.
// Using the paths verbatim keeps icons pixel-perfect without an extra fetch.
// ══════════════════════════════════════════════════════════════════════════════

// bus-route.svg (8×9) — white bus for dark badge backgrounds
const PATH_BUS_ROUTE =
  'M0 1.36615C0 0.615062 0.605744 0 1.34545 0H6.05457C6.79428 0 7.40002 0.615062 7.40002 1.36615V6.83079C7.40002 7.51387 6.72731 7.51385 6.72731 7.51385V8.19694C6.72731 8.57298 6.42492 8.88003 6.05457 8.88003C5.68423 8.88003 5.38183 8.57298 5.38183 8.19694V7.51385H2.01819V8.19694C2.01819 8.57298 1.7158 8.88003 1.34545 8.88003C0.975106 8.88003 0.672738 8.57298 0.672738 8.19694V7.51385C7.65413e-06 7.51385 0 6.83079 0 6.83079V1.36615ZM1.00959 2.04924C0.82146 2.04924 0.672738 2.19924 0.672738 2.39127V4.4405C0.672738 4.63152 0.820475 4.78253 1.00959 4.78253H6.39142C6.57955 4.78253 6.7283 4.63252 6.7283 4.4405V2.39127C6.7283 2.20025 6.58054 2.04924 6.39142 2.04924H1.00959ZM1.34545 5.46462C0.975106 5.46462 0.672738 5.77166 0.672738 6.14771C0.672738 6.52375 0.975106 6.83079 1.34545 6.83079C1.7158 6.83079 2.01819 6.52375 2.01819 6.14771C2.01819 5.77166 1.7158 5.46462 1.34545 5.46462ZM6.05457 5.46462C5.68423 5.46462 5.38183 5.77166 5.38183 6.14771C5.38183 6.52375 5.68423 6.83079 6.05457 6.83079C6.42492 6.83079 6.72731 6.52375 6.72731 6.14771C6.72731 5.77166 6.42492 5.46462 6.05457 5.46462ZM1.34545 1.02412C1.34545 1.21514 1.49321 1.36615 1.68134 1.36615H5.71772C5.90585 1.36615 6.05457 1.21614 6.05457 1.02412C6.05457 0.832095 5.90684 0.683062 5.71772 0.683062H1.68134C1.4942 0.683062 1.34545 0.833095 1.34545 1.02412Z';

// metro.svg (10×10) — blue rounded square with M letter
const PATH_METRO_LETTER =
  'M3.70556 7H3V3H3.67778L5 5.65556L6.32222 3H7V7H6.29444V4.61111L5.13333 7H4.86667L3.70556 4.61111V7Z';

// airport.svg (10×10) — airplane path inside circle
const PATH_AIRPORT_PLANE =
  'M7.88113 6.43581C7.9465 6.45704 8 6.41797 8 6.34888L8 5.90994C8 5.84085 7.95163 5.75543 7.89262 5.72L5.60738 4.35132C5.54838 4.31602 5.5 4.23047 5.5 4.1615L5.5 2.62813C5.5 2.55904 5.479 2.45012 5.45325 2.38593C5.45325 2.38593 5.31688 2.04574 5.07825 2.0078C5.05275 2.00328 5.02688 2.00001 5.00088 2.00001L4.99963 2.00001C4.9695 1.99976 4.93975 2.00353 4.9105 2.00906L4.8835 2.01509L4.8425 2.0279C4.644 2.09448 4.54175 2.38405 4.54175 2.38405C4.51875 2.44924 4.5 2.55904 4.5 2.62813L4.5 4.1615C4.5 4.2306 4.45163 4.31602 4.39263 4.35145L2.10738 5.72C2.04838 5.75543 2 5.84085 2 5.90994L2 6.34888C2 6.41797 2.0535 6.45704 2.11888 6.43568L4.38113 5.69764C4.4465 5.67641 4.5 5.71548 4.5 5.78457L4.5 6.98215C4.5 7.05124 4.455 7.14182 4.4 7.18327L4.1 7.40965C4.045 7.4511 4 7.54168 4 7.61077L4 7.90436C4 7.97345 4.05413 8.0144 4.12013 7.99531L4.8795 7.77609C4.9455 7.757 5.05375 7.757 5.11975 7.77609L5.87988 7.99531C5.94588 8.0144 6 7.97345 6 7.90436L6 7.61065C6 7.54155 5.955 7.45098 5.9 7.40952L5.6 7.18315C5.54513 7.14169 5.5 7.05112 5.5 6.98202L5.5 5.78445C5.5 5.71535 5.5535 5.67628 5.61888 5.69764L7.88113 6.43581Z';

// legened-you-are-here.svg (6×7) — red 5-pointed star
const PATH_STAR =
  'M2.93367 3.33786e-06C2.96053 3.33786e-06 2.98822 3.33786e-06 3.01507 3.33786e-06C3.10318 0.0279202 3.14598 0.0955987 3.18374 0.175966C3.43633 0.724158 3.69311 1.2715 3.94653 1.81885C3.96163 1.85184 3.9801 1.8713 4.01786 1.87638C4.10429 1.88653 4.19072 1.90091 4.27632 1.91445C4.76806 1.98974 5.2598 2.06757 5.75154 2.14032C5.85056 2.1547 5.92189 2.19531 5.96049 2.29006C5.96049 2.32559 5.96049 2.36027 5.96049 2.39581C5.93196 2.43134 5.90595 2.47025 5.87406 2.50324C5.45365 2.93638 5.03407 3.37037 4.61449 3.80435C4.59519 3.82466 4.57505 3.84073 4.58177 3.87795C4.65813 4.33478 4.73114 4.79161 4.80498 5.24843C4.83267 5.42017 4.8612 5.5919 4.88806 5.76363C4.904 5.86515 4.87295 5.93875 4.79911 5.9802C4.77981 5.9912 4.75883 6.00051 4.73869 6.00981C4.71519 6.00981 4.6917 6.00981 4.66904 6.00981C4.63547 5.9912 4.60191 5.97259 4.56918 5.95398C4.05478 5.66888 3.54122 5.38294 3.0285 5.09531C2.99409 5.07586 2.96892 5.07586 2.93367 5.09531C2.71801 5.21798 2.50067 5.33895 2.28333 5.45908C1.94935 5.64266 1.6204 5.83723 1.28055 6.01066C1.25705 6.01066 1.23355 6.01066 1.2109 6.01066C1.09425 5.95482 1.05481 5.86853 1.07663 5.73572C1.17985 5.12492 1.27467 4.51328 1.37621 3.90249C1.38376 3.85427 1.37033 3.8272 1.34012 3.79589C0.999429 3.44481 0.658734 3.09458 0.319717 2.74181C0.210627 2.62845 0.0923067 2.52439 0 2.39581C0 2.35689 0 2.31713 0 2.27821C0.0394401 2.2173 0.0813975 2.16147 0.161117 2.14963C0.749362 2.05995 1.33677 1.96859 1.92501 1.87976C1.97201 1.87299 1.99802 1.85523 2.019 1.81039C2.26739 1.27235 2.51913 0.736002 2.76752 0.197962C2.80612 0.11421 2.84472 0.0363803 2.93367 3.33786e-06Z';

// ══════════════════════════════════════════════════════════════════════════════
// External SVG files — fetched at render time and inserted inline via D3.
// Uses the same mechanism as the path constants above: no <image href> needed.
// Files that exceed 64 KB may be truncated; we close the SVG tag gracefully.
// ══════════════════════════════════════════════════════════════════════════════

async function fetchSvgInfo(url) {
  try {
    const text = await fetch(url).then((r) => r.text());
    const clean = text.includes('</svg>') ? text : text + '</svg>';
    const el = new DOMParser().parseFromString(
      clean,
      'image/svg+xml',
    ).documentElement;
    const vb = (el.getAttribute('viewBox') || '0 0 10 10')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    return { el, vw: vb[2] - vb[0], vh: vb[3] - vb[1] };
  } catch {
    return null;
  }
}

// Appends all child elements of a fetched SVG into a nested <svg> element,
// positioned at (x, y) and scaled to targetW × targetH via viewBox.
// Using a nested <svg> (rather than a scaled <g>) ensures that clip-paths,
// gradients, and other coordinate-dependent features resolve correctly because
// the nested <svg> establishes its own coordinate system.
function insertInlineSvg(parent, svgInfo, x, y, targetW, targetH) {
  if (!svgInfo) return;
  const { el, vw, vh } = svgInfo;
  const svgFill = el.getAttribute('fill');
  const nested = parent
    .append('svg')
    .attr('x', x)
    .attr('y', y)
    .attr('width', targetW)
    .attr('height', targetH)
    .attr('viewBox', `0 0 ${vw} ${vh}`);
  if (svgFill !== null) nested.attr('fill', svgFill);
  const svgNode = nested.node();
  for (const child of el.childNodes) {
    if (child.nodeType === 1)
      svgNode.appendChild(document.importNode(child, true));
  }
  return nested;
}

// ══════════════════════════════════════════════════════════════════════════════
// POI proximity helpers
// ══════════════════════════════════════════════════════════════════════════════

const POI_RADIUS_M = 500;

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function buildStopPoiMap(stopsData, poisData) {
  const stopPoiTypes = {};
  if (!poisData || poisData.length === 0) return stopPoiTypes;
  for (const [stopId, stopArr] of Object.entries(stopsData)) {
    const [sLon, sLat] = stopArr;
    if (sLon == null || sLat == null) continue;
    const poiMap = new Map();
    for (const poi of poisData) {
      const distance = haversineDistance(sLat, sLon, poi.lat, poi.lon);
      if (distance > POI_RADIUS_M) continue;
      const previous = poiMap.get(poi.type);
      // A stop can sit within 500 m of stations on different metro lines. The
      // closest station determines the line colour printed next to its label.
      if (!previous || distance < previous.distance) {
        poiMap.set(poi.type, {
          type: poi.type,
          color: poi.color || '',
          distance,
        });
      }
    }
    if (poiMap.size > 0) stopPoiTypes[stopId] = poiMap;
  }
  return stopPoiTypes;
}

const EDITABLE_STOP_ICON_TYPES = new Set(STOP_ICON_ORDER);

function applyStopIconOverrides(stopPoiTypes, stopIconOverrides) {
  if (!stopIconOverrides?.size) return stopPoiTypes;
  const result = { ...stopPoiTypes };
  for (const [stopId, override] of stopIconOverrides) {
    const detected = stopPoiTypes[stopId] || new Map();
    const types = Array.isArray(override?.types)
      ? override.types.filter((type) => EDITABLE_STOP_ICON_TYPES.has(type))
      : [];
    result[stopId] = new Map(
      types.map((type) => {
        const original = detected.get(type);
        return [
          type,
          {
            type,
            color:
              type === 'metro'
                ? override.metroColor || original?.color || ''
                : original?.color || '',
          },
        ];
      }),
    );
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// Stop label helpers
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// Badge layout helpers
// ══════════════════════════════════════════════════════════════════════════════

// The text shown for a route — the editor's rename if there is one.
function routeLabel(route) {
  return route.displayId || route.routeId;
}

// One badge per route, in the order the routes are drawn.
function badgeItems(routes) {
  const seen = new Map();
  for (const route of routes) {
    if (!seen.has(route.routeId)) seen.set(route.routeId, routeLabel(route));
  }
  return [...seen].map(([routeId, label]) => ({ routeId, label }));
}

function badgeWidth(label) {
  return (
    BADGE_PADDING_H +
    BUS_ICON_W +
    BADGE_ICON_TEXT_GAP +
    label.length * (BADGE_FONT_SIZE * BADGE_CHAR_SCALE) +
    BADGE_PADDING_H
  );
}

function layoutBadges(items) {
  const rows = [];
  let row = [],
    x = BADGE_ROW_MARGIN;
  for (const item of items) {
    const w = badgeWidth(item.label);
    if (x + w > SVG_WIDTH - BADGE_ROW_MARGIN && row.length > 0) {
      rows.push(row);
      row = [];
      x = BADGE_ROW_MARGIN;
    }
    row.push({ ...item, w, x });
    x += w + BADGE_INNER_GAP;
  }
  if (row.length) rows.push(row);
  return rows;
}

function headerHeight(routes) {
  const rows = layoutBadges(badgeItems(routes));
  return (
    HDR1_H +
    BADGE_TOP_PAD +
    rows.length * BADGE_H +
    (rows.length - 1) * BADGE_GAP_X +
    BADGE_BOT_PAD
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Cluster label packing — greedy N-row layout so labels always fit
// ══════════════════════════════════════════════════════════════════════════════

function packClusterLabels(cluster) {
  function naturalWidth(r) {
    const MAX_LABEL_W = LABEL_AREA_END_X - 2;
    return Math.min(
      MAX_LABEL_W,
      Math.max(
        20,
        LABEL_BOX_PAD * 2 + Math.ceil(routeLabel(r).length * LABEL_BOX_CHAR_W),
      ),
    );
  }

  const MAX_WIDTH = LABEL_AREA_END_X - 2;
  const widths = cluster.map(naturalWidth);

  // Greedy bin-packing: place each route into the first row that has space
  const rows = [[]];
  const rowWidths = [0];

  cluster.forEach((_, i) => {
    const w = widths[i];
    let placed = false;
    for (let r = 0; r < rows.length; r++) {
      const needed = rowWidths[r] + (rows[r].length > 0 ? LABEL_GAP : 0) + w;
      if (needed <= MAX_WIDTH) {
        rows[r].push(i);
        rowWidths[r] = needed;
        placed = true;
        break;
      }
    }
    if (!placed) {
      rows.push([i]);
      rowWidths.push(w);
    }
  });

  // Build the result with x-positions
  return rows.flatMap((row, rowIdx) => {
    const totalW =
      row.reduce((acc, i) => acc + widths[i], 0) + (row.length - 1) * LABEL_GAP;
    let x = Math.max(2, LABEL_AREA_END_X - totalW);
    return row.map((i) => {
      const item = { route: cluster[i], x, w: widths[i], row: rowIdx };
      x += widths[i] + LABEL_GAP;
      return item;
    });
  });
}

// OpenFreeMap's "bright" style — street-level detail that reads like the
// printed reference artwork without needing a self-hosted basemap.
const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';
const BASEMAP_ZOOM = 16;

// Basemap detail that competes with the diagram's own stops, icons and labels.
const HIDDEN_BASEMAP_LAYERS = [
  // Bus stops, stations and every other point of interest
  'poi_r20',
  'poi_r7',
  'poi_r1',
  'poi_transit',
  // Landuse polygons (parks and other landcover stay — the reference keeps them)
  'landuse-residential',
  'landuse-suburb',
  'landuse-commercial',
  'landuse-industrial',
  'landuse-cemetery',
  'landuse-hospital',
  'landuse-school',
  'landuse-railway',
  // Administrative boundaries
  'boundary_2',
  'boundary_3',
  'boundary_disputed',
  // Footways and paths, and their names
  'highway-path',
  'highway-name-path',
  'highway-name-minor',
  'tunnel-path',
  'bridge-path',
  'bridge-path-casing',
  // Offset base of the style's fake-3D buildings; `building-top` is flattened
  // into a plain footprint instead.
  'building',
];

// Other bus stops are drawn from the city's own stops data rather than the
// basemap's POIs, so the map agrees with the diagram beside it. Only the stops
// that land inside the captured viewport are handed to the map.
const EARTH_METRES_PER_DEGREE = 111320;

function visibleStopPoints(stopsData, lng, lat, w, h) {
  const latRad = (lat * Math.PI) / 180;
  const metresPerPixel = (156543.03392 * Math.cos(latRad)) / 2 ** BASEMAP_ZOOM;
  // One icon of margin so markers straddling the edge still get drawn.
  const halfW = (w / 2 + MAP_STOP_ICON_SIZE) * metresPerPixel;
  const halfH = (h / 2 + MAP_STOP_ICON_SIZE) * metresPerPixel;
  const lngSpan = halfW / (EARTH_METRES_PER_DEGREE * Math.cos(latRad));
  const latSpan = halfH / EARTH_METRES_PER_DEGREE;

  const points = [];
  for (const stop of Object.values(stopsData)) {
    const [sLng, sLat] = stop;
    if (sLng == null || sLat == null) continue;
    if (Math.abs(sLng - lng) > lngSpan || Math.abs(sLat - lat) > latSpan)
      continue;
    points.push([sLng, sLat]);
  }
  return points;
}

// The blue rounded square the printed legend uses for a bus stop. Drawn at
// twice the display size so it stays crisp on high-density screens.
const STOP_ICON_PIXEL_RATIO = 2;

function roundedSquareIcon(size, color) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = size * 0.17;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

function addStopMarkers(map, points) {
  if (!points.length) return;
  map.addImage(
    'diagram-bus-stop',
    roundedSquareIcon(
      Math.round(MAP_STOP_ICON_SIZE * STOP_ICON_PIXEL_RATIO),
      C.header1,
    ),
    { pixelRatio: STOP_ICON_PIXEL_RATIO },
  );
  map.addSource('diagram-bus-stops', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: points.map((coordinates) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates },
      })),
    },
  });
  // No text-field: the markers carry no labels, as in the reference artwork.
  map.addLayer({
    id: 'diagram-bus-stops',
    type: 'symbol',
    source: 'diagram-bus-stops',
    layout: {
      'icon-image': 'diagram-bus-stop',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
}

// Match the main app's rail-path treatment: a light casing beneath the route
// and the GeoJSON feature's own `stroke` colour on top. Railway geometry is
// included too when a city supplies it, while metro lines retain their line
// colour and the heavier white casing used on the primary map.
function addRailLayers(map, railData) {
  if (!railData?.features?.length) return;
  map.addSource('diagram-rail', { type: 'geojson', data: railData });
  const lineFilter = [
    'all',
    ['==', ['geometry-type'], 'LineString'],
    ['has', 'stroke'],
  ];
  const lineLayout = { 'line-join': 'round', 'line-cap': 'round' };

  map.addLayer({
    id: 'diagram-rail-case',
    type: 'line',
    source: 'diagram-rail',
    filter: lineFilter,
    layout: lineLayout,
    paint: {
      'line-color': [
        'match',
        ['get', 'mode'],
        'metro',
        '#fff',
        'monorail',
        '#fff',
        ['get', 'stroke'],
      ],
      'line-width': ['match', ['get', 'mode'], 'monorail', 0.85, 'rail', 5, 9],
      'line-opacity': [
        'match',
        ['get', 'mode'],
        'monorail',
        0.5,
        'rail',
        0.75,
        0.5,
      ],
    },
  });

  map.addLayer({
    id: 'diagram-rail-path',
    type: 'line',
    source: 'diagram-rail',
    filter: lineFilter,
    layout: lineLayout,
    paint: {
      'line-color': ['get', 'stroke'],
      'line-width': 4,
      'line-opacity': [
        'match',
        ['get', 'mode'],
        'monorail',
        1,
        'rail',
        0.01,
        0.5,
      ],
    },
  });

  map.addLayer({
    id: 'diagram-rail-dots',
    type: 'line',
    source: 'diagram-rail',
    filter: ['all', ...lineFilter.slice(1), ['==', ['get', 'mode'], 'rail']],
    layout: { ...lineLayout, 'line-cap': 'butt' },
    paint: {
      'line-color': ['get', 'stroke'],
      'line-width': 3,
      'line-opacity': 1,
      'line-dasharray': [3, 3],
    },
  });
}

function simplifyBasemap(map) {
  for (const id of HIDDEN_BASEMAP_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  }
  if (map.getLayer('building-top')) {
    map.setPaintProperty('building-top', 'fill-translate', [0, 0]);
    map.setPaintProperty('building-top', 'fill-opacity', 1);
  }
  // The bright style already groups tertiary, secondary, primary and trunk
  // labels in this layer. Keep only that layer and reject symbols whose full
  // label cannot fit inside the captured map viewport.
  for (const id of ['highway-name-major']) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, 'symbol-avoid-edges', true);
    map.setLayoutProperty(id, 'text-padding', 4);
  }
}

// Rendering a basemap spins up a whole MapLibre instance, and the diagram
// re-renders on every edit, so both async assets are memoised per stop.
const mapUriCache = new Map();
const qrUriCache = new Map();

function captureMapAsDataUri(lng, lat, w, h, stopPoints = [], railData = null) {
  const cacheKey = `${lng},${lat},${w},${h},${MAP_STOP_ICON_SIZE},${railData?.features?.length || 0},${stopPoints
    .map(([x, y]) => `${x}:${y}`)
    .join(';')}`;
  const cached = mapUriCache.get(cacheKey);
  if (cached) return cached;

  const pending = new Promise((resolve) => {
    const div = document.createElement('div');
    Object.assign(div.style, {
      position: 'fixed',
      top: '-9999px',
      left: '-9999px',
      width: `${w}px`,
      height: `${h}px`,
      visibility: 'hidden',
    });
    document.body.appendChild(div);

    const map = new maplibregl.Map({
      container: div,
      style: BASEMAP_STYLE_URL,
      center: [lng, lat],
      zoom: BASEMAP_ZOOM,
      preserveDrawingBuffer: true,
      interactive: false,
      renderWorldCopies: false,
      attributionControl: false,
    });

    let resolved = false;
    const finish = (uri) => {
      if (resolved) return;
      resolved = true;
      map.remove();
      if (document.body.contains(div)) document.body.removeChild(div);
      resolve(uri);
    };

    const timer = setTimeout(() => finish(null), 8000);

    map.once('load', () => {
      simplifyBasemap(map);
      addRailLayers(map, railData);
      addStopMarkers(map, stopPoints);
      map.once('idle', () => {
        clearTimeout(timer);
        try {
          finish(map.getCanvas().toDataURL('image/png'));
        } catch {
          finish(null);
        }
      });
    });
  }).then((uri) => {
    // A failed capture shouldn't be cached — the next render can retry.
    if (!uri) mapUriCache.delete(cacheKey);
    return uri;
  });

  mapUriCache.set(cacheKey, pending);
  return pending;
}

function generateQrDataUri(url) {
  const cached = qrUriCache.get(url);
  if (cached) return cached;
  const pending = QRCode.toDataURL(url, {
    width: 200,
    margin: 0,
    color: { dark: '#000000', light: '#ffffff' },
  }).catch(() => null);
  qrUriCache.set(url, pending);
  return pending;
}

// ══════════════════════════════════════════════════════════════════════════════
// SVG drawing primitives
// ══════════════════════════════════════════════════════════════════════════════

function addDefs(svg) {
  const defs = svg.append('defs');

  const f = defs
    .append('filter')
    .attr('id', 'ds')
    .attr('x', '-20%')
    .attr('y', '-20%')
    .attr('width', '140%')
    .attr('height', '140%');
  f.append('feGaussianBlur').attr('in', 'SourceAlpha').attr('stdDeviation', 1);
  f.append('feOffset').attr('dx', 0).attr('dy', 1).attr('result', 'blur');
  f.append('feComponentTransfer')
    .append('feFuncA')
    .attr('type', 'linear')
    .attr('slope', 0.14);
  const fm = f.append('feMerge');
  fm.append('feMergeNode');
  fm.append('feMergeNode').attr('in', 'SourceGraphic');
}

// Bus icon for route badges — uses bus-route.svg path (white bus on dark background)
// Original path is 8×9; scale to BUS_ICON_W × BUS_ICON_H
function drawBusIcon(parent, x, y, color = C.white) {
  const sx = BUS_ICON_W / 8;
  const sy = BUS_ICON_H / 9;
  const g = parent
    .append('g')
    .attr('transform', `translate(${x},${y}) scale(${sx},${sy})`);
  g.append('path')
    .attr('d', PATH_BUS_ROUTE)
    .attr('fill', color)
    .attr('fill-opacity', 0.9);
}

// ══════════════════════════════════════════════════════════════════════════════
// Section: Header
// ══════════════════════════════════════════════════════════════════════════════

function drawHeader(
  svg,
  stopId,
  stopsData,
  routes,
  hdrH,
  bmtcSvgInfo,
  towardsSuffix = '',
) {
  const stopData = stopsData[stopId] || [];
  const englishName = stopData[2] || String(stopId);
  const kannadaName = stopData[4] || '';

  const g = svg.append('g').attr('id', 'header').attr('data-stop-id', stopId);

  g.append('rect')
    .attr('width', SVG_WIDTH)
    .attr('height', HDR1_H)
    .attr('fill', C.header1);

  insertInlineSvg(
    g,
    bmtcSvgInfo,
    HEADER_LOGO_X,
    HEADER_LOGO_Y,
    HEADER_LOGO_W,
    HEADER_LOGO_H,
  );

  const nameX = HEADER_NAME_X;
  const displayName = englishName;
  const displayKn = kannadaName;

  // ── Stop name + "Towards" suffix — read directly from stops data ─────────────
  // Shown as a subtitle beneath the stop name in the same font.
  const towardsLine = towardsSuffix ? '(' + towardsSuffix + ')' : null;

  if (kannadaName) {
    g.append('text')
      .attr('x', nameX)
      .attr('y', HDR_KN_Y)
      .attr('font-family', FONT_KN)
      .attr('font-size', HDR_KN_SIZE)
      .attr('font-weight', 500)
      .attr('fill', C.white)
      .text(displayKn);
    g.append('text')
      .attr('class', 'stop-name-text')
      .attr('x', nameX)
      .attr('y', HDR_KN_EN_Y)
      .attr('font-family', FONT)
      .attr('font-size', HDR_KN_EN_SIZE)
      .attr('font-weight', 500)
      .attr('fill', C.white)
      .attr('fill-opacity', 0.8)
      .text(displayName);
    if (towardsLine) {
      g.append('text')
        .attr('class', 'towards-text')
        .attr('x', nameX)
        .attr('y', HDR_KN_TOWARDS_Y)
        .attr('font-family', FONT)
        .attr('font-size', HDR_KN_TOWARDS_SIZE)
        .attr('font-weight', 500)
        .attr('fill', C.white)
        .text(towardsLine);
    }
  } else {
    g.append('text')
      .attr('class', 'stop-name-text')
      .attr('x', nameX)
      .attr('y', HDR_EN_Y)
      .attr('font-family', FONT)
      .attr('font-size', HDR_EN_SIZE)
      .attr('font-weight', 500)
      .attr('fill', C.white)
      .text(displayName);
    if (towardsLine) {
      g.append('text')
        .attr('class', 'towards-text')
        .attr('x', nameX)
        .attr('y', HDR_EN_TOWARDS_Y)
        .attr('font-family', FONT)
        .attr('font-size', HDR_EN_TOWARDS_SIZE)
        .attr('font-weight', 500)
        .attr('fill', C.white)
        .text(towardsLine);
    }
  }

  // Route badges strip
  const badgesG = g
    .append('g')
    .attr('id', 'route-badges')
    .attr('transform', `translate(0,${HDR1_H})`);
  badgesG
    .append('rect')
    .attr('width', SVG_WIDTH)
    .attr('height', hdrH - HDR1_H)
    .attr('fill', C.header2);

  const badgeRows = layoutBadges(badgeItems(routes));
  let badgeY = BADGE_TOP_PAD;

  badgeRows.forEach((row) => {
    row.forEach(({ routeId, label, w, x: bx }) => {
      const bg = badgesG
        .append('g')
        .attr('class', 'route-badge')
        .attr('data-route-id', routeId)
        .attr('transform', `translate(${bx},${badgeY})`);
      bg.append('rect')
        .attr('width', w)
        .attr('height', BADGE_H)
        .attr('rx', 3)
        .attr('fill', C.white);
      const iconY = (BADGE_H - BUS_ICON_H) / 2;
      drawBusIcon(bg, BADGE_PADDING_H, iconY, C.primary);
      bg.append('text')
        .attr('x', BADGE_PADDING_H + BUS_ICON_W + BADGE_ICON_TEXT_GAP)
        .attr('y', BADGE_H / 2)
        .attr('dominant-baseline', 'middle')
        .attr('font-family', FONT)
        .attr('font-size', BADGE_FONT_SIZE)
        .attr('font-weight', 700)
        .attr('fill', C.primary)
        .text(label);
    });
    badgeY += BADGE_H + BADGE_GAP_X;
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Section: Route diagram (cluster-based rendering with branch connectors)
// ══════════════════════════════════════════════════════════════════════════════

// Theme values the shared layout module needs. Read fresh on every render so
// live tweaks from the expert panel take effect.
function layoutTheme(rowMinGaps) {
  return {
    ROW_PITCH: CLUSTER_SPACING,
    ROW_MIN_GAPS: rowMinGaps,
    LABEL_BAND: CLUSTER_LABEL_BAND,
    MIN_STOP_SPACING: STOP_SPACING_MIN,
    MAX_STOP_SPACING: STOP_SPACING_MAX,
    START_X: ROUTE_LINE_START_X,
    AREA_END_X: SVG_WIDTH * ROUTE_AREA_END_PCT,
    MIN_EXTEND: ROUTE_LINE_MIN_EXTEND,
    PILL_W: PILL_W_SMALL,
    PILL_OVERHANG,
    CORNER_R: BRANCH_CORNER_R,
    TOP_PAD: DIAGRAM_TOP_PAD,
    BOTTOM_PAD: DIAGRAM_BOTTOM_PAD,
    LABEL_ROT,
    LABEL_FONT_SIZE,
    LABEL_CHAR_WIDTH,
    LABEL_LINE_SPACING: LABEL_FONT_SIZE + LABEL_LINE_SPACING_EXTRA,
    LABEL_MAX_LINE_CHARS,
    LABEL_ICON_GAP,
    LABEL_ROW_OFFSET,
    LABEL_HORIZ_GAP,
    LABEL_STACK_GAP,
    LABEL_MAX_ROWS,
    POI_ICON_SIZE: LABEL_POI_ICON_SIZE,
    POI_ICON_GAP: LABEL_POI_ICON_GAP,
  };
}

// Half-heights of each track's stack of route ID boxes, so neighbouring tracks
// can be pushed apart just enough for the boxes to clear each other.
function badgeStackHalfHeights(routeGroups) {
  return routeGroups.map((group) => {
    const rows =
      Math.max(0, ...packClusterLabels(group.routes).map((p) => p.row)) + 1;
    return (rows * LABEL_BOX_H + (rows - 1) * 2) / 2;
  });
}

export function buildRouteLayout(
  routes,
  orderedStops,
  currentStopId,
  stopsData,
  stopPoiTypes = {},
  {
    trackOverrides,
    branchOverrides,
    labelOffsets,
    preserveRouteOrder = false,
  } = {},
) {
  const grouped = applyTrackOverrides(
    groupRoutesByForwardStops(routes, currentStopId, orderedStops),
    trackOverrides,
    currentStopId,
    orderedStops,
  );
  const routeGroups = preserveRouteOrder
    ? grouped.sort((a, b) => {
        const indexOf = (group) =>
          Math.min(...group.routes.map((r) => routes.indexOf(r)));
        return indexOf(a) - indexOf(b);
      })
    : orderGroupsBySimilarity(grouped);
  const halves = badgeStackHalfHeights(routeGroups);
  const rowMinGaps = halves
    .slice(0, -1)
    .map((h, i) => Math.ceil(h + halves[i + 1] + 2));

  return computeSpiderLayout({
    routeGroups,
    orderedStops,
    currentStopId,
    getName: (sid) => getStopName(sid, stopsData),
    getIconCount: (sid) => stopPoiTypes[sid]?.size || 0,
    getLabelOffset: labelOffsets ? (sid) => labelOffsets.get(sid) : null,
    getBranchConfig: branchOverrides
      ? (trackKey) => branchOverrides.get(trackKey)
      : null,
    theme: layoutTheme(rowMinGaps),
  });
}

function drawRouteDiagram(
  svg,
  layout,
  currentStopId,
  stopsData,
  yBase,
  fit,
  stopPoiTypes = {},
  svgInfos = {},
  interactive = false,
) {
  const g = svg
    .append('g')
    .attr('id', 'route-diagram')
    .attr(
      'transform',
      `translate(${fit.offsetX},${yBase + fit.offsetY}) scale(${fit.scale})`,
    );

  if (!layout) return;

  const linesG = g.append('g').attr('id', 'group-lines');
  const pillsG = g.append('g').attr('id', 'stop-pills');
  const heroG = g.append('g').attr('id', 'current-stop-pill');
  const labelsG = g.append('g').attr('id', 'stop-labels');

  // ── Route group tracks and their route ID label boxes ───────────────────────

  layout.tracks.forEach((track) => {
    linesG
      .append('path')
      .attr('class', 'route-track')
      .attr('data-track-key', track.key)
      .attr('data-track-y', track.labelY)
      .attr('data-branch-angle', track.branch.angle)
      .attr('data-branch-length', track.branch.length)
      .attr('d', track.d)
      .attr('fill', 'none')
      .attr('stroke', C.primary)
      .attr('stroke-width', 4);

    const packed = packClusterLabels(track.routes);
    const numRows = Math.max(0, ...packed.map((p) => p.row)) + 1;
    const totalLabelH = numRows * LABEL_BOX_H + (numRows - 1) * 2;
    const labelStartY = track.labelY - totalLabelH / 2;

    packed.forEach(({ route, x, w, row }) => {
      const labelY = labelStartY + row * (LABEL_BOX_H + 2);
      const chip = linesG
        .append('g')
        .attr('class', 'route-chip')
        .attr('data-route-id', route.routeId)
        .attr('data-track-key', track.key);

      chip
        .append('rect')
        .attr('x', x)
        .attr('y', labelY)
        .attr('width', w)
        .attr('height', LABEL_BOX_H)
        .attr('rx', LABEL_BOX_RX)
        .attr('fill', C.primary)
        .attr('filter', 'url(#ds)');

      const text = routeLabel(route);
      const maxChars = Math.floor((w - LABEL_BOX_PAD * 2) / LABEL_BOX_CHAR_W);
      const label =
        text.length > maxChars
          ? text.slice(0, Math.max(1, maxChars - 1)) + '…'
          : text;

      chip
        .append('text')
        .attr('x', x + w / 2)
        .attr('y', labelY + LABEL_BOX_H / 2)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('font-family', FONT)
        .attr('font-size', LABEL_BOX_FONT_SIZE)
        .attr('font-weight', 700)
        .attr('fill', C.white)
        .text(label)
        .append('title')
        .text(route.routeName || route.routeId);
    });
  });

  // ── Stop markers — a pill spanning every track that serves the stop, with a
  //    dot on each track that terminates there. ─────────────────────────────────

  layout.markers.forEach((m) => {
    pillsG
      .append('rect')
      .attr('data-stop-id', m.rep)
      .attr('data-stop-name', m.name)
      .attr('x', m.x - m.width / 2)
      .attr('y', m.top)
      .attr('width', m.width)
      .attr('height', m.bottom - m.top)
      .attr('rx', m.width / 2)
      .attr('fill', C.white)
      .attr('stroke', C.pillStroke)
      .attr('stroke-width', 1)
      .append('title')
      .text(m.name);

    m.dots.forEach((dot) => {
      pillsG
        .append('circle')
        .attr('cx', dot.x)
        .attr('cy', dot.y)
        .attr('r', TERMINAL_RADIUS)
        .attr('fill', C.primary);
    });
  });

  // ── Current-stop pill (spans every track at the start of the diagram) ────────

  const pill = layout.currentPill;
  heroG
    .append('rect')
    .attr('data-stop-id', currentStopId)
    .attr('data-stop-name', getStopName(currentStopId, stopsData))
    .attr('x', ROUTE_LINE_START_X - CURRENT_PILL_W / 2)
    .attr('y', pill.y)
    .attr('width', CURRENT_PILL_W)
    .attr('height', pill.height)
    .attr('rx', CURRENT_PILL_W / 2)
    .attr('fill', C.white)
    .attr('stroke', C.primary)
    .attr('stroke-width', 2)
    .append('title')
    .text(getStopName(currentStopId, stopsData));

  // ── Stop labels — rotated, nudged clear of their neighbours ─────────────────
  // Interchange icons sit between the marker and the text so they read as
  // belonging to the stop rather than to the end of its name.

  function drawPoiIcons(parent, poiMap, x, y) {
    const size = LABEL_POI_ICON_SIZE;
    let iconX = x;
    for (const type of STOP_ICON_ORDER) {
      if (!poiMap.has(type)) continue;
      const poiInfo = poiMap.get(type);
      const ig = parent
        .append('g')
        .attr('transform', `translate(${iconX},${y})`);

      if (type === 'metro') {
        const sg = ig.append('g').attr('transform', `scale(${size / 10})`);
        const rawColor = poiInfo.color || C.primary;
        const bgColor =
          rawColor === '#ffff00' || rawColor === 'yellow'
            ? '#FFEA00'
            : rawColor;
        sg.append('rect')
          .attr('x', 0.278)
          .attr('y', 0.278)
          .attr('width', 9.444)
          .attr('height', 9.444)
          .attr('rx', 0.833)
          .attr('fill', bgColor);
        sg.append('path').attr('d', PATH_METRO_LETTER).attr('fill', C.white);
      } else if (type === 'railway') {
        insertInlineSvg(ig, svgInfos.railSvgInfo, 0, 0, size, size);
      } else if (type === 'bus') {
        insertInlineSvg(ig, svgInfos.bmtcSvgInfo, 0, 0, size, size);
      } else if (type === 'airport') {
        const sg = ig.append('g').attr('transform', `scale(${size / 10})`);
        sg.append('rect')
          .attr('x', 0.278)
          .attr('y', 0.278)
          .attr('width', 9.444)
          .attr('height', 9.444)
          .attr('rx', 4.722)
          .attr('fill', C.white)
          .attr('stroke', C.primary)
          .attr('stroke-width', 0.556);
        sg.append('path').attr('d', PATH_AIRPORT_PLANE).attr('fill', C.primary);
      }
      iconX += size + LABEL_POI_ICON_GAP;
    }
  }

  layout.labels.forEach((l) => {
    const numLines = l.lines.length;
    const poiMap = l.stopId ? stopPoiTypes[l.stopId] : null;

    const labelG = labelsG
      .append('g')
      .attr('class', 'stop-label')
      .attr('data-stop-id', l.stopId)
      .attr('data-stop-name', l.name)
      .attr(
        'transform',
        `translate(${l.anchorX},${l.anchorY}) rotate(${LABEL_ROT})`,
      );

    // Rotated text is a thin target to grab; a transparent rect over the whole
    // block makes the label easy to click and drag. Stripped on export.
    if (interactive) {
      const textW =
        Math.max(...l.lines.map((line) => line.length)) * LABEL_CHAR_WIDTH;
      const blockTop =
        l.side === 'above'
          ? -(numLines - 1) * l.lineSpacing - LABEL_FONT_SIZE
          : -LABEL_FONT_SIZE;
      labelG
        .append('rect')
        .attr('data-edit-hit', '1')
        .attr('x', (l.textAnchor === 'start' ? 0 : -textW) + l.iconX - 3)
        .attr('y', blockTop - 2)
        .attr('width', textW + l.iconSpan + 6)
        .attr('height', l.blockH + 4)
        .attr('fill', 'transparent');
    }

    if (poiMap && l.iconCount > 0) {
      // Centre the icon strip on the label's text block.
      const blockTop =
        l.side === 'above'
          ? -(numLines - 1) * l.lineSpacing - LABEL_FONT_SIZE
          : -LABEL_FONT_SIZE;
      const iconY =
        blockTop + (l.blockH - LABEL_POI_ICON_SIZE) / 2 - l.lineSpacing / 4;
      drawPoiIcons(labelG, poiMap, l.iconX, iconY);
    }

    const textEl = labelG
      .append('text')
      .attr('x', l.textX)
      .attr('text-anchor', l.textAnchor)
      .attr('dominant-baseline', 'auto')
      .attr('font-family', FONT)
      .attr('font-size', LABEL_FONT_SIZE)
      .attr('font-weight', 400)
      .attr('fill', C.labelMuted);

    l.lines.forEach((line, lineIdx) => {
      const dy =
        l.side === 'above'
          ? lineIdx === 0
            ? -(numLines - 1) * l.lineSpacing
            : l.lineSpacing
          : lineIdx === 0
            ? 0
            : l.lineSpacing;
      textEl.append('tspan').attr('x', l.textX).attr('dy', dy).text(line);
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Section: Info panel — area map
// ══════════════════════════════════════════════════════════════════════════════

function drawMapSection(g, mapUri, colW) {
  const cx = colW / 2;
  const mapCy = INFO_PANEL_H / 2;

  if (mapUri) {
    g.append('image')
      .attr('href', mapUri)
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', colW)
      .attr('height', INFO_PANEL_H)
      .attr('preserveAspectRatio', 'xMidYMid slice');
  } else {
    g.append('rect')
      .attr('width', colW)
      .attr('height', INFO_PANEL_H)
      .attr('fill', C.mapBg);
    for (let xi = 0; xi < colW; xi += 20) {
      g.append('line')
        .attr('x1', xi)
        .attr('y1', 0)
        .attr('x2', xi)
        .attr('y2', INFO_PANEL_H)
        .attr('stroke', 'rgba(0,0,0,0.07)')
        .attr('stroke-width', 1);
    }
    for (let yi = 0; yi < INFO_PANEL_H; yi += 20) {
      g.append('line')
        .attr('x1', 0)
        .attr('y1', yi)
        .attr('x2', colW)
        .attr('y2', yi)
        .attr('stroke', 'rgba(0,0,0,0.07)')
        .attr('stroke-width', 1);
    }
  }

  // OpenStreetMap data is share-alike, so the printed diagram carries its
  // credit in the corner of the map it was rendered from.
  if (mapUri) {
    g.append('text')
      .attr('x', 3)
      .attr('y', INFO_PANEL_H - 3)
      .attr('font-family', FONT)
      .attr('font-size', 5)
      .attr('fill', C.nearBlack)
      .attr('fill-opacity', 0.6)
      .text('© OpenStreetMap contributors');
  }

  // "You are here" star overlaid at the stop location (center of map)
  const starH = 20;
  const starScale = starH / 7; // original path viewBox is 6×7
  const starW = 6 * starScale;
  g.append('g')
    .attr(
      'transform',
      `translate(${cx - starW / 2},${mapCy - starH / 2}) scale(${starScale})`,
    )
    .append('path')
    .attr('d', PATH_STAR)
    .attr('fill', C.youAreHere)
    .attr('filter', 'url(#ds)');
}

// ══════════════════════════════════════════════════════════════════════════════
// Section: Info panel — legend icons (using actual SVG file paths)
// ══════════════════════════════════════════════════════════════════════════════

// "You are here" — red 5-pointed star from legened-you-are-here.svg (6×7)
function drawYouAreHereIcon(g) {
  const scale = 12 / 7; // scale 6×7 icon to fit ~12px tall
  g.append('g')
    .attr('transform', `scale(${scale})`)
    .append('path')
    .attr('d', PATH_STAR)
    .attr('fill', C.youAreHere);
}

// "Metro Station" — blue rounded square with M from metro.svg (10×10)
function drawMetroIcon(g) {
  const ig = g.append('g');
  ig.append('rect')
    .attr('x', 0.277778)
    .attr('y', 0.277778)
    .attr('width', 9.44444)
    .attr('height', 9.44444)
    .attr('rx', 0.833333)
    .attr('fill', C.primary);
  ig.append('path').attr('d', PATH_METRO_LETTER).attr('fill', C.white);
}

// "Major Bus Station" — BMTC SVG logo (inline, same mechanism as path constants)
function drawMajorBusIcon(g, svgInfo) {
  insertInlineSvg(g, svgInfo, 0, 0, 12, 12);
}

// "Long Distance Bus" — KSRTC SVG logo (inline)
function drawLongDistIcon(g, svgInfo) {
  insertInlineSvg(g, svgInfo, 0, 0, 12, 12);
}

// "Railway Station" — railways SVG logo (inline)
function drawRailwayIcon(g, svgInfo) {
  insertInlineSvg(g, svgInfo, 0, 0, 12, 12);
}

// "Airport" — white circle with blue plane from airport.svg (10×10)
function drawAirportIcon(g) {
  const ig = g.append('g');
  // Circle background
  ig.append('rect')
    .attr('x', 0.277778)
    .attr('y', 0.277778)
    .attr('width', 9.44444)
    .attr('height', 9.44444)
    .attr('rx', 4.72222)
    .attr('fill', C.white)
    .attr('stroke', C.primary)
    .attr('stroke-width', 0.555556);
  // Airplane path
  ig.append('path').attr('d', PATH_AIRPORT_PLANE).attr('fill', C.primary);
}

// ══════════════════════════════════════════════════════════════════════════════
// Section: Info panel — legend (single-column, centred)
// ══════════════════════════════════════════════════════════════════════════════

function drawLegendSection(
  g,
  colW,
  { bmtcSvgInfo, ksrtcSvgInfo, railSvgInfo } = {},
) {
  const stopItems = {
    metro: [{ draw: (ig) => drawMetroIcon(ig), en: 'Metro Station' }],
    bus: [
      {
        draw: (ig) => drawMajorBusIcon(ig, bmtcSvgInfo),
        en: 'Major Bus Station',
      },
      {
        draw: (ig) => drawLongDistIcon(ig, ksrtcSvgInfo),
        en: 'Long Distance Bus',
      },
    ],
    railway: [
      {
        draw: (ig) => drawRailwayIcon(ig, railSvgInfo),
        en: 'Railway Station',
      },
    ],
    airport: [{ draw: (ig) => drawAirportIcon(ig), en: 'Airport' }],
  };
  const items = [
    { draw: (ig) => drawYouAreHereIcon(ig), en: 'You are here' },
    ...STOP_ICON_ORDER.flatMap((type) => stopItems[type]),
  ];

  const subColW = LEGEND_INNER_W;
  const leftPad = Math.floor((colW - subColW) / 2);
  const rowH = Math.floor((INFO_PANEL_H - LEGEND_VERT_PAD) / items.length);
  const iconSize = LEGEND_ICON_SIZE;

  items.forEach(({ draw, en }, i) => {
    const y = LEGEND_ICON_TOP + i * rowH + Math.floor((rowH - iconSize) / 2);
    const itemG = g.append('g').attr('transform', `translate(${leftPad},${y})`);
    draw(itemG);
    itemG
      .append('text')
      .attr('x', iconSize + LEGEND_ICON_TEXT_GAP)
      .attr('y', iconSize / 2)
      .attr('dominant-baseline', 'middle')
      .attr('font-family', FONT)
      .attr('font-size', 9)
      .attr('font-weight', 400)
      .attr('fill', C.nearBlack)
      .text(en);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Section: Info panel — QR code (generated client-side via qrcode library)
// ══════════════════════════════════════════════════════════════════════════════

function drawQRSection(g, qrUri, colW) {
  const qrSize = Math.min(QR_MAX_SIZE, INFO_PANEL_H - QR_PAD);
  const qrX = Math.floor((colW - qrSize) / 2);
  const qrY = Math.floor((INFO_PANEL_H - qrSize) / 2);

  if (qrUri) {
    g.append('image')
      .attr('href', qrUri)
      .attr('x', qrX)
      .attr('y', qrY)
      .attr('width', qrSize)
      .attr('height', qrSize);
  } else {
    g.append('rect')
      .attr('x', qrX)
      .attr('y', qrY)
      .attr('width', qrSize)
      .attr('height', qrSize)
      .attr('rx', 4)
      .attr('fill', C.bgLight)
      .attr('stroke', C.border)
      .attr('stroke-width', 1);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Section: Info panel (three-column wrapper)
// ══════════════════════════════════════════════════════════════════════════════

function drawInfoPanel(svg, y, mapUri, qrUri, svgInfos = {}) {
  const g = svg
    .append('g')
    .attr('id', 'info-panel')
    .attr('transform', `translate(0,${y})`);
  const colW = SVG_WIDTH / 3;

  g.append('rect')
    .attr('width', SVG_WIDTH)
    .attr('height', INFO_PANEL_H)
    .attr('fill', C.white);

  drawMapSection(g.append('g').attr('id', 'area-map'), mapUri, colW);
  drawLegendSection(
    g
      .append('g')
      .attr('id', 'legend')
      .attr('transform', `translate(${colW},0)`),
    colW,
    svgInfos,
  );
  drawQRSection(
    g
      .append('g')
      .attr('id', 'qr-code')
      .attr('transform', `translate(${colW * 2},0)`),
    qrUri,
    colW,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main render function
// ══════════════════════════════════════════════════════════════════════════════

export async function renderDiagramSVG(
  container,
  {
    stopId,
    stopsData,
    routes,
    orderedStops,
    city,
    poisData,
    railData,
    stopIconOverrides,
    trackOverrides,
    branchOverrides,
    labelOffsets,
    towardsText = null,
    preserveRouteOrder = false,
    interactive = false,
  },
) {
  d3.select(container).selectAll('*').remove();

  const stopData = stopsData[stopId] || [];
  const [lng, lat] = stopData;

  const hdrH = headerHeight(routes);
  const stopPoiTypes = applyStopIconOverrides(
    buildStopPoiMap(stopsData, poisData || []),
    stopIconOverrides,
  );
  const layout = buildRouteLayout(
    routes,
    orderedStops,
    stopId,
    stopsData,
    stopPoiTypes,
    { trackOverrides, branchOverrides, labelOffsets, preserveRouteOrder },
  );

  // The canvas keeps a fixed aspect ratio, so the route diagram is centred in
  // whatever height is left over and scaled down when it would overflow.
  const fit = fitDiagramArea({
    width: SVG_WIDTH,
    aspect: SVG_ASPECT,
    headerH: hdrH,
    infoPanelH: INFO_PANEL_H,
    naturalH: layout ? layout.height : DIAGRAM_TOP_PAD + DIAGRAM_BOTTOM_PAD,
  });
  const totalH = fit.totalH;

  // Read "Towards" text directly from the stop's suffix field in stops data.
  // The suffix is stored as e.g. "(Towards Magadi Road Metro Station)"; strip parens.
  const rawSuffix = stopsData[stopId]?.[3] || '';
  const towardsSuffix =
    towardsText == null
      ? rawSuffix.replace(/^\(|\)$/g, '').trim()
      : towardsText.trim();

  const arrivalUrl = `https://transitrouter.pages.dev/arrival/#/${city}/${stopId}`;
  const mapColW = Math.floor(SVG_WIDTH / 3);

  // Fetch async resources in parallel before rendering so the SVG is complete
  // on first paint — no flicker of placeholder content.
  const [mapUri, qrUri, bmtcSvgInfo, ksrtcSvgInfo, railSvgInfo] =
    await Promise.all([
      lng && lat
        ? captureMapAsDataUri(
            lng,
            lat,
            mapColW,
            INFO_PANEL_H,
            visibleStopPoints(stopsData, lng, lat, mapColW, INFO_PANEL_H),
            railData,
          )
        : Promise.resolve(null),
      generateQrDataUri(arrivalUrl),
      fetchSvgInfo(bmtcSvgUrl),
      fetchSvgInfo(ksrtcSvgUrl),
      fetchSvgInfo(railwaysSvgUrl),
    ]);

  const svg = d3
    .select(container)
    .append('svg')
    .attr('xmlns', 'http://www.w3.org/2000/svg')
    .attr('xmlns:xlink', 'http://www.w3.org/1999/xlink')
    .attr('width', SVG_WIDTH)
    .attr('height', totalH)
    .attr('viewBox', `0 0 ${SVG_WIDTH} ${totalH}`);

  svg
    .append('rect')
    .attr('id', 'page-bg')
    .attr('width', SVG_WIDTH)
    .attr('height', totalH)
    .attr('fill', C.white);

  addDefs(svg);

  const svgInfos = { bmtcSvgInfo, ksrtcSvgInfo, railSvgInfo };
  drawHeader(svg, stopId, stopsData, routes, hdrH, bmtcSvgInfo, towardsSuffix);
  drawRouteDiagram(
    svg,
    layout,
    stopId,
    stopsData,
    hdrH,
    fit,
    stopPoiTypes,
    svgInfos,
    interactive,
  );

  drawInfoPanel(svg, hdrH + fit.areaH, mapUri, qrUri, svgInfos);

  return svg.node();
}
