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
    if (routeGroups[i].routes.length > routeGroups[best].routes.length) best = i;
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
      if (sim > maxSim || (sim === maxSim && routeGroups[i].routes.length > routeGroups[nextIdx].routes.length)) {
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

function computeDiagramData(stopId, { targetMajorStops = 5, countMajorRoutes = 8 } = {}) {
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
    ranked.slice(0, targetMajorStops).forEach((s) => allMajorStops.add(s.stopId));
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

const SVG_WIDTH = 660;
const ROUTE_LINE_START_X = 112;
const ROUTE_AREA_END_PCT = 0.9;
const STOP_SPACING = 32;
const LABEL_SPACE = 120;
const CLUSTER_SPACING = 44;
const TARGET_CLUSTER_SPAN = 240;
const MAX_CLUSTER_SPACING = 80;
const DIAGRAM_BOTTOM_PAD = 50;
const PILL_W_BIG = 12;
const PILL_W_SMALL = 8;
const PILL_OVERHANG = 6;
const TERMINAL_RADIUS = 7;
const CURRENT_PILL_X = 102;
const CURRENT_PILL_W = 8;
const CURRENT_PILL_TOP_PAD = 5;
const LABEL_BOX_H = 14;
const LABEL_BOX_RX = 2;
const LABEL_BOX_FONT_SIZE = 10;
const LABEL_BOX_CHAR_W = 7.5;
const LABEL_BOX_PAD = 4;
const LABEL_AREA_END_X = 100;
const LABEL_GAP = 2;
const LABEL_ROT = -35;
const LABEL_FONT_SIZE = 9;
const LABEL_CHAR_WIDTH = 5.5;
const LABEL_ROW_OFFSET = 13;
const LABEL_ICON_GAP = 6;
const LABEL_MAX_DIST = 45;
const LABEL_MAX_LINE_CHARS = 20;
const LABEL_HORIZ_GAP = 8;
const LABEL_LINE_SPACING_EXTRA = 3;
const LABEL_ANCHOR_CLAMP = 10;
const ROUTE_LINE_MIN_EXTEND = 24;
const BRANCH_STROKE_W = 3;
const MIN_SHARED_FOR_BRANCH = 2;

const C_PRIMARY = '#1B4DA9';
const C_WHITE = '#ffffff';
const C_PILL_STROKE = '#585858';
const C_LABEL_MUTED = '#888888';
const C_HEADER1 = '#0E3F9A';
const C_HEADER2 = '#1B4CA9';
const FONT = "'Manrope', system-ui, sans-serif";

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function splitLabelName(name) {
  if (name.length <= LABEL_MAX_LINE_CHARS) return [name];
  const words = name.split(/[\s/]+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= LABEL_MAX_LINE_CHARS)
      current += ' ' + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [name];
}

function packClusterLabels(routeList) {
  function naturalWidth(r) {
    const MAX_LABEL_W = LABEL_AREA_END_X - 2;
    return Math.min(MAX_LABEL_W, Math.max(20, Math.ceil(r.routeId.length * 7.5 + 10)));
  }
  const MAX_WIDTH = LABEL_AREA_END_X - 2;
  const widths = routeList.map(naturalWidth);
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
    const totalW = row.reduce((acc, i) => acc + widths[i], 0) + (row.length - 1) * LABEL_GAP;
    let x = Math.max(2, LABEL_AREA_END_X - totalW);
    return row.map((i) => {
      const item = { route: routeList[i], x, w: widths[i], row: rowIdx };
      x += widths[i] + LABEL_GAP;
      return item;
    });
  });
}

function layoutStopLabels(labelData) {
  const COS = Math.abs(Math.cos((LABEL_ROT * Math.PI) / 180));
  const sorted = [...labelData].sort((a, b) => a.x - b.x);
  const GAP = LABEL_HORIZ_GAP;
  const MAX_ROWS = Math.floor((LABEL_MAX_DIST - LABEL_ICON_GAP) / LABEL_ROW_OFFSET);
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
      if (tryPlace(r, start, hSpan)) return { ...item, row: r };
    }
    tryPlace(MAX_ROWS, start, hSpan);
    return { ...item, row: MAX_ROWS };
  });
}

function getContiguousSegments(sorted) {
  if (!sorted.length) return [];
  const segs = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) prev = sorted[i];
    else { segs.push([start, prev]); start = prev = sorted[i]; }
  }
  segs.push([start, prev]);
  return segs;
}

