import * as d3 from 'd3';
import maplibregl from 'maplibre-gl';
import QRCode from 'qrcode';
import bmtcSvgUrl from 'url:../images/bmtc.svg';
import ksrtcSvgUrl from 'url:../images/ksrtc.svg';
import railwaysSvgUrl from 'url:../images/railways.svg';
import {
  createStopPositionMap,
  getStopName,
  normalizeStopId,
  matchesStop,
} from './algorithms';
import {
  SVG_WIDTH,
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
  LABEL_SPACE,
  CLUSTER_SPACING,
  TARGET_CLUSTER_SPAN,
  MAX_CLUSTER_SPACING,
  ROUTE_LINE_START_X,
  ROUTE_AREA_END_PCT,
  ROUTE_LINE_MIN_EXTEND,
  STOP_SPACING,
  MAX_STOP_STEP_PCT,
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
  CURRENT_PILL_X,
  CURRENT_PILL_W,
  CURRENT_PILL_TOP_PAD,
  DIAGRAM_BOTTOM_PAD,
  EXTRA_BOTTOM_PCT,
  LABEL_ROT,
  LABEL_FONT_SIZE,
  LABEL_CHAR_WIDTH,
  LABEL_ROW_OFFSET,
  LABEL_ICON_GAP,
  LABEL_MAX_DIST,
  LABEL_MAX_LINE_CHARS,
  LABEL_HORIZ_GAP,
  LABEL_LINE_SPACING_EXTRA,
  LABEL_ANCHOR_CLAMP,
  BRANCH_STROKE_W,
  MIN_SHARED_FOR_BRANCH,
  INFO_PANEL_H,
  LEGEND_INNER_W,
  LEGEND_VERT_PAD,
  LEGEND_ICON_TOP,
  LEGEND_ICON_SIZE,
  LEGEND_ICON_TEXT_GAP,
  QR_MAX_SIZE,
  QR_PAD,
  C,
  FONT,
  FONT_KN,
} from './theme';

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
// Stop label helpers
// ══════════════════════════════════════════════════════════════════════════════

// Splits a stop name into lines of at most LABEL_MAX_LINE_CHARS characters,
// breaking only at space or "/" boundaries. Returns a single-element array for
// short names so callers always receive an array.
function splitLabelName(name) {
  if (name.length <= LABEL_MAX_LINE_CHARS) return [name];
  const words = name.split(/[\s/]+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= LABEL_MAX_LINE_CHARS) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [name];
}

// ══════════════════════════════════════════════════════════════════════════════
// Badge layout helpers
// ══════════════════════════════════════════════════════════════════════════════

function badgeWidth(routeId) {
  return (
    BADGE_PADDING_H +
    BUS_ICON_W +
    BADGE_ICON_TEXT_GAP +
    routeId.length * (BADGE_FONT_SIZE * BADGE_CHAR_SCALE) +
    BADGE_PADDING_H
  );
}

function layoutBadges(routeIds) {
  const rows = [];
  let row = [],
    x = BADGE_ROW_MARGIN;
  for (const id of routeIds) {
    const w = badgeWidth(id);
    if (x + w > SVG_WIDTH - BADGE_ROW_MARGIN && row.length > 0) {
      rows.push(row);
      row = [];
      x = BADGE_ROW_MARGIN;
    }
    row.push({ id, w, x });
    x += w + BADGE_INNER_GAP;
  }
  if (row.length) rows.push(row);
  return rows;
}

