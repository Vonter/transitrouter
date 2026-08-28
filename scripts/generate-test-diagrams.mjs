#!/usr/bin/env node

// Standalone script to generate test diagram SVGs and PNGs for BLR stops.
// Reimplements just the route-diagram section using string-based SVG generation
// (no browser DOM or D3 required).
//
// Usage: node scripts/generate-test-diagrams.mjs [stopId1 stopId2 ...]
// Outputs to: scripts/output/

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  computeSpiderLayout,
  fitDiagramArea,
} from '../assets/diagram/layout.mjs';
import { DEFAULTS } from '../assets/diagram/theme.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(__dirname, 'output');

// ── Load BLR data ────────────────────────────────────────────────────────────

const servicesData = JSON.parse(
  readFileSync(join(ROOT, 'data/blr/services.min.json'), 'utf8'),
);
const stopsData = JSON.parse(
  readFileSync(join(ROOT, 'data/blr/stops.min.json'), 'utf8'),
);
const rankingData = JSON.parse(
  readFileSync(join(ROOT, 'data/blr/ranking.min.json'), 'utf8'),
);

// ── Algorithm functions (mirrored from assets/diagram/algorithms.js) ────────

function normalizeStopId(stopId) {
  const str = String(stopId);
  return { str, num: parseInt(stopId, 10) };
}

function matchesStop(stopId, normalized) {
  return stopId === normalized.num || String(stopId) === normalized.str;
}

function findStopIndex(sequence, stopId, norm) {
  return sequence.findIndex((id) => matchesStop(id, norm));
}

function getStopName(stopId) {
  return stopsData[stopId]?.[2] || String(stopId);
}

function findRoutesForStop(stopId) {
  const norm = normalizeStopId(stopId);
  const routes = [];
  for (const [routeId, routeData] of Object.entries(servicesData)) {
    for (const [destId, sequences] of Object.entries(routeData)) {
      if (destId === 'name') continue;
      if (
        sequences.some(
          (seq) => seq.includes(norm.num) || seq.includes(norm.str),
        )
      ) {
        routes.push({
          routeId,
          routeName: routeData.name,
          destinationStopId: destId,
          stopSequence: sequences[0],
        });
        break;
      }
    }
  }
  return routes;
}

function calculateRouteTripCount(routeId, scheduleData) {
  if (scheduleData?.services) {
    const total = scheduleData.services
      .filter((s) => s.no === routeId)
      .reduce((sum, s) => sum + (s.trip_count || 0), 0);
    if (total > 0) return total;
  }
  const rd = servicesData[routeId];
  if (!rd) return 0;
  return Object.entries(rd)
    .filter(([key]) => key !== 'name')
    .reduce((sum, [, seqs]) => sum + seqs.length, 0);
}

function getAllStopsFromRoutes(routes, currentStopId) {
  const norm = normalizeStopId(currentStopId);
  const stopPositions = new Map();
  routes.forEach((route) => {
    const curIdx = findStopIndex(route.stopSequence, currentStopId, norm);
    if (curIdx === -1) return;
    route.stopSequence.slice(curIdx).forEach((id, idx) => {
      const sid = String(id);
      if (!stopPositions.has(sid)) stopPositions.set(sid, new Set());
      stopPositions.get(sid).add(idx);
    });
  });
  return Array.from(stopPositions.entries())
    .map(([stopId, positions]) => ({
      stopId,
      avgPosition:
        Array.from(positions).reduce((a, b) => a + b, 0) / positions.size,
    }))
    .sort((a, b) => a.avgPosition - b.avgPosition)
    .map((s) => s.stopId);
}

function selectMajorStops(stops, terminalStops, targetMajorStops) {
  const stopsWithRankings = stops.map((stopId) => ({
    stopId,
    ranking: rankingData[stopId] || 0,
    isTerminal: terminalStops.has(stopId),
  }));
  stopsWithRankings.sort((a, b) => b.ranking - a.ranking);
  const maxRanking = stopsWithRankings[0]?.ranking || 0;
  const significanceThreshold = maxRanking * 0.2;
  const selected = new Set();
  stopsWithRankings.forEach((stop) => {
    if (stop.isTerminal || stop.ranking >= significanceThreshold)
      selected.add(stop.stopId);
  });
  for (const stop of stopsWithRankings) {
    if (selected.size >= targetMajorStops && stop.ranking < maxRanking * 0.5)
      break;
    selected.add(stop.stopId);
  }
  const minStops = Math.min(5, stops.length);
  if (selected.size < minStops) {
    for (const stop of stopsWithRankings) {
      if (selected.size >= minStops) break;
      selected.add(stop.stopId);
    }
  }
  return selected;
}

