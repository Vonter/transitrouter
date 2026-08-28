// ══════════════════════════════════════════════════════════════════════════════
// Spider-chart layout — pure geometry, no DOM and no framework dependencies.
// Shared by the browser renderer (DiagramSVG.js) and the offline test
// generator (scripts/generate-test-diagrams.mjs) so both stay in sync.
//
// The layout models each route group as a horizontal "track". Tracks sit one
// row pitch apart while they still share stops, and step outwards (up for the
// top half, down for the bottom half) once a group needs clear space for its
// own rotated stop labels. The vertical steps are drawn as 45° diagonals with
// rounded corners, which is what gives the diagram its branching look.
// ══════════════════════════════════════════════════════════════════════════════

import {
  branchTransitionRun,
  normalizeBranchConfig,
} from './branching.mjs';

const fmt = (n) => (Math.round(n * 1000) / 1000).toString();

export function getContiguousSegments(sorted) {
  if (!sorted.length) return [];
  const segs = [];
  let start = sorted[0],
    prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) prev = sorted[i];
    else {
      segs.push([start, prev]);
      start = prev = sorted[i];
    }
  }
  segs.push([start, prev]);
  return segs;
}

// Builds an SVG path through `points` with circular corners of `radius`.
// Each corner is approximated by the exact cubic for its arc, matching the
// rounded joins used in the reference artwork.
export function roundedPath(points, radius) {
  const pts = points.filter(
    (p, i) =>
      i === 0 ||
      Math.abs(p.x - points[i - 1].x) > 1e-6 ||
      Math.abs(p.y - points[i - 1].y) > 1e-6,
  );
  if (pts.length < 2) return '';

  let d = `M${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    const next = pts[i + 1];
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLen = Math.hypot(next.x - p.x, next.y - p.y);
    if (inLen < 1e-6 || outLen < 1e-6) continue;

    const u = { x: (p.x - prev.x) / inLen, y: (p.y - prev.y) / inLen };
    const w = { x: (next.x - p.x) / outLen, y: (next.y - p.y) / outLen };
    const theta = Math.atan2(
      Math.abs(u.x * w.y - u.y * w.x),
      u.x * w.x + u.y * w.y,
    );
    if (theta < 1e-6) continue;

    let r = radius;
    let t = r * Math.tan(theta / 2);
    const maxT = Math.min(inLen, outLen) / 2;
    if (t > maxT) {
      t = maxT;
      r = t / Math.tan(theta / 2);
    }
    const k = (4 / 3) * r * Math.tan(theta / 4);
    const p0 = { x: p.x - u.x * t, y: p.y - u.y * t };
    const p3 = { x: p.x + w.x * t, y: p.y + w.y * t };
    const c1 = { x: p0.x + u.x * k, y: p0.y + u.y * k };
    const c2 = { x: p3.x - w.x * k, y: p3.y - w.y * k };
    d +=
      `L${fmt(p0.x)} ${fmt(p0.y)}` +
      `C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(p3.x)} ${fmt(p3.y)}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${fmt(last.x)} ${fmt(last.y)}`;
}

// The canvas height is locked to `width * aspect` so every diagram keeps the
// proportions of the reference artwork. The route-diagram band takes whatever
// is left between header and info panel: it is centred when the content is
// shorter than the band, and scaled down uniformly when it overflows.
export function fitDiagramArea({
  width,
  aspect,
  headerH,
  infoPanelH,
  naturalH,
}) {
  const totalH = Math.round(width * aspect);
  const areaH = Math.max(0, totalH - headerH - infoPanelH);
  const scale = naturalH > areaH && naturalH > 0 ? areaH / naturalH : 1;
  return {
    totalH,
    areaH,
    scale,
    offsetX: (width - width * scale) / 2,
    offsetY: (areaH - naturalH * scale) / 2,
  };
}

export function splitLabelName(name, maxLineChars) {
  if (name.length <= maxLineChars) return [name];
  const words = name.split(/[\s/]+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= maxLineChars)
      current += ' ' + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [name];
}

// ── Column assignment ─────────────────────────────────────────────────────────

// Longest-path column index per stop, so a stop always sits to the right of
// every stop that precedes it on any route. Stops sharing a name share a column.
function assignColumns(routeGroups, displayedStops, currentStopId, getName) {
  const nameToRep = new Map();
  const stopToRep = new Map();
  displayedStops.forEach((sid) => {
    const name = getName(sid);
    if (!nameToRep.has(name)) nameToRep.set(name, sid);
    stopToRep.set(sid, nameToRep.get(name));
  });

  const displayedSet = new Set(displayedStops);
  const repColumn = new Map();
  displayedStops.forEach((sid) => repColumn.set(stopToRep.get(sid), 0));

  let changed = true;
  while (changed) {
    changed = false;
    routeGroups.forEach((group) => {
      const fs = group.forwardStops.filter(
        (s) => s !== currentStopId && displayedSet.has(s),
      );
      for (let i = 1; i < fs.length; i++) {
        const repPrev = stopToRep.get(fs[i - 1]);
        const repCur = stopToRep.get(fs[i]);
        if (repPrev === repCur) continue;
        const needed = repColumn.get(repPrev) + 1;
        if (needed > repColumn.get(repCur)) {
          repColumn.set(repCur, needed);
          changed = true;
        }
      }
    });
  }

  return { stopToRep, repColumn };
}

// ── Main entry ────────────────────────────────────────────────────────────────

export function computeSpiderLayout({
  routeGroups,
  orderedStops,
  currentStopId,
  getName,
  getIconCount,
  getLabelOffset,
  getBranchConfig,
  theme,
}) {
  const {
    ROW_PITCH,
    ROW_MIN_GAPS,
    LABEL_BAND,
    MIN_STOP_SPACING,
    MAX_STOP_SPACING,
    START_X,
    AREA_END_X,
    MIN_EXTEND,
    PILL_W,
    PILL_OVERHANG,
    CORNER_R,
    TOP_PAD,
    BOTTOM_PAD,
    LABEL_ROT,
    LABEL_FONT_SIZE,
    LABEL_CHAR_WIDTH,
    LABEL_LINE_SPACING,
    LABEL_MAX_LINE_CHARS,
    LABEL_ICON_GAP,
    LABEL_ROW_OFFSET,
    LABEL_HORIZ_GAP,
    LABEL_STACK_GAP,
    LABEL_MAX_ROWS,
    POI_ICON_SIZE,
    POI_ICON_GAP,
  } = theme;

  const nGroups = routeGroups.length;
  if (nGroups === 0) return null;

  // ── Which groups touch each stop, and where each group terminates ──────────
  const stopGroupIndices = {};
  routeGroups.forEach((group, gi) => {
    group.forwardStops.forEach((sid) => {
      if (sid === currentStopId) return;
      (stopGroupIndices[sid] ??= new Set()).add(gi);
    });
  });

  const terminalGroupMap = new Map();
  routeGroups.forEach((group, gi) => {
    const fs = group.forwardStops.filter((s) => s !== currentStopId);
    if (fs.length === 0) return;
    const last = fs[fs.length - 1];
    if (!terminalGroupMap.has(last)) terminalGroupMap.set(last, new Set());
    terminalGroupMap.get(last).add(gi);
  });

  const displayedStops = orderedStops.filter(
    (sid) => sid !== currentStopId && stopGroupIndices[sid]?.size > 0,
  );
  if (displayedStops.length === 0) return null;

  const { stopToRep, repColumn } = assignColumns(
    routeGroups,
    displayedStops,
    currentStopId,
    getName,
  );

  // Merge same-name stops into a single representative marker.
  const repGroups = new Map();
  const repTerminals = new Map();
  const repOrder = [];
  displayedStops.forEach((sid) => {
    const rep = stopToRep.get(sid);
    if (!repGroups.has(rep)) {
      repGroups.set(rep, new Set());
      repOrder.push(rep);
    }
    stopGroupIndices[sid].forEach((gi) => repGroups.get(rep).add(gi));
    const tg = terminalGroupMap.get(sid);
    if (tg) {
      if (!repTerminals.has(rep)) repTerminals.set(rep, new Set());
      tg.forEach((gi) => repTerminals.get(rep).add(gi));
    }
  });

  const maxCol = Math.max(0, ...repColumn.values());
  const availableW = AREA_END_X - START_X;
  const colSpacing = Math.min(
    MAX_STOP_SPACING,
    Math.max(MIN_STOP_SPACING, Math.floor(availableW / (maxCol + 1))),
  );
  const columnX = (c) => START_X + colSpacing * (c + 1);

  // ── Label side per marker ─────────────────────────────────────────────────
  // The top half of the tracks label upwards, the bottom half downwards. A
  // marker follows the side of the topmost track it spans.
  const aboveCount = Math.max(1, Math.floor(nGroups / 2));

  const markers = [];
  repOrder.forEach((rep) => {
    const col = repColumn.get(rep);
    const rows = Array.from(repGroups.get(rep)).sort((a, b) => a - b);
    const terminals = repTerminals.get(rep);
    getContiguousSegments(rows).forEach(([rowStart, rowEnd]) => {
      const terminalRows = [];
      for (let r = rowStart; r <= rowEnd; r++)
        if (terminals?.has(r)) terminalRows.push(r);
      markers.push({
        rep,
        name: getName(rep),
        col,
        rowStart,
        rowEnd,
        terminalRows,
        allTerminal: terminalRows.length === rowEnd - rowStart + 1,
        side: rowStart < aboveCount ? 'above' : 'below',
      });
    });
  });

  // ── Track gaps ────────────────────────────────────────────────────────────
  // A gap widens to LABEL_BAND from the first column where the neighbouring
  // track needs clear space for its labels, and stays widened so tracks never
  // bend back on themselves.
  // A gap can only widen once the two tracks either side of it stop sharing
  // stops, otherwise the shared marker would stretch across the widened gap.
  const sharedUntil = new Array(Math.max(0, nGroups - 1)).fill(-1);
  markers.forEach((m) => {
    for (let i = m.rowStart; i < m.rowEnd; i++)
      if (m.col > sharedUntil[i]) sharedUntil[i] = m.col;
  });

  const bandFromCol = new Array(Math.max(0, nGroups - 1)).fill(Infinity);
  markers.forEach((m) => {
    if (m.allTerminal) return; // terminal labels run off to the right
    const gapIdx = m.side === 'above' ? m.rowStart - 1 : m.rowEnd;
    if (gapIdx < 0 || gapIdx >= nGroups - 1) return;
    // Below-labels trail off to the left of their marker, so the band has to
    // be clear one column earlier than the marker itself.
    const from = Math.max(
      sharedUntil[gapIdx] + 1,
      m.side === 'above' ? m.col : m.col - 1,
    );
    if (from < bandFromCol[gapIdx]) bandFromCol[gapIdx] = from;
  });

  const gapAt = (gapIdx, col) =>
    Math.max(
      ROW_MIN_GAPS?.[gapIdx] ?? 0,
      col >= bandFromCol[gapIdx] ? LABEL_BAND : ROW_PITCH,
    );

  // Tracks are anchored on the boundary between the up- and down-labelling
  // halves so the diagram grows symmetrically around it.
  const pivot = aboveCount - 1;
  const relY = (row, col) => {
    let y = 0;
    if (row < pivot) for (let i = row; i < pivot; i++) y -= gapAt(i, col);
    else for (let i = pivot; i < row; i++) y += gapAt(i, col);
    return y;
  };

  markers.forEach((m) => {
    m.x = columnX(m.col);
    m.width = PILL_W;
    m.top = relY(m.rowStart, m.col) - PILL_OVERHANG;
    m.bottom = relY(m.rowEnd, m.col) + PILL_OVERHANG;
    m.dots = m.terminalRows.map((r) => ({ x: m.x, y: relY(r, m.col) }));
  });

  // ── Stop labels ───────────────────────────────────────────────────────────
  // Every label transform stays attached to its stop pill. Track spacing and
  // line wrapping provide the clearance; moving the transform to resolve a
  // collision makes a label appear to identify a different branch or stop.
  const rot = (LABEL_ROT * Math.PI) / 180;
  const dirY = Math.sin(rot);

  const labels = [];

  // Ordinary stop labels are placed first so the ladder along each track stays
  // tight; terminal labels, which have open space past the end of the line, are
  // fitted around them afterwards.
  // Treat the selected stop as the first labelled marker. It uses the same
  // collision and wrapping rules as every following stop, while its pill is
  // still drawn separately across the full stack of route tracks.
  const currentLabelMarker = {
    rep: currentStopId,
    name: getName(currentStopId),
    col: -1,
    rowStart: 0,
    rowEnd: nGroups - 1,
    allTerminal: false,
    side: 'above',
    x: START_X,
    width: PILL_W,
    top: relY(0, -1) - PILL_OVERHANG,
    bottom: relY(nGroups - 1, -1) + PILL_OVERHANG,
    isCurrent: true,
  };
  const orderedMarkers = [currentLabelMarker, ...markers].sort((a, b) => {
    if (a.allTerminal !== b.allTerminal) return a.allTerminal ? 1 : -1;
    if (a.side !== b.side) return a.side === 'above' ? -1 : 1;
    // Terminal labels share a column whenever routes end at the same stop, so
    // order them by track: placing the innermost first lets the rest fan out
    // away from the diagram instead of leapfrogging each other.
    if (a.allTerminal && a.rowStart !== b.rowStart)
      return a.side === 'above'
        ? b.rowStart - a.rowStart
        : a.rowStart - b.rowStart;
    return a.side === 'above' ? a.x - b.x : b.x - a.x;
  });

  orderedMarkers.forEach((m) => {
    const lines = splitLabelName(m.name, LABEL_MAX_LINE_CHARS);
    const textW = Math.max(...lines.map((l) => l.length)) * LABEL_CHAR_WIDTH;
    // Visual height of the text block: baselines plus one cap height, not one
    // full line per line — otherwise labels on a row of evenly spaced markers
    // all read as clashing and cascade away from the diagram.
    const blockH = (lines.length - 1) * LABEL_LINE_SPACING + LABEL_FONT_SIZE;
    const iconCount = getIconCount ? getIconCount(m.rep) : 0;
    const iconSpan = iconCount * (POI_ICON_SIZE + POI_ICON_GAP);
    const totalW = textW + iconSpan;
    const above = m.side === 'above';
    // Terminal text sits past the end of the line, but its group transform is
    // still anchored on the pill. Keeping the offset local makes the label's
    // ownership unambiguous and keeps manual edits relative to the stop.
    const anchorStart = above || m.allTerminal;
    const contentOffset = m.allTerminal ? PILL_W / 2 + 4 : 0;
    const anchorX = m.x;
    const baseY = above ? m.top : m.bottom + LABEL_FONT_SIZE;

    const sign = above ? -1 : 1;
    const anchorY = baseY + sign * LABEL_ICON_GAP;

    labels.push({
      stopId: m.rep,
      name: m.name,
      lines,
      side: m.side,
      isTerminal: m.allTerminal,
      x: m.x,
      anchorX,
      anchorY,
      textAnchor: anchorStart ? 'start' : 'end',
      lineSpacing: LABEL_LINE_SPACING,
      iconCount,
      iconSpan,
      // Local x (in the rotated frame) of the icon strip and of the text. Icons
      // always sit on the marker side of the text.
      iconX: anchorStart ? contentOffset : -iconSpan,
      textX: anchorStart ? contentOffset + iconSpan : -iconSpan,
      iconY: above
        ? -(lines.length - 1) * LABEL_LINE_SPACING - LABEL_FONT_SIZE
        : 0,
      // Extreme corner of the rotated text block, used for sizing the canvas.
      extentY:
        anchorY + (anchorStart ? contentOffset + totalW : -totalW) * dirY,
      blockH,
    });
  });

  // Manual nudges from the editor are applied after automatic placement, so a
  // moved label stays exactly where it was dropped and never displaces others.
  if (getLabelOffset) {
    labels.forEach((l) => {
      const offset = getLabelOffset(l.stopId);
      if (!offset) return;
      l.anchorX += offset[0];
      l.anchorY += offset[1];
      l.extentY += offset[1];
    });
  }

  // ── Vertical extents ──────────────────────────────────────────────────────
  let minRel = Infinity;
  let maxRel = -Infinity;
  const track = (y) => {
    if (y < minRel) minRel = y;
    if (y > maxRel) maxRel = y;
  };
  for (let row = 0; row < nGroups; row++)
    for (let col = -1; col <= maxCol; col++) track(relY(row, col));
  markers.forEach((m) => {
    track(m.top);
    track(m.bottom);
  });
  labels.forEach((l) => {
    const lo = Math.min(l.anchorY, l.extentY);
    const hi = Math.max(l.anchorY, l.extentY);
    track(l.side === 'above' ? lo - l.blockH : lo);
    track(l.side === 'above' ? hi : hi + l.blockH);
  });

  const yOrigin = TOP_PAD - minRel;
  const height = TOP_PAD + (maxRel - minRel) + BOTTOM_PAD;
  const rowY = (row, col) => yOrigin + relY(row, col);

  markers.forEach((m) => {
    m.top += yOrigin;
    m.bottom += yOrigin;
    m.dots.forEach((d) => {
      d.y += yOrigin;
    });
  });
  labels.forEach((l) => {
    l.anchorY += yOrigin;
    l.extentY += yOrigin;
  });

  // ── Track polylines ───────────────────────────────────────────────────────
  const lastColOfGroup = new Array(nGroups).fill(-1);
  markers.forEach((m) => {
    for (let r = m.rowStart; r <= m.rowEnd; r++)
      if (m.col > lastColOfGroup[r]) lastColOfGroup[r] = m.col;
  });

  const tracks = routeGroups.map((group, gi) => {
    const branch = normalizeBranchConfig(getBranchConfig?.(group.key));
    const lastCol = lastColOfGroup[gi];
    const endX =
      lastCol < 0
        ? START_X + MIN_EXTEND
        : Math.max(columnX(lastCol), START_X + MIN_EXTEND);

    const pts = [{ x: START_X, y: rowY(gi, -1) }];
    for (let c = 0; c <= lastCol; c++) {
      const yPrev = rowY(gi, c - 1);
      const yCur = rowY(gi, c);
      if (yCur === yPrev) continue;
      const prevX = c === 0 ? START_X : columnX(c - 1);
      const nextX = columnX(c);
      const mid = (prevX + nextX) / 2;
      const run = branchTransitionRun(
        yCur - yPrev,
        nextX - prevX,
        branch,
      );
      pts.push({ x: mid - run / 2, y: yPrev });
      pts.push({ x: mid + run / 2, y: yCur });
    }
    pts.push({ x: endX, y: rowY(gi, lastCol < 0 ? -1 : lastCol) });

    return {
      groupIndex: gi,
      key: group.key,
      routes: group.routes,
      labelY: rowY(gi, -1),
      endX,
      branch,
      d: roundedPath(pts, CORNER_R),
    };
  });

  return {
    nGroups,
    aboveCount,
    colSpacing,
    maxCol,
    columnX,
    rowY,
    tracks,
    markers,
    labels,
    height,
    currentPill: {
      x: START_X - PILL_W / 2,
      y: rowY(0, -1) - PILL_OVERHANG + 1,
      width: PILL_W,
      height: rowY(nGroups - 1, -1) - rowY(0, -1) + 2 * PILL_OVERHANG - 2,
    },
  };
}