function headerHeight(routes) {
  const ids = [...new Set(routes.map((r) => r.routeId))];
  const rows = layoutBadges(ids);
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
      Math.max(20, Math.ceil(r.routeId.length * 7.5 + 10)),
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

// ══════════════════════════════════════════════════════════════════════════════
// Route clustering by terminal stop — each unique terminal gets its own
// cluster/route line, guaranteeing exactly one terminal icon per line.
// ══════════════════════════════════════════════════════════════════════════════

function clusterRoutesByTerminal(routes) {
  const groups = new Map();
  routes.forEach((route) => {
    const seq = route.seqForGrouping ?? route.stopSequence ?? [];
    const terminal = String(
      seq[seq.length - 1] ?? route.destinationStopId ?? 'unknown',
    );
    if (!groups.has(terminal)) groups.set(terminal, []);
    groups.get(terminal).push(route);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

// ══════════════════════════════════════════════════════════════════════════════
// Stop label overlap avoidance — assigns each label to an above or below row
// so that labels don't overlap after ±30° rotation.  Labels alternate between
// above and below to distribute them evenly on both sides of the stop icons.
// ══════════════════════════════════════════════════════════════════════════════

function layoutStopLabels(labelData) {
  const COS = Math.abs(Math.cos((LABEL_ROT * Math.PI) / 180)); // ≈ 0.866
  const sorted = [...labelData].sort((a, b) => a.x - b.x);
  const GAP = LABEL_HORIZ_GAP;

  // All labels go above their stop marker (bottom-left → top-right orientation).
  // MAX_ROWS is derived from LABEL_MAX_DIST so labels never exceed 40 px from
  // their stop icon: floor((40 - 5) / 11) = 3, giving rows 0, 1, 2, 3.
  const MAX_ROWS = Math.floor(
    (LABEL_MAX_DIST - LABEL_ICON_GAP) / LABEL_ROW_OFFSET,
  );

  const rowEndX = [];
  const tryPlace = (row, start, hSpan) => {
    while (rowEndX.length <= row) rowEndX.push(-Infinity);
    if (start >= rowEndX[row] + GAP) {
      rowEndX[row] = start + hSpan;
      return true;
    }
    return false;
  };

  return sorted.map((item) => {
    const longestLineLen = item.lines
      ? Math.max(...item.lines.map((l) => l.length))
      : item.name.length;
    const textW = longestLineLen * LABEL_CHAR_WIDTH;
    const hSpan = textW * COS;
    const start = item.x;

    for (let r = 0; r <= MAX_ROWS; r++) {
      if (tryPlace(r, start, hSpan)) return { ...item, row: r, below: false };
    }
    // Fallback: clamp to the furthest allowed row to honour LABEL_MAX_DIST
    tryPlace(MAX_ROWS, start, hSpan);
    return { ...item, row: MAX_ROWS, below: false };
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Branch detection — finds pairs of clusters that share stops and should be
// connected with a vertical branch-point connector.
// ══════════════════════════════════════════════════════════════════════════════

function findClusterBranches(clusters, orderedStops, stopPosMap) {
  if (clusters.length <= 1) return [];

  // Build per-cluster stop sets
  const clusterStops = clusters.map((cluster) => {
    const stops = new Set();
    cluster.forEach((route) => {
      (route.seqForGrouping || route.stopSequence)
        .map(String)
        .forEach((s) => stops.add(s));
    });
    return stops;
  });

  const branches = []; // { parentIdx, childIdx, branchStopId }

  for (let child = 1; child < clusters.length; child++) {
    let bestParent = -1;
    let bestBranchStop = null;
    let bestShared = 0;

    for (let parent = 0; parent < child; parent++) {
      let shared = 0;
      let lastShared = null;

      for (const stop of orderedStops) {
        if (
          clusterStops[child].has(stop) &&
          clusterStops[parent].has(stop) &&
          stopPosMap[stop]
        ) {
          shared++;
          lastShared = stop;
        }
      }

      if (shared > bestShared) {
        bestShared = shared;
        bestParent = parent;
        bestBranchStop = lastShared;
      }
    }

    if (
      bestParent !== -1 &&
      bestShared >= MIN_SHARED_FOR_BRANCH &&
      bestBranchStop
    ) {
      branches.push({
        parentIdx: bestParent,
        childIdx: child,
        branchStopId: bestBranchStop,
      });
    }
  }

  return branches;
}

// ══════════════════════════════════════════════════════════════════════════════
// Async helpers — map capture and QR code generation
// ══════════════════════════════════════════════════════════════════════════════

function captureMapAsDataUri(lng, lat, w, h) {
  return new Promise((resolve) => {
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
      style: '/data/style.json',
      center: [lng, lat],
      zoom: 16,
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
      const style = map.getStyle();
      for (const layer of style.layers) {
        const isLabel = layer.type === 'symbol';
        const isBuilding =
          layer['source-layer'] === 'building' || layer.id.includes('building');
        const isLanduse =
          layer['source-layer'] === 'landuse' ||
          layer['source-layer'] === 'landcover' ||
          layer.id.includes('landuse') ||
          layer.id.includes('landcover');
        if (isLabel || isBuilding || isLanduse) {
          try {
            map.setLayoutProperty(layer.id, 'visibility', 'none');
          } catch {
            /* skip */
          }
        }
      }

      map.once('idle', () => {
        clearTimeout(timer);
        try {
          finish(map.getCanvas().toDataURL('image/png'));
        } catch {
          finish(null);
        }
      });
    });
  });
}

async function generateQrDataUri(url) {
  try {
    return await QRCode.toDataURL(url, {
      width: 200,
      margin: 0,
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch {
    return null;
  }
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

  const g = svg.append('g').attr('id', 'header');

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
  const towardsLine = '(' + towardsSuffix + ')' || null;

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
      .attr('x', nameX)
      .attr('y', HDR_EN_Y)
      .attr('font-family', FONT)
      .attr('font-size', HDR_EN_SIZE)
      .attr('font-weight', 500)
      .attr('fill', C.white)
      .text(displayName);
    if (towardsLine) {
      g.append('text')
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

  const ids = [...new Set(routes.map((r) => r.routeId))];
  const badgeRows = layoutBadges(ids);
  let badgeY = BADGE_TOP_PAD;

  badgeRows.forEach((row) => {
    row.forEach(({ id, w, x: bx }) => {
      const bg = badgesG
        .append('g')
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
        .text(id);
    });
    badgeY += BADGE_H + BADGE_GAP_X;
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Section: Route diagram (cluster-based rendering with branch connectors)
// ══════════════════════════════════════════════════════════════════════════════

function getContiguousSegments(sorted) {
  if (!sorted.length) return [];
  const segs = [];
  let start = sorted[0],
    prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      segs.push([start, prev]);
      start = prev = sorted[i];
    }
  }
  segs.push([start, prev]);
  return segs;
}

function drawRouteDiagram(
  svg,
  routes,
  orderedStops,
  currentStopId,
  stopsData,
  yBase,
  extraTopPad = 0,
  extraBottomPad = 0,
) {
  const clusters = clusterRoutesByTerminal(routes);
  const nClusters = clusters.length;
  if (nClusters === 0) return 0;

  const stopPosMap = createStopPositionMap(
    routes,
    orderedStops,
    currentStopId,
    stopsData,
    MAX_STOP_STEP_PCT,
  );

  // Identify the last displayed stop for each route, keyed by cluster index.
  // terminalClusterMap: stopId → Set<clusterIndex> so that a stop is only
  // rendered as a terminal on the cluster rows whose routes actually end there,
  // not on rows where it's merely an intermediate stop for a longer route.
  const terminalClusterMap = new Map();
  clusters.forEach((cluster, ci) => {
    cluster.forEach((route) => {
      const curNorm = normalizeStopId(currentStopId);
      const curIdx = route.stopSequence.findIndex((id) =>
        matchesStop(id, curNorm),
      );
      if (curIdx < 0) return;
      const forwardStrs = new Set(route.stopSequence.slice(curIdx).map(String));
      let lastInDiagram = null;
      for (const sid of orderedStops) {
        if (sid === currentStopId) continue;
        if (forwardStrs.has(String(sid))) lastInDiagram = sid;
      }
      if (lastInDiagram) {
        if (!terminalClusterMap.has(lastInDiagram))
          terminalClusterMap.set(lastInDiagram, new Set());
        terminalClusterMap.get(lastInDiagram).add(ci);
      }
    });
  });

  // Compute effective cluster spacing — must be tall enough to fit label rows,
  // and scales to fill available space when there are few clusters.
  const maxLabelRows = Math.max(
    1,
    ...clusters.map((cluster) => {
      const packed = packClusterLabels(cluster);
      return Math.max(0, ...packed.map((p) => p.row)) + 1;
    }),
  );
  const minSpacing = Math.max(
    CLUSTER_SPACING,
    maxLabelRows * (LABEL_BOX_H + 2) + 6,
  );
  const effectiveClusterSpacing =
    nClusters > 1
      ? Math.max(
          minSpacing,
          Math.min(
            MAX_CLUSTER_SPACING,
            Math.round(TARGET_CLUSTER_SPAN / (nClusters - 1)),
          ),
        )
      : minSpacing;

  const clusterY = (i) =>
    LABEL_SPACE + extraTopPad + i * effectiveClusterSpacing;

  const naturalH =
    LABEL_SPACE +
    (nClusters - 1) * effectiveClusterSpacing +
    DIAGRAM_BOTTOM_PAD;
  const totalH = naturalH + 2 * extraTopPad + extraBottomPad;

  // Map each ordered stop to the set of cluster indices that use it
  const stopClusters = {};
  clusters.forEach((cluster, ci) => {
    orderedStops.forEach((sid) => {
      if (sid === currentStopId) return;
      const norm = normalizeStopId(sid);
      if (
        cluster.some((r) => r.stopSequence.some((id) => matchesStop(id, norm)))
      ) {
        (stopClusters[sid] ??= new Set()).add(ci);
      }
    });
  });

  const displayedStops = orderedStops.filter(
    (sid) => sid !== currentStopId && stopClusters[sid]?.size > 0,
  );

  // Grid layout — routes on the y-axis, stop sequence on the x-axis.
  // Each stop's column = length of its longest predecessor chain through
  // displayed stops on any route (topological depth in the DAG). This groups
  // stops from different routes that are at the same sequence generation into
  // the same column, and guarantees that consecutive displayed stops on any
  // single route land in consecutive columns with no gaps.
  const displayedSet = new Set(displayedStops);
  const normCur = normalizeStopId(currentStopId);

  // For each displayed stop, record the displayed stops that immediately
  // precede it (skipping non-displayed stops) in every route's sequence.
  const predecessors = {};
  displayedStops.forEach((sid) => {
    predecessors[sid] = new Set();
  });
  routes.forEach((route) => {
    const curIdx = route.stopSequence.findIndex((id) =>
      matchesStop(id, normCur),
    );
    if (curIdx < 0) return;
    let prev = null;
    for (const stopId of route.stopSequence.slice(curIdx + 1)) {
      const sid = String(stopId);
      if (displayedSet.has(sid)) {
        if (prev !== null) predecessors[sid].add(prev);
        prev = sid;
      }
    }
  });

  // Longest predecessor chain = column depth (memoised DFS).
  const colDepth = {};
  function computeColDepth(sid) {
    if (colDepth[sid] !== undefined) return colDepth[sid];
    colDepth[sid] = 0; // sentinel: prevents re-entry on cycles
    let d = 0;
    for (const pred of predecessors[sid])
      d = Math.max(d, computeColDepth(pred) + 1);
    return (colDepth[sid] = d);
  }
  displayedStops.forEach(computeColDepth);

  // Compact the depths to consecutive 0-based column indices (removes holes
  // that would appear if some depth values are skipped globally).
  const uniqueDepths = [
    ...new Set(displayedStops.map((sid) => colDepth[sid])),
  ].sort((a, b) => a - b);
  const depthToColIdx = Object.fromEntries(uniqueDepths.map((d, i) => [d, i]));

  // Constant column spacing — spread stops evenly across the canvas width.
  const numCols = uniqueDepths.length;
  const availableW = SVG_WIDTH * ROUTE_AREA_END_PCT - ROUTE_LINE_START_X;
  const effectiveSpacing =
    numCols > 0
      ? Math.max(STOP_SPACING, Math.floor(availableW / numCols))
      : STOP_SPACING;

  const stopXMap = {};
  displayedStops.forEach((sid) => {
    stopXMap[sid] =
      ROUTE_LINE_START_X +
      effectiveSpacing * (depthToColIdx[colDepth[sid]] + 1);
  });

  const g = svg
    .append('g')
    .attr('id', 'route-diagram')
    .attr('transform', `translate(0,${yBase})`);
  g.append('rect')
    .attr('width', SVG_WIDTH)
    .attr('height', totalH)
    .attr('fill', C.white);

  const linesG = g.append('g').attr('id', 'cluster-lines');
  const pillsG = g.append('g').attr('id', 'stop-pills');
  const heroG = g.append('g').attr('id', 'current-stop-pill');
  const labelsG = g.append('g').attr('id', 'stop-labels');

  // ── Cluster lines and route label boxes ──────────────────────────────────────

  clusters.forEach((cluster, ci) => {
    const cy = clusterY(ci);

    let maxX = ROUTE_LINE_START_X + ROUTE_LINE_MIN_EXTEND;
    orderedStops.forEach((sid) => {
      if (!stopClusters[sid]?.has(ci)) return;
      const x = stopXMap[sid];
      if (x !== undefined) maxX = Math.max(maxX, x);
    });

    linesG
      .append('line')
      .attr('x1', ROUTE_LINE_START_X)
      .attr('y1', cy)
      .attr('x2', maxX)
      .attr('y2', cy)
      .attr('stroke', C.primary)
      .attr('stroke-width', 4)
      .attr('stroke-linecap', 'round');

    // ── Route ID pills (left label area) ─────────────────────────────────────
    const packed = packClusterLabels(cluster);
    const numRows = Math.max(0, ...packed.map((p) => p.row)) + 1;
    const totalLabelH = numRows * LABEL_BOX_H + (numRows - 1) * 2;
    const labelStartY = cy - totalLabelH / 2;

    packed.forEach(({ route, x, w, row }) => {
      const labelY = labelStartY + row * (LABEL_BOX_H + 2);

      linesG
        .append('rect')
        .attr('x', x)
        .attr('y', labelY)
        .attr('width', w)
        .attr('height', LABEL_BOX_H)
        .attr('rx', LABEL_BOX_RX)
        .attr('fill', C.primary)
        .attr('filter', 'url(#ds)');

      const maxChars = Math.floor((w - LABEL_BOX_PAD) / LABEL_BOX_CHAR_W);
      const label =
        route.routeId.length > maxChars
          ? route.routeId.slice(0, Math.max(1, maxChars - 1)) + '\u2026'
          : route.routeId;

      linesG
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

  // ── Branch connectors — vertical line at the shared-stop fork point ──────────

  const branches = findClusterBranches(clusters, orderedStops, stopPosMap);
  branches.forEach(({ parentIdx, childIdx, branchStopId }) => {
    if (!stopXMap[branchStopId]) return;
    const bx = stopXMap[branchStopId];
    const py = clusterY(parentIdx);
    const cy = clusterY(childIdx);

    linesG
      .append('line')
      .attr('x1', bx)
      .attr('y1', py)
      .attr('x2', bx)
      .attr('y2', cy)
      .attr('stroke', C.primary)
      .attr('stroke-width', BRANCH_STROKE_W)
      .attr('stroke-linecap', 'round')
      .attr('opacity', 0.5);
  });

  // ── Stop marker pills ────────────────────────────────────────────────────────
  // Shared stops (isCommon / clusterSet.size > 1) get a wider pill that spans
  // all cluster rows they appear on, keeping them visually connected and
  // horizontally aligned across route groups.

  orderedStops.forEach((sid) => {
    if (sid === currentStopId) return;
    const clusterSet = stopClusters[sid];
    if (!clusterSet || clusterSet.size === 0) return;

    const x = stopXMap[sid];
    if (x === undefined) return;
    const sorted = Array.from(clusterSet).sort((a, b) => a - b);
    const segs = getContiguousSegments(sorted);
    const terminalClusters = terminalClusterMap.get(sid);

    segs.forEach(([first, last]) => {
      // Split the contiguous cluster segment into runs of the same marker type
      // (terminal vs non-terminal) so each run can be drawn independently.
      const runs = [];
      let runStart = first;
      let runIsTerminal = terminalClusters?.has(first) ?? false;
      for (let ci = first + 1; ci <= last; ci++) {
        const ciIsTerminal = terminalClusters?.has(ci) ?? false;
        if (ciIsTerminal !== runIsTerminal) {
          runs.push({
            start: runStart,
            end: ci - 1,
            isTerminal: runIsTerminal,
          });
          runStart = ci;
          runIsTerminal = ciIsTerminal;
        }
      }
      runs.push({ start: runStart, end: last, isTerminal: runIsTerminal });

      runs.forEach(({ start, end, isTerminal }) => {
        if (isTerminal) {
          // Filled blue circle; connect multi-row spans with a thin vertical line
          if (start !== end) {
            pillsG
              .append('line')
              .attr('x1', x)
              .attr('y1', clusterY(start))
              .attr('x2', x)
              .attr('y2', clusterY(end))
              .attr('stroke', C.primary)
              .attr('stroke-width', 2);
          }
          for (let ci = start; ci <= end; ci++) {
            pillsG
              .append('circle')
              .attr('cx', x)
              .attr('cy', clusterY(ci))
              .attr('r', TERMINAL_RADIUS)
              .attr('fill', C.primary)
              .append('title')
              .text(getStopName(sid, stopsData));
          }
        } else {
          // White pill spanning all non-terminal rows in this run
          const pillW = PILL_W_SMALL;
          const y1 = clusterY(start) - PILL_OVERHANG;
          const y2 = clusterY(end) + PILL_OVERHANG;
          pillsG
            .append('rect')
            .attr('x', x - pillW / 2)
            .attr('y', y1)
            .attr('width', pillW)
            .attr('height', y2 - y1)
            .attr('rx', pillW / 2)
            .attr('fill', C.white)
            .attr('stroke', C.pillStroke)
            .attr('stroke-width', 1)
            .append('title')
            .text(getStopName(sid, stopsData));
        }
      });
    });
  });

  // ── Current-stop pill (spans all cluster rows) ───────────────────────────────

  const pillTop = clusterY(0) - CURRENT_PILL_TOP_PAD;
  const pillBottom = clusterY(nClusters - 1) + PILL_OVERHANG;
  heroG
    .append('rect')
    .attr('x', CURRENT_PILL_X)
    .attr('y', pillTop)
    .attr('width', CURRENT_PILL_W)
    .attr('height', pillBottom - pillTop)
    .attr('rx', CURRENT_PILL_W / 2)
    .attr('fill', C.white)
    .attr('stroke', C.primary)
    .attr('stroke-width', 2)
    .append('title')
    .text(getStopName(currentStopId, stopsData));

  // ── Stop labels — rotated, with overlap avoidance ────────────────────────────

  // Collect one label per unique stop name using the global position map.
  // For stops shared across clusters, anchor the label to the topmost cluster row.
  const seenNames = new Set();
  const rawLabels = [];

  orderedStops.forEach((sid) => {
    if (sid === currentStopId) return;
    if (!stopXMap[sid] || !stopClusters[sid]) return;
    const name = getStopName(sid, stopsData);
    if (seenNames.has(name)) return;
    seenNames.add(name);
    const x = stopXMap[sid];
    const clusterArr = Array.from(stopClusters[sid]);
    const topCluster = Math.min(...clusterArr);
    const isTermStop = terminalClusterMap.get(sid)?.has(topCluster) ?? false;
    const overhang = isTermStop ? TERMINAL_RADIUS : PILL_OVERHANG;
    const lines = splitLabelName(name);
    rawLabels.push({
      name,
      lines,
      x,
      markerTopY: clusterY(topCluster) - overhang,
      markerBottomY: clusterY(topCluster) + overhang,
    });
  });

  rawLabels.sort((a, b) => a.x - b.x);

  const layouted = layoutStopLabels(rawLabels);

  // All labels sit above their stop marker and use the same rotation so the
  // text direction is consistently bottom-left → top-right across the diagram.
  // Multi-line labels stack their lines in the rotated frame: the last line is
  // closest to the stop marker (dy=0) and each earlier line sits at a negative
  // dy so it renders further from the marker (upper-left in SVG coordinates).
  const LABEL_LINE_SPACING = LABEL_FONT_SIZE + LABEL_LINE_SPACING_EXTRA;
  layouted.forEach(({ name, lines, x, markerTopY, row }) => {
    const anchorY =
      markerTopY -
      Math.min(LABEL_ICON_GAP + row * LABEL_ROW_OFFSET, LABEL_ANCHOR_CLAMP);
    const labelLines = lines || [name];
    const numLines = labelLines.length;
    const textEl = labelsG
      .append('g')
      .attr('transform', `translate(${x},${anchorY}) rotate(${LABEL_ROT})`)
      .append('text')
      .attr('text-anchor', 'start')
      .attr('dominant-baseline', 'auto')
      .attr('font-family', FONT)
      .attr('font-size', LABEL_FONT_SIZE)
      .attr('font-weight', 400)
      .attr('fill', C.labelMuted);
    labelLines.forEach((line, lineIdx) => {
      // First tspan: shift up so all lines together are anchored at the bottom
      // Subsequent tspans: step back down one line at a time
      const dy =
        lineIdx === 0
          ? -(numLines - 1) * LABEL_LINE_SPACING
          : LABEL_LINE_SPACING;
      textEl.append('tspan').attr('x', 0).attr('dy', dy).text(line);
    });
  });

  return totalH;
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
  const items = [
    { draw: (ig) => drawYouAreHereIcon(ig), en: 'You are here' },
    { draw: (ig) => drawMetroIcon(ig), en: 'Metro Station' },
    {
      draw: (ig) => drawMajorBusIcon(ig, bmtcSvgInfo),
      en: 'Major Bus Station',
    },
    {
      draw: (ig) => drawLongDistIcon(ig, ksrtcSvgInfo),
      en: 'Long Distance Bus',
    },
    { draw: (ig) => drawRailwayIcon(ig, railSvgInfo), en: 'Railway Station' },
    { draw: (ig) => drawAirportIcon(ig), en: 'Airport' },
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
  { stopId, stopsData, routes, orderedStops, city },
) {
  d3.select(container).selectAll('*').remove();

  const stopData = stopsData[stopId] || [];
  const [lng, lat] = stopData;

  const hdrH = headerHeight(routes);
  const clusters = clusterRoutesByTerminal(routes);
  const nClusters = Math.max(clusters.length, 1);

  const maxLabelRows = Math.max(
    1,
    ...clusters.map((cluster) => {
      const packed = packClusterLabels(cluster);
      return Math.max(0, ...packed.map((p) => p.row)) + 1;
    }),
  );
  const minSpacingOuter = Math.max(
    CLUSTER_SPACING,
    maxLabelRows * (LABEL_BOX_H + 2) + 6,
  );
  const effectiveClusterSpacing =
    nClusters > 1
      ? Math.max(
          minSpacingOuter,
          Math.min(
            MAX_CLUSTER_SPACING,
            Math.round(TARGET_CLUSTER_SPAN / (nClusters - 1)),
          ),
        )
      : minSpacingOuter;

  const naturalDiagramH =
    LABEL_SPACE +
    (nClusters - 1) * effectiveClusterSpacing +
    DIAGRAM_BOTTOM_PAD;
  const extraTopPad = 0;
  const baseTotalH = hdrH + naturalDiagramH + INFO_PANEL_H;
  const extraBottomPad = Math.round(baseTotalH * EXTRA_BOTTOM_PCT);
  const routeDiagramH = naturalDiagramH + extraBottomPad;
  const totalH = baseTotalH + extraBottomPad;

  // Read "Towards" text directly from the stop's suffix field in stops data.
  // The suffix is stored as e.g. "(Towards Magadi Road Metro Station)"; strip parens.
  const rawSuffix = stopsData[stopId]?.[3] || '';
  const towardsSuffix = rawSuffix.replace(/^\(|\)$/g, '').trim();

  const arrivalUrl = `https://transitrouter.pages.dev/arrival/#/${city}/${stopId}`;
  const mapColW = Math.floor(SVG_WIDTH / 3);

  // Fetch async resources in parallel before rendering so the SVG is complete
  // on first paint — no flicker of placeholder content.
  const [mapUri, qrUri, bmtcSvgInfo, ksrtcSvgInfo, railSvgInfo] =
    await Promise.all([
      lng && lat
        ? captureMapAsDataUri(lng, lat, mapColW, INFO_PANEL_H)
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
    routes,
    orderedStops,
    stopId,
    stopsData,
    hdrH,
    extraTopPad,
    extraBottomPad,
  );

  const yInfoPanel = hdrH + routeDiagramH;
  drawInfoPanel(svg, yInfoPanel, mapUri, qrUri, svgInfos);

  return svg.node();
}