function sortServices(a, b) {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function groupRoutesByForwardStops(routes, currentStopId, orderedStops) {
  const norm = normalizeStopId(currentStopId);
  const orderedSet = new Set(orderedStops);
  const routeForwardStops = routes.map((route) => {
    const curIdx = findStopIndex(route.stopSequence, currentStopId, norm);
    if (curIdx === -1) return [];
    return route.stopSequence
      .slice(curIdx)
      .map(String)
      .filter((s) => orderedSet.has(s));
  });
  const groupMap = new Map();
  routes.forEach((route, i) => {
    const key = routeForwardStops[i].join(',');
    if (!groupMap.has(key))
      groupMap.set(key, { routes: [], forwardStops: routeForwardStops[i] });
    groupMap.get(key).routes.push(route);
  });
  return Array.from(groupMap.values()).sort(
    (a, b) => b.routes.length - a.routes.length,
  );
}

function orderGroupsBySimilarity(routeGroups) {
  if (routeGroups.length <= 2) return routeGroups;

  const stopSets = routeGroups.map((g) => new Set(g.forwardStops));
  const similarity = (a, b) => {
    let shared = 0;
    for (const s of a) if (b.has(s)) shared++;
    return shared;
  };

  const used = new Set();
  const ordered = [];
  const idxOf = [];

  let best = 0;
  for (let i = 1; i < routeGroups.length; i++) {
    if (routeGroups[i].routes.length > routeGroups[best].routes.length)
      best = i;
  }
  ordered.push(routeGroups[best]);
  idxOf.push(best);
  used.add(best);

  while (ordered.length < routeGroups.length) {
    const lastSet = stopSets[idxOf[idxOf.length - 1]];
    let nextIdx = -1;
    let maxSim = -1;
    for (let i = 0; i < routeGroups.length; i++) {
      if (used.has(i)) continue;
      const sim = similarity(lastSet, stopSets[i]);
      if (
        sim > maxSim ||
        (sim === maxSim &&
          routeGroups[i].routes.length > routeGroups[nextIdx].routes.length)
      ) {
        maxSim = sim;
        nextIdx = i;
      }
    }
    ordered.push(routeGroups[nextIdx]);
    idxOf.push(nextIdx);
    used.add(nextIdx);
  }

  return ordered;
}

// ── Compute diagram data (mirrored from dataLoader.js) ──────────────────────

function computeDiagramData(
  stopId,
  {
    targetMajorStops = Number(process.env.TARGET_MAJOR_STOPS) || 5,
    countMajorRoutes = Number(process.env.COUNT_MAJOR_ROUTES) || 8,
  } = {},
) {
  let scheduleData = null;
  try {
    scheduleData = JSON.parse(
      readFileSync(join(ROOT, `data/blr/schedule/${stopId}.json`), 'utf8'),
    );
  } catch {}

  const routesFound = findRoutesForStop(stopId);
  if (routesFound.length === 0) return null;

  const routesWithTrips = routesFound.map((route) => ({
    ...route,
    tripCount: calculateRouteTripCount(route.routeId, scheduleData),
    destinationRanking: rankingData[route.destinationStopId] || 0,
  }));

  routesWithTrips.sort((a, b) => {
    if (a.tripCount !== b.tripCount) return b.tripCount - a.tripCount;
    return b.destinationRanking - a.destinationRanking;
  });

  const norm = normalizeStopId(stopId);
  const topRoutes = routesWithTrips.slice(0, countMajorRoutes);
  topRoutes.forEach((route) => {
    const curIdx = findStopIndex(route.stopSequence, stopId, norm);
    route.seqForGrouping =
      curIdx === -1
        ? route.stopSequence.map(String)
        : route.stopSequence.slice(curIdx).map(String);
  });

  // Sort by downstream stop-name commonality
  const stats = [];
  topRoutes.forEach((r) => {
    const seq = (r.seqForGrouping || r.stopSequence).map(String);
    for (let i = 1; i < seq.length; i++) {
      if (!stats[i]) stats[i] = new Map();
      const name = getStopName(seq[i]);
      stats[i].set(name, (stats[i].get(name) || 0) + 1);
    }
  });
  const routes = [...topRoutes].sort((a, b) => {
    const sa = (a.seqForGrouping || a.stopSequence).map(String);
    const sb = (b.seqForGrouping || b.stopSequence).map(String);
    for (let i = 1, max = Math.max(sa.length, sb.length); i < max; i++) {
      const na = sa[i] === undefined ? undefined : getStopName(sa[i]);
      const nb = sb[i] === undefined ? undefined : getStopName(sb[i]);
      if (na === nb) continue;
      const map = stats[i] || new Map();
      const ca = na === undefined ? -1 : map.get(na) || 0;
      const cb = nb === undefined ? -1 : map.get(nb) || 0;
      if (ca !== cb) return cb - ca;
      if (na === undefined) return 1;
      if (nb === undefined) return -1;
      const cmp = String(na).localeCompare(String(nb));
      if (cmp !== 0) return cmp;
    }
    return sortServices(a.routeId, b.routeId);
  });

  const allMajorStops = new Set([stopId]);
  const stopRouteCount = new Map();

  routes.forEach((route) => {
    const curIdx = findStopIndex(route.stopSequence, stopId, norm);
    if (curIdx === -1) return;
    const fwd = route.stopSequence.slice(curIdx).map(String);
    fwd.forEach((s) => stopRouteCount.set(s, (stopRouteCount.get(s) || 0) + 1));
    if (fwd.length > 0) allMajorStops.add(fwd[fwd.length - 1]);
    const ranked = fwd
      .map((s) => ({ stopId: s, ranking: rankingData[s] || 0 }))
      .sort((a, b) => b.ranking - a.ranking);
    ranked
      .slice(0, targetMajorStops)
      .forEach((s) => allMajorStops.add(s.stopId));
  });

  const maxMajorStops = countMajorRoutes + targetMajorStops + 1;
  if (allMajorStops.size > maxMajorStops + 1) {
    const terminalStops = new Set(
      routes.map((r) => String(r.stopSequence[r.stopSequence.length - 1])),
    );
    const pruneCandidates = [...allMajorStops]
      .filter((s) => s !== stopId && !terminalStops.has(s))
      .map((s) => ({
        stopId: s,
        ranking: rankingData[s] || 0,
        routeCount: stopRouteCount.get(s) || 0,
      }))
      .sort((a, b) => {
        if (a.routeCount !== b.routeCount) return a.routeCount - b.routeCount;
        return a.ranking - b.ranking;
      });

    while (
      allMajorStops.size > maxMajorStops + 1 &&
      pruneCandidates.length > 0
    ) {
      allMajorStops.delete(pruneCandidates.shift().stopId);
    }
  }

  const allStops = getAllStopsFromRoutes(routes, stopId);
  const orderedStops = allStops.filter((s) => allMajorStops.has(s));
  const stopRouteCounts = {};
  orderedStops.forEach((s) => {
    stopRouteCounts[s] = stopRouteCount.get(s) || 0;
  });
  const routeGroups = orderGroupsBySimilarity(
    groupRoutesByForwardStops(routes, stopId, orderedStops),
  );
  return { routes, orderedStops, stopRouteCounts, routeGroups };
}

// ── SVG generation (string-based, no DOM) ───────────────────────────────────

const {
  SVG_WIDTH,
  SVG_ASPECT,
  INFO_PANEL_H,
  ROUTE_LINE_START_X,
  ROUTE_AREA_END_PCT,
  ROUTE_LINE_MIN_EXTEND,
  STOP_SPACING_MIN,
  STOP_SPACING_MAX,
  DIAGRAM_TOP_PAD,
  DIAGRAM_BOTTOM_PAD,
  CLUSTER_SPACING,
  CLUSTER_LABEL_BAND,
  BRANCH_CORNER_R,
  PILL_W_SMALL,
  PILL_OVERHANG,
  TERMINAL_RADIUS,
  CURRENT_PILL_W,
  LABEL_AREA_END_X,
  LABEL_GAP,
  LABEL_BOX_H,
  LABEL_BOX_RX,
  LABEL_BOX_FONT_SIZE,
  LABEL_BOX_CHAR_W,
  LABEL_BOX_PAD,
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
  C,
  FONT,
} = DEFAULTS;

const C_PRIMARY = C.primary;
const C_WHITE = C.white;
const C_PILL_STROKE = C.pillStroke;
const C_LABEL_MUTED = C.labelMuted;
const C_HEADER1 = C.header1;
const C_HEADER2 = C.header2;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function routeLabelWidth(routeId) {
  const MAX_LABEL_W = LABEL_AREA_END_X - 2;
  return Math.min(
    MAX_LABEL_W,
    Math.max(
      20,
      LABEL_BOX_PAD * 2 + Math.ceil(routeId.length * LABEL_BOX_CHAR_W),
    ),
  );
}

function packClusterLabels(routeList) {
  const MAX_WIDTH = LABEL_AREA_END_X - 2;
  const widths = routeList.map((r) => routeLabelWidth(r.routeId));
  const rows = [[]];
  const rowWidths = [0];
  routeList.forEach((_, i) => {
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
  return rows.flatMap((row, rowIdx) => {
    const totalW =
      row.reduce((acc, i) => acc + widths[i], 0) + (row.length - 1) * LABEL_GAP;
    let x = Math.max(2, LABEL_AREA_END_X - totalW);
    return row.map((i) => {
      const item = { route: routeList[i], x, w: widths[i], row: rowIdx };
      x += widths[i] + LABEL_GAP;
      return item;
    });
  });
}

function generateDiagramSVG(stopId, data) {
  const { routes, orderedStops, routeGroups } = data;

  const badgeHalves = routeGroups.map((group) => {
    const rows =
      Math.max(0, ...packClusterLabels(group.routes).map((p) => p.row)) + 1;
    return (rows * LABEL_BOX_H + (rows - 1) * 2) / 2;
  });
  const rowMinGaps = badgeHalves
    .slice(0, -1)
    .map((h, i) => Math.ceil(h + badgeHalves[i + 1] + 2));

  const layout = computeSpiderLayout({
    routeGroups,
    orderedStops,
    currentStopId: stopId,
    getName: getStopName,
    theme: {
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
    },
  });
  if (!layout) return '';

  const hdrH = 82 + 10 + 30 + 14;
  // Same fixed canvas proportions as the app, with the info panel's slot left
  // blank — this script only exercises the route-diagram geometry.
  const fit = fitDiagramArea({
    width: SVG_WIDTH,
    aspect: SVG_ASPECT,
    headerH: hdrH,
    infoPanelH: INFO_PANEL_H,
    naturalH: layout.height,
  });
  const fullH = fit.totalH;

  let svg = '';

  svg += `<rect width="${SVG_WIDTH}" height="${fullH}" fill="${C_WHITE}"/>`;

  svg += `<rect width="${SVG_WIDTH}" height="82" fill="${C_HEADER1}"/>`;
  svg += `<text x="80" y="38" font-family="${esc(FONT)}" font-size="28" font-weight="500" fill="${C_WHITE}">${esc(getStopName(stopId))}</text>`;

  const routeIds = [...new Set(routes.map((r) => r.routeId))];
  svg += `<g transform="translate(0,82)">`;
  svg += `<rect width="${SVG_WIDTH}" height="${hdrH - 82}" fill="${C_HEADER2}"/>`;
  let bx = 16;
  routeIds.forEach((id) => {
    const w = 10 + id.length * 10.8 + 10;
    svg += `<rect x="${bx}" y="10" width="${w}" height="30" rx="3" fill="${C_WHITE}"/>`;
    svg += `<text x="${bx + w / 2}" y="25" text-anchor="middle" dominant-baseline="middle" font-family="${esc(FONT)}" font-size="18" font-weight="700" fill="${C_PRIMARY}">${esc(id)}</text>`;
    bx += w + 4;
  });
  svg += `</g>`;

  svg += `<g transform="translate(${fit.offsetX},${hdrH + fit.offsetY}) scale(${fit.scale})">`;

  // Route group tracks
  layout.tracks.forEach((track) => {
    svg += `<path d="${track.d}" fill="none" stroke="${C_PRIMARY}" stroke-width="4"/>`;

    const packed = packClusterLabels(track.routes);
    const numRows = Math.max(0, ...packed.map((p) => p.row)) + 1;
    const totalLabelH = numRows * LABEL_BOX_H + (numRows - 1) * 2;
    const labelStartY = track.labelY - totalLabelH / 2;

    packed.forEach(({ route, x, w, row }) => {
      const labelY = labelStartY + row * (LABEL_BOX_H + 2);
      const maxChars = Math.floor((w - LABEL_BOX_PAD * 2) / LABEL_BOX_CHAR_W);
      const label =
        route.routeId.length > maxChars
          ? route.routeId.slice(0, Math.max(1, maxChars - 1)) + '…'
          : route.routeId;
      svg += `<rect x="${x}" y="${labelY}" width="${w}" height="${LABEL_BOX_H}" rx="${LABEL_BOX_RX}" fill="${C_PRIMARY}"/>`;
      svg += `<text x="${x + w / 2}" y="${labelY + LABEL_BOX_H / 2}" text-anchor="middle" dominant-baseline="middle" font-family="${esc(FONT)}" font-size="${LABEL_BOX_FONT_SIZE}" font-weight="700" fill="${C_WHITE}">${esc(label)}</text>`;
    });
  });

  // Stop markers
  layout.markers.forEach((m) => {
    svg += `<rect x="${m.x - m.width / 2}" y="${m.top}" width="${m.width}" height="${m.bottom - m.top}" rx="${m.width / 2}" fill="${C_WHITE}" stroke="${C_PILL_STROKE}" stroke-width="1"><title>${esc(m.name)}</title></rect>`;
    m.dots.forEach((dot) => {
      svg += `<circle cx="${dot.x}" cy="${dot.y}" r="${TERMINAL_RADIUS}" fill="${C_PRIMARY}"/>`;
    });
  });

  // Current stop pill
  const cp = layout.currentPill;
  svg += `<rect x="${cp.x}" y="${cp.y}" width="${cp.width}" height="${cp.height}" rx="${cp.width / 2}" fill="${C_WHITE}" stroke="${C_PRIMARY}" stroke-width="2"><title>${esc(getStopName(stopId))}</title></rect>`;

  // Stop labels
  layout.labels.forEach((l) => {
    const numLines = l.lines.length;
    let tspans = '';
    l.lines.forEach((line, i) => {
      const dy =
        l.side === 'above'
          ? i === 0
            ? -(numLines - 1) * l.lineSpacing
            : l.lineSpacing
          : i === 0
            ? 0
            : l.lineSpacing;
      tspans += `<tspan x="${l.textX}" dy="${dy}">${esc(line)}</tspan>`;
    });
    svg += `<g transform="translate(${l.anchorX},${l.anchorY}) rotate(${LABEL_ROT})"><text text-anchor="${l.textAnchor}" font-family="${esc(FONT)}" font-size="${LABEL_FONT_SIZE}" font-weight="400" fill="${C_LABEL_MUTED}">${tspans}</text></g>`;
  });

  svg += `</g>`; // close route diagram group

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${fullH}" viewBox="0 0 ${SVG_WIDTH} ${fullH}">
${svg}
</svg>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const defaultStops = ['20944', '20728', '20570', '21125', '20921'];
  const testStops =
    process.argv.length > 2 ? process.argv.slice(2) : defaultStops;

  let resvg;
  try {
    resvg = await import('@resvg/resvg-js');
  } catch {
    console.log('Warning: @resvg/resvg-js not found, skipping PNG generation');
  }

  for (const stopId of testStops) {
    const stopName = getStopName(stopId);
    console.log(`\nGenerating diagram for stop ${stopId} (${stopName})...`);

    const data = computeDiagramData(stopId);
    if (!data) {
      console.log(`  No routes found for stop ${stopId}, skipping`);
      continue;
    }

    console.log(`  Routes: ${data.routes.map((r) => r.routeId).join(', ')}`);
    console.log(
      `  Ordered stops: ${data.orderedStops.map((s) => `${s}(${getStopName(s)})`).join(', ')}`,
    );
    console.log(`  Route groups: ${data.routeGroups.length}`);
    data.routeGroups.forEach((g, i) => {
      console.log(
        `    Group ${i + 1}: [${g.routes.map((r) => r.routeId).join(', ')}] — ${g.forwardStops.length} stops`,
      );
    });

    const svgContent = generateDiagramSVG(stopId, data);
    const svgPath = join(OUTPUT_DIR, `stop-${stopId}.svg`);
    writeFileSync(svgPath, svgContent);
    console.log(`  SVG saved: ${svgPath}`);

    if (resvg) {
      const renderer = new resvg.Resvg(svgContent, {
        fitTo: { mode: 'width', value: SVG_WIDTH * 2 },
      });
      const pngData = renderer.render();
      const pngBuffer = pngData.asPng();
      const pngPath = join(OUTPUT_DIR, `stop-${stopId}.png`);
      writeFileSync(pngPath, pngBuffer);
      console.log(`  PNG saved: ${pngPath}`);
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