function generateDiagramSVG(stopId, data) {
  const { routes, orderedStops, routeGroups } = data;
  const nGroups = routeGroups.length;
  if (nGroups === 0) return '';

  // Build per-group stop sets
  const stopGroupIndices = {};
  routeGroups.forEach((group, gi) => {
    group.forwardStops.forEach((sid) => {
      if (sid === stopId) return;
      (stopGroupIndices[sid] ??= new Set()).add(gi);
    });
  });

  // Terminal stops per group
  const terminalGroupMap = new Map();
  routeGroups.forEach((group, gi) => {
    const fs = group.forwardStops.filter((s) => s !== stopId);
    if (fs.length > 0) {
      const last = fs[fs.length - 1];
      if (!terminalGroupMap.has(last)) terminalGroupMap.set(last, new Set());
      terminalGroupMap.get(last).add(gi);
    }
  });

  const displayedStops = orderedStops.filter(
    (sid) => sid !== stopId && stopGroupIndices[sid]?.size > 0,
  );

  // Merge same-name stops: stops with identical names share one column.
  const nameToRep = new Map();
  const stopToRep = new Map();
  displayedStops.forEach((sid) => {
    const name = getStopName(sid);
    if (!nameToRep.has(name)) nameToRep.set(name, sid);
    stopToRep.set(sid, nameToRep.get(name));
  });

  // DAG-based column assignment using representatives for same-name stops.
  const displayedSet = new Set(displayedStops);
  const repColumn = new Map();
  displayedStops.forEach((sid) => repColumn.set(stopToRep.get(sid), 0));

  let colChanged = true;
  while (colChanged) {
    colChanged = false;
    routeGroups.forEach((group) => {
      const fs = group.forwardStops.filter(
        (s) => s !== stopId && displayedSet.has(s),
      );
      for (let i = 1; i < fs.length; i++) {
        const repPrev = stopToRep.get(fs[i - 1]);
        const repCur = stopToRep.get(fs[i]);
        if (repPrev === repCur) continue;
        const needed = repColumn.get(repPrev) + 1;
        if (needed > repColumn.get(repCur)) {
          repColumn.set(repCur, needed);
          colChanged = true;
        }
      }
    });
  }

  const stopColumn = new Map();
  displayedStops.forEach((sid) =>
    stopColumn.set(sid, repColumn.get(stopToRep.get(sid))),
  );

  const maxCol = Math.max(0, ...stopColumn.values());
  const availableW = SVG_WIDTH * ROUTE_AREA_END_PCT - ROUTE_LINE_START_X;
  const colSpacing = maxCol > 0 ? Math.floor(availableW / (maxCol + 1)) : STOP_SPACING;
  const stopXMap = {};
  displayedStops.forEach((sid) => {
    stopXMap[sid] = ROUTE_LINE_START_X + colSpacing * (stopColumn.get(sid) + 1);
  });

  // Group spacing
  const maxLabelRows = Math.max(
    1,
    ...routeGroups.map((g) => {
      const packed = packClusterLabels(g.routes);
      return Math.max(0, ...packed.map((p) => p.row)) + 1;
    }),
  );
  const labelVerticalExtent = LABEL_MAX_DIST + LABEL_FONT_SIZE + 4;
  const minSpacing = Math.max(CLUSTER_SPACING, maxLabelRows * (LABEL_BOX_H + 2) + 6, labelVerticalExtent);
  const effectiveGroupSpacing = nGroups > 1
    ? Math.max(minSpacing, Math.min(MAX_CLUSTER_SPACING, Math.round(TARGET_CLUSTER_SPAN / (nGroups - 1))))
    : minSpacing;
  const groupY = (i) => LABEL_SPACE + i * effectiveGroupSpacing;
  const totalH = LABEL_SPACE + (nGroups - 1) * effectiveGroupSpacing + DIAGRAM_BOTTOM_PAD;

  // Header height (simplified)
  const hdrH = 82 + 10 + 30 + 14; // HDR1_H + BADGE_TOP_PAD + one badge row + BADGE_BOT_PAD
  const fullH = hdrH + totalH;

  let svg = '';

  // Background
  svg += `<rect width="${SVG_WIDTH}" height="${fullH}" fill="${C_WHITE}"/>`;

  // Simplified header
  svg += `<rect width="${SVG_WIDTH}" height="82" fill="${C_HEADER1}"/>`;
  svg += `<text x="80" y="38" font-family="${esc(FONT)}" font-size="28" font-weight="500" fill="${C_WHITE}">${esc(getStopName(stopId))}</text>`;

  // Badge strip
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

  // Route diagram
  svg += `<g transform="translate(0,${hdrH})">`;
  svg += `<rect width="${SVG_WIDTH}" height="${totalH}" fill="${C_WHITE}"/>`;

  // Group lines + route labels
  routeGroups.forEach((group, gi) => {
    const gy = groupY(gi);
    let maxX = ROUTE_LINE_START_X + ROUTE_LINE_MIN_EXTEND;
    group.forwardStops.forEach((sid) => {
      if (sid === stopId) return;
      const x = stopXMap[sid];
      if (x !== undefined) maxX = Math.max(maxX, x);
    });
    svg += `<line x1="${ROUTE_LINE_START_X}" y1="${gy}" x2="${maxX}" y2="${gy}" stroke="${C_PRIMARY}" stroke-width="4" stroke-linecap="round"/>`;

    // Route ID labels
    const packed = packClusterLabels(group.routes);
    const numRows = Math.max(0, ...packed.map((p) => p.row)) + 1;
    const totalLabelH = numRows * LABEL_BOX_H + (numRows - 1) * 2;
    const labelStartY = gy - totalLabelH / 2;

    packed.forEach(({ route, x, w, row }) => {
      const labelY = labelStartY + row * (LABEL_BOX_H + 2);
      const maxChars = Math.floor((w - LABEL_BOX_PAD) / LABEL_BOX_CHAR_W);
      const label = route.routeId.length > maxChars
        ? route.routeId.slice(0, Math.max(1, maxChars - 1)) + '\u2026'
        : route.routeId;
      svg += `<rect x="${x}" y="${labelY}" width="${w}" height="${LABEL_BOX_H}" rx="${LABEL_BOX_RX}" fill="${C_PRIMARY}"/>`;
      svg += `<text x="${x + w / 2}" y="${labelY + LABEL_BOX_H / 2}" text-anchor="middle" dominant-baseline="middle" font-family="${esc(FONT)}" font-size="${LABEL_BOX_FONT_SIZE}" font-weight="700" fill="${C_WHITE}">${esc(label)}</text>`;
    });
  });

  // Merge same-name stops for pill rendering
  const mergedGroupIndices = {};
  const mergedTerminalMap = new Map();
  const drawnReps = new Set();

  displayedStops.forEach((sid) => {
    const rep = stopToRep.get(sid);
    if (!mergedGroupIndices[rep]) mergedGroupIndices[rep] = new Set();
    const gs = stopGroupIndices[sid];
    if (gs) gs.forEach((gi) => mergedGroupIndices[rep].add(gi));
    const tg = terminalGroupMap.get(sid);
    if (tg) {
      if (!mergedTerminalMap.has(rep)) mergedTerminalMap.set(rep, new Set());
      tg.forEach((gi) => mergedTerminalMap.get(rep).add(gi));
    }
  });

  // Stop pills
  displayedStops.forEach((sid) => {
    const rep = stopToRep.get(sid);
    if (drawnReps.has(rep)) return;
    drawnReps.add(rep);

    const groupSet = mergedGroupIndices[rep];
    if (!groupSet || groupSet.size === 0) return;
    const x = stopXMap[sid];
    if (x === undefined) return;
    const sorted = Array.from(groupSet).sort((a, b) => a - b);
    const segs = getContiguousSegments(sorted);
    const terminalGroups = mergedTerminalMap.get(rep);
    segs.forEach(([first, last]) => {
      const runs = [];
      let runStart = first;
      let runIsTerminal = terminalGroups?.has(first) ?? false;
      for (let gi = first + 1; gi <= last; gi++) {
        const giIsTerminal = terminalGroups?.has(gi) ?? false;
        if (giIsTerminal !== runIsTerminal) {
          runs.push({ start: runStart, end: gi - 1, isTerminal: runIsTerminal });
          runStart = gi;
          runIsTerminal = giIsTerminal;
        }
      }
      runs.push({ start: runStart, end: last, isTerminal: runIsTerminal });

      runs.forEach(({ start, end, isTerminal }) => {
        if (isTerminal) {
          if (start !== end) {
            svg += `<line x1="${x}" y1="${groupY(start)}" x2="${x}" y2="${groupY(end)}" stroke="${C_PRIMARY}" stroke-width="2"/>`;
          }
          for (let gi = start; gi <= end; gi++) {
            svg += `<circle cx="${x}" cy="${groupY(gi)}" r="${TERMINAL_RADIUS}" fill="${C_PRIMARY}"><title>${esc(getStopName(sid))}</title></circle>`;
          }
        } else {
          const pillW = PILL_W_SMALL;
          const y1 = groupY(start) - PILL_OVERHANG;
          const y2 = groupY(end) + PILL_OVERHANG;
          svg += `<rect x="${x - pillW / 2}" y="${y1}" width="${pillW}" height="${y2 - y1}" rx="${pillW / 2}" fill="${C_WHITE}" stroke="${C_PILL_STROKE}" stroke-width="1"><title>${esc(getStopName(sid))}</title></rect>`;
        }
      });
    });
  });

  // Current stop pill
  const pillTop = groupY(0) - CURRENT_PILL_TOP_PAD;
  const pillBottom = groupY(nGroups - 1) + PILL_OVERHANG;
  svg += `<rect x="${CURRENT_PILL_X}" y="${pillTop}" width="${CURRENT_PILL_W}" height="${pillBottom - pillTop}" rx="${CURRENT_PILL_W / 2}" fill="${C_WHITE}" stroke="${C_PRIMARY}" stroke-width="2"><title>${esc(getStopName(stopId))}</title></rect>`;

  // Stop labels — one per contiguous pill segment
  const rawLabels = [];
  const drawnLabelReps = new Set();
  displayedStops.forEach((sid) => {
    const rep = stopToRep.get(sid);
    if (drawnLabelReps.has(rep)) return;
    drawnLabelReps.add(rep);
    const name = getStopName(sid);
    const x = stopXMap[sid];
    const groupSet = mergedGroupIndices[rep] || stopGroupIndices[sid];
    if (!groupSet || groupSet.size === 0) return;
    const sorted = Array.from(groupSet).sort((a, b) => a - b);
    const segs = getContiguousSegments(sorted);
    const terminalGroups = mergedTerminalMap.get(rep);
    const lines = splitLabelName(name);
    segs.forEach(([first]) => {
      const isTermStop = terminalGroups?.has(first) ?? false;
      const overhang = isTermStop ? TERMINAL_RADIUS : PILL_OVERHANG;
      rawLabels.push({ name, lines, x, markerTopY: groupY(first) - overhang });
    });
  });
  rawLabels.sort((a, b) => a.x - b.x);
  const layouted = layoutStopLabels(rawLabels);

  const LABEL_LINE_SPACING = LABEL_FONT_SIZE + LABEL_LINE_SPACING_EXTRA;
  layouted.forEach(({ name, lines, x, markerTopY, row }) => {
    const anchorY = markerTopY - Math.min(LABEL_ICON_GAP + row * LABEL_ROW_OFFSET, LABEL_ANCHOR_CLAMP);
    const labelLines = lines || [name];
    const numLines = labelLines.length;
    let tspans = '';
    labelLines.forEach((line, lineIdx) => {
      const dy = lineIdx === 0 ? -(numLines - 1) * LABEL_LINE_SPACING : LABEL_LINE_SPACING;
      tspans += `<tspan x="0" dy="${dy}">${esc(line)}</tspan>`;
    });
    svg += `<g transform="translate(${x},${anchorY}) rotate(${LABEL_ROT})"><text text-anchor="start" dominant-baseline="auto" font-family="${esc(FONT)}" font-size="${LABEL_FONT_SIZE}" font-weight="400" fill="${C_LABEL_MUTED}">${tspans}</text></g>`;
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
  const testStops = process.argv.length > 2 ? process.argv.slice(2) : defaultStops;

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
    console.log(`  Ordered stops: ${data.orderedStops.map((s) => `${s}(${getStopName(s)})`).join(', ')}`);
    console.log(`  Route groups: ${data.routeGroups.length}`);
    data.routeGroups.forEach((g, i) => {
      console.log(`    Group ${i + 1}: [${g.routes.map((r) => r.routeId).join(', ')}] — ${g.forwardStops.length} stops`);
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
