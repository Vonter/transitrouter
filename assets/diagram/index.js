import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { getCurrentCity } from '../config';
import getRoute from '../utils/getRoute';

import {
  loadCityData,
  loadScheduleData,
  computeDiagramData,
} from './dataLoader';
import { renderDiagramSVG } from './DiagramSVG';
import MapPicker from './MapPicker';
import Controls, {
  DEFAULT_COUNT_MAJOR_ROUTES,
  DEFAULT_TARGET_MAJOR_STOPS,
} from './Controls';
import { getCurrentThemeValues, patchTheme, resetTheme } from './theme';

// ── URL param helpers ──────────────────────────────────────────────────────────

function readIntParam(name, min, max, fallback) {
  const v = parseInt(new URLSearchParams(location.search).get(name), 10);
  return !isNaN(v) && v >= min && v <= max ? v : fallback;
}

function syncUrlParams(routes, stops, expert) {
  const params = new URLSearchParams(location.search);
  params.set('routes', routes);
  params.set('stops', stops);
  if (expert) params.set('expert', '1');
  else params.delete('expert');
  history.replaceState(
    null,
    '',
    `${location.pathname}?${params}${location.hash}`,
  );
}

// ── Theme editor schema ────────────────────────────────────────────────────────

const THEME_SECTIONS = [
  {
    label: 'Canvas',
    settings: [{ key: 'SVG_WIDTH', label: 'SVG Width', min: 300, max: 1200 }],
  },
  {
    label: 'Header',
    settings: [
      { key: 'HDR1_H', label: 'Header Height', min: 20, max: 200 },
      { key: 'HEADER_LOGO_X', label: 'Logo X', min: 0, max: 100 },
      { key: 'HEADER_LOGO_Y', label: 'Logo Y', min: 0, max: 100 },
      { key: 'HEADER_LOGO_W', label: 'Logo Width', min: 10, max: 120 },
      { key: 'HEADER_LOGO_H', label: 'Logo Height', min: 10, max: 120 },
      { key: 'HEADER_NAME_X', label: 'Name X', min: 10, max: 200 },
      { key: 'HDR_KN_Y', label: 'Kannada Name Y', min: 10, max: 100 },
      { key: 'HDR_KN_SIZE', label: 'Kannada Name Size', min: 10, max: 60 },
      { key: 'HDR_KN_EN_Y', label: 'Kannada EN Sub Y', min: 20, max: 120 },
      { key: 'HDR_KN_EN_SIZE', label: 'Kannada EN Sub Size', min: 6, max: 30 },
      {
        key: 'HDR_KN_TOWARDS_Y',
        label: 'Kannada Towards Y',
        min: 20,
        max: 120,
      },
      {
        key: 'HDR_KN_TOWARDS_SIZE',
        label: 'Kannada Towards Size',
        min: 8,
        max: 50,
      },
      { key: 'HDR_EN_Y', label: 'English Name Y', min: 10, max: 100 },
      { key: 'HDR_EN_SIZE', label: 'English Name Size', min: 10, max: 60 },
      {
        key: 'HDR_EN_TOWARDS_Y',
        label: 'English Towards Y',
        min: 20,
        max: 120,
      },
      {
        key: 'HDR_EN_TOWARDS_SIZE',
        label: 'English Towards Size',
        min: 8,
        max: 50,
      },
    ],
  },
  {
    label: 'Badges',
    settings: [
      { key: 'BADGE_H', label: 'Badge Height', min: 10, max: 80 },
      { key: 'BADGE_GAP_X', label: 'Badge Row Gap', min: 0, max: 30 },
      { key: 'BADGE_TOP_PAD', label: 'Badge Top Pad', min: 0, max: 50 },
      { key: 'BADGE_BOT_PAD', label: 'Badge Bottom Pad', min: 0, max: 50 },
      { key: 'BADGE_PADDING_H', label: 'Badge H Padding', min: 0, max: 40 },
      { key: 'BADGE_ROW_MARGIN', label: 'Badge Row Margin', min: 0, max: 40 },
      { key: 'BADGE_INNER_GAP', label: 'Badge Inner Gap', min: 0, max: 20 },
      { key: 'BADGE_ICON_TEXT_GAP', label: 'Icon→Text Gap', min: 0, max: 20 },
      {
        key: 'BADGE_CHAR_SCALE',
        label: 'Char Width Scale',
        min: 0.3,
        max: 1.5,
        step: 0.05,
      },
      { key: 'BUS_ICON_W', label: 'Bus Icon Width', min: 5, max: 40 },
      { key: 'BUS_ICON_H', label: 'Bus Icon Height', min: 5, max: 40 },
      { key: 'BADGE_FONT_SIZE', label: 'Badge Font Size', min: 8, max: 40 },
    ],
  },
  {
    label: 'Route Diagram',
    settings: [
      { key: 'LABEL_SPACE', label: 'Label Space', min: 40, max: 300 },
      { key: 'MAX_STOP_STEP_PCT', label: 'Max Stop Step %', min: 1, max: 20 },
      { key: 'CLUSTER_SPACING', label: 'Cluster Spacing', min: 20, max: 200 },
      {
        key: 'TARGET_CLUSTER_SPAN',
        label: 'Target Cluster Span',
        min: 100,
        max: 600,
      },
      {
        key: 'MAX_CLUSTER_SPACING',
        label: 'Max Cluster Spacing',
        min: 40,
        max: 200,
      },
      {
        key: 'ROUTE_LINE_START_X',
        label: 'Route Line Start X',
        min: 50,
        max: 200,
      },
      {
        key: 'ROUTE_AREA_END_PCT',
        label: 'Route Area End %',
        min: 0.5,
        max: 1.0,
        step: 0.05,
      },
      {
        key: 'ROUTE_LINE_MIN_EXTEND',
        label: 'Line Min Extend',
        min: 0,
        max: 80,
      },
      { key: 'STOP_SPACING', label: 'Stop Spacing', min: 10, max: 100 },
      { key: 'LABEL_AREA_END_X', label: 'Label Area End X', min: 50, max: 200 },
      { key: 'LABEL_GAP', label: 'Label Gap', min: 0, max: 20 },
      { key: 'LABEL_BOX_H', label: 'Label Box Height', min: 6, max: 40 },
      { key: 'LABEL_BOX_RX', label: 'Label Box Radius', min: 0, max: 10 },
      {
        key: 'LABEL_BOX_FONT_SIZE',
        label: 'Label Box Font Size',
        min: 6,
        max: 20,
      },
      {
        key: 'LABEL_BOX_CHAR_W',
        label: 'Label Box Char W',
        min: 3,
        max: 15,
        step: 0.5,
      },
      { key: 'LABEL_BOX_PAD', label: 'Label Box Pad', min: 0, max: 20 },
      { key: 'PILL_W_BIG', label: 'Pill Width (big)', min: 4, max: 30 },
      { key: 'PILL_W_SMALL', label: 'Pill Width (small)', min: 4, max: 30 },
      { key: 'PILL_OVERHANG', label: 'Pill Overhang', min: 0, max: 20 },
      { key: 'TERMINAL_RADIUS', label: 'Terminal Radius', min: 3, max: 20 },
      { key: 'CURRENT_PILL_X', label: 'Current Pill X', min: 50, max: 150 },
      { key: 'CURRENT_PILL_W', label: 'Current Pill Width', min: 4, max: 20 },
      {
        key: 'CURRENT_PILL_TOP_PAD',
        label: 'Current Pill Top Pad',
        min: 0,
        max: 20,
      },
      { key: 'DIAGRAM_BOTTOM_PAD', label: 'Bottom Padding', min: 10, max: 150 },
      {
        key: 'EXTRA_BOTTOM_PCT',
        label: 'Extra Bottom %',
        min: 0,
        max: 0.5,
        step: 0.01,
      },
    ],
  },
  {
    label: 'Stop Labels',
    settings: [
      { key: 'LABEL_ROT', label: 'Rotation (deg)', min: -90, max: 0 },
      { key: 'LABEL_FONT_SIZE', label: 'Font Size', min: 6, max: 20 },
      {
        key: 'LABEL_CHAR_WIDTH',
        label: 'Char Width',
        min: 2,
        max: 12,
        step: 0.5,
      },
      { key: 'LABEL_ROW_OFFSET', label: 'Row Offset', min: 5, max: 30 },
      { key: 'LABEL_ICON_GAP', label: 'Icon Gap', min: 0, max: 20 },
      { key: 'LABEL_MAX_DIST', label: 'Max Dist', min: 10, max: 100 },
      { key: 'LABEL_MAX_LINE_CHARS', label: 'Max Line Chars', min: 5, max: 50 },
      { key: 'LABEL_HORIZ_GAP', label: 'Horiz Gap', min: 0, max: 30 },
      {
        key: 'LABEL_LINE_SPACING_EXTRA',
        label: 'Line Spacing Extra',
        min: 0,
        max: 20,
      },
      { key: 'LABEL_ANCHOR_CLAMP', label: 'Anchor Clamp', min: 0, max: 30 },
    ],
  },
  {
    label: 'Branch Connectors',
    settings: [
      { key: 'BRANCH_STROKE_W', label: 'Stroke Width', min: 1, max: 10 },
      {
        key: 'MIN_SHARED_FOR_BRANCH',
        label: 'Min Shared Stops',
        min: 1,
        max: 10,
      },
    ],
  },
  {
    label: 'Info Panel',
    settings: [
      { key: 'INFO_PANEL_H', label: 'Panel Height', min: 80, max: 400 },
      { key: 'LEGEND_INNER_W', label: 'Legend Width', min: 40, max: 200 },
      { key: 'LEGEND_VERT_PAD', label: 'Legend Vert Pad', min: 0, max: 40 },
      { key: 'LEGEND_ICON_TOP', label: 'Legend Icon Top', min: 0, max: 20 },
      { key: 'LEGEND_ICON_SIZE', label: 'Legend Icon Size', min: 6, max: 30 },
      {
        key: 'LEGEND_ICON_TEXT_GAP',
        label: 'Legend Icon Gap',
        min: 0,
        max: 20,
      },
      { key: 'QR_MAX_SIZE', label: 'QR Max Size', min: 60, max: 300 },
      { key: 'QR_PAD', label: 'QR Padding', min: 0, max: 80 },
    ],
  },
];

const COLOR_KEYS = [
  'primary',
  'header1',
  'header2',
  'accent',
  'youAreHere',
  'orange',
  'white',
  'nearBlack',
  'muted',
  'labelMuted',
  'pillStroke',
  'border',
  'bgLight',
  'mapBg',
];

// ── Data table ─────────────────────────────────────────────────────────────────

// Contenteditable span that bypasses VDOM to avoid clobbering user edits.
// Supports vertical writing-mode (for rotated stop labels) or normal text.
function EditableText({ value, className, title, onChange }) {
  const ref = useRef(null);
  const isEditing = useRef(false);

  useEffect(() => {
    if (ref.current && !isEditing.current) {
      ref.current.textContent = value;
    }
  });

  return (
    <span
      ref={ref}
      class={className}
      title={title}
      contenteditable="true"
      onFocus={() => {
        isEditing.current = true;
      }}
      onBlur={(e) => {
        isEditing.current = false;
        const newVal = e.currentTarget.textContent.trim();
        if (newVal && newVal !== value) onChange(newVal);
        else if (!newVal) e.currentTarget.textContent = value;
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          isEditing.current = false;
          e.currentTarget.textContent = value;
          e.currentTarget.blur();
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain').replace(/\n/g, ' ');
        const sel = window.getSelection();
        if (sel?.rangeCount) {
          sel.deleteFromDocument();
          sel.getRangeAt(0).insertNode(document.createTextNode(text));
          sel.collapseToEnd();
        }
      }}
    />
  );
}

// Controlled input with local state so the user can type freely; commits on blur.
function RouteNameInput({ routeId, value, onChange }) {
  const [local, setLocal] = useState(value);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  return (
    <input
      type="text"
      class="data-table-route-name-input"
      value={local}
      onInput={(e) => setLocal(e.target.value)}
      onBlur={() => {
        const trimmed = local.trim();
        onChange(trimmed || routeId);
        if (!trimmed) setLocal(routeId);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.target.blur();
        if (e.key === 'Escape') {
          setLocal(value);
          e.target.blur();
        }
      }}
    />
  );
}

// Dropdown to pick a route from a list (mirrors StopSelector's UX).
function RouteSelector({ routes, onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const wrapperRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target))
        onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = routes
    .filter(
      (r) =>
        !query ||
        r.routeId.toLowerCase().includes(query.toLowerCase()) ||
        (r.routeName || '').toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 100);

  return (
    <div class="route-selector-dropdown" ref={wrapperRef}>
      <input
        type="text"
        class="stop-search-input"
        placeholder="Search routes by ID or name…"
        value={query}
        onInput={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div class="stop-list">
        {filtered.length > 0 ? (
          filtered.map((r) => (
            <div
              key={r.routeId}
              class="stop-list-item"
              onClick={() => onSelect(r.routeId)}
            >
              <span class="stop-list-id">{r.routeId}</span>
              {r.routeName && <span class="stop-list-name">{r.routeName}</span>}
            </div>
          ))
        ) : (
          <div class="stop-list-empty">No routes found</div>
        )}
      </div>
    </div>
  );
}

function DataTable({ diagramData, stopsData, servicesData, onDataChange }) {
  const [tableRoutes, setTableRoutes] = useState(() =>
    diagramData.routes.map((r) => r.routeId),
  );
  const [tableStops, setTableStops] = useState(() => diagramData.orderedStops);
  const [cellOverrides, setCellOverrides] = useState(() => new Map());
  const [nameOverrides, setNameOverrides] = useState(() => new Map());
  const [routeNameOverrides, setRouteNameOverrides] = useState(() => new Map());
  const [showAddStop, setShowAddStop] = useState(false);
  const [showAddRoute, setShowAddRoute] = useState(false);

  useEffect(() => {
    setTableRoutes(diagramData.routes.map((r) => r.routeId));
    setTableStops(diagramData.orderedStops);
    setCellOverrides(new Map());
    setNameOverrides(new Map());
    setRouteNameOverrides(new Map());
  }, [diagramData]);

  // For each rendered route, build the set of stop IDs it visits (forward journey).
  // Routes added from city data (not in diagramData) use their first sequence.
  const routeStopSets = {};
  for (const routeId of tableRoutes) {
    const inDiagram = diagramData.routes.find((r) => r.routeId === routeId);
    if (inDiagram) {
      routeStopSets[routeId] = new Set(
        (inDiagram.seqForGrouping || inDiagram.stopSequence || []).map(String),
      );
    } else {
      const rd = servicesData[routeId];
      const destId = rd && Object.keys(rd).find((k) => k !== 'name');
      routeStopSets[routeId] = new Set(
        destId ? (rd[destId][0] || []).map(String) : [],
      );
    }
  }

  const isCellHit = (routeId, stopId) => {
    const key = `${routeId}:${stopId}`;
    if (cellOverrides.has(key)) return cellOverrides.get(key);
    return routeStopSets[routeId]?.has(stopId) ?? false;
  };

  const toggleCell = (routeId, stopId) => {
    const current = isCellHit(routeId, stopId);
    const original = routeStopSets[routeId]?.has(stopId) ?? false;
    const next = !current;
    setCellOverrides((prev) => {
      const m = new Map(prev);
      const key = `${routeId}:${stopId}`;
      if (next === original) m.delete(key);
      else m.set(key, next);
      return m;
    });
  };

  const removeRoute = (routeId) =>
    setTableRoutes((prev) => prev.filter((id) => id !== routeId));
  const removeStop = (stopId) =>
    setTableStops((prev) => prev.filter((id) => id !== stopId));

  const addStop = (stopId) => {
    if (!tableStops.includes(stopId))
      setTableStops((prev) => [...prev, stopId]);
    setShowAddStop(false);
  };

  const addRoute = (routeId) => {
    if (!tableRoutes.includes(routeId))
      setTableRoutes((prev) => [...prev, routeId]);
    setShowAddRoute(false);
  };

  const handleApply = () =>
    onDataChange({
      routes: tableRoutes,
      stops: tableStops,
      cellOverrides,
      nameOverrides,
      routeNameOverrides,
    });

  const handleReset = () => {
    setTableRoutes(diagramData.routes.map((r) => r.routeId));
    setTableStops(diagramData.orderedStops);
    setCellOverrides(new Map());
    setNameOverrides(new Map());
    setRouteNameOverrides(new Map());
  };

  const displayStopName = (stopId) =>
    nameOverrides.get(stopId) ?? (stopsData[stopId]?.[2] || stopId);

  const displayRouteName = (routeId) =>
    routeNameOverrides.get(routeId) ?? routeId;

  const availableRoutes = Object.keys(servicesData)
    .filter((id) => !tableRoutes.includes(id))
    .map((id) => ({ routeId: id, routeName: servicesData[id]?.name }));

  return (
    <div class="data-table-wrapper">
      <div class="data-table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th class="data-table-corner" />
              <th class="data-table-route-hdr">Route</th>
              {tableStops.map((stopId) => (
                <th key={stopId} class="data-table-stop-hdr">
                  <button
                    class="data-table-rm"
                    onClick={() => removeStop(stopId)}
                    title={`Remove ${displayStopName(stopId)}`}
                  >
                    ×
                  </button>
                  <EditableText
                    value={displayStopName(stopId)}
                    className="data-table-stop-label"
                    title={`${stopsData[stopId]?.[2] || stopId} (${stopId}) — click to rename`}
                    onChange={(val) =>
                      setNameOverrides((m) => {
                        const n = new Map(m);
                        if (val === (stopsData[stopId]?.[2] || stopId))
                          n.delete(stopId);
                        else n.set(stopId, val);
                        return n;
                      })
                    }
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableRoutes.map((routeId) => (
              <tr key={routeId}>
                <td class="data-table-rm-cell">
                  <button
                    class="data-table-rm"
                    onClick={() => removeRoute(routeId)}
                    title={`Remove route ${routeId}`}
                  >
                    ×
                  </button>
                </td>
                <td class="data-table-route-id">
                  <RouteNameInput
                    routeId={routeId}
                    value={displayRouteName(routeId)}
                    onChange={(val) =>
                      setRouteNameOverrides((m) => {
                        const n = new Map(m);
                        if (val === routeId) n.delete(routeId);
                        else n.set(routeId, val);
                        return n;
                      })
                    }
                  />
                </td>
                {tableStops.map((stopId) => {
                  const hit = isCellHit(routeId, stopId);
                  const original = routeStopSets[routeId]?.has(stopId) ?? false;
                  const forcedOn = hit && !original;
                  const forcedOff = !hit && original;
                  const cls = `data-table-cell${hit ? ' data-table-cell--hit' : ''}${forcedOn ? ' data-table-cell--forced-on' : ''}${forcedOff ? ' data-table-cell--forced-off' : ''}`;
                  return (
                    <td
                      key={stopId}
                      class={cls}
                      onClick={() => toggleCell(routeId, stopId)}
                      title={hit ? 'Click to remove' : 'Click to add'}
                    >
                      {hit ? '●' : forcedOff ? '○' : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="data-table-actions">
        <div class="data-table-add-wrapper">
          <button
            class="data-table-add-btn"
            onClick={() => setShowAddStop((v) => !v)}
          >
            + Stop
          </button>
          {showAddStop && (
            <StopSelector
              stopsData={stopsData}
              onSelect={addStop}
              onClose={() => setShowAddStop(false)}
            />
          )}
        </div>
        <div class="data-table-add-wrapper">
          <button
            class="data-table-add-btn"
            onClick={() => setShowAddRoute((v) => !v)}
            disabled={availableRoutes.length === 0}
          >
            + Route
          </button>
          {showAddRoute && (
            <RouteSelector
              routes={availableRoutes}
              onSelect={addRoute}
              onClose={() => setShowAddRoute(false)}
            />
          )}
        </div>
        <button class="expert-apply-btn" onClick={handleApply}>
          Apply
        </button>
        <button class="expert-reset-btn" onClick={handleReset}>
          Reset
        </button>
      </div>
    </div>
  );
}

// ── Expert panel ───────────────────────────────────────────────────────────────

function ExpertPanel({
  diagramData,
  stopsData,
  servicesData,
  onThemeChange,
  onDataChange,
}) {
  const [vals, setVals] = useState(getCurrentThemeValues);

  const applyNumeric = (key, rawValue) => {
    const value = Number(rawValue);
    if (isNaN(value)) return;
    setVals((prev) => ({ ...prev, [key]: value }));
    patchTheme(key, value);
    onThemeChange();
  };

  const applyColor = (colorKey, value) => {
    setVals((prev) => ({ ...prev, C: { ...prev.C, [colorKey]: value } }));
    patchTheme('C', { [colorKey]: value });
    onThemeChange();
  };

  const applyFont = (key, value) => {
    setVals((prev) => ({ ...prev, [key]: value }));
    patchTheme(key, value);
    onThemeChange();
  };

  const handleReset = () => {
    resetTheme();
    setVals(getCurrentThemeValues());
    onThemeChange();
  };

  return (
    <div class="expert-panel">
      {/* Data override */}
      <div class="expert-data">
        <div class="expert-section-header">
          <span class="expert-section-title">Data Override</span>
        </div>
        <DataTable
          diagramData={diagramData}
          stopsData={stopsData}
          servicesData={servicesData}
          onDataChange={onDataChange}
        />
      </div>

      {/* Theme settings */}
      <div class="expert-theme">
        <div class="expert-section-header">
          <span class="expert-section-title">Theme Settings</span>
          <button class="expert-reset-btn" onClick={handleReset}>
            Reset
          </button>
        </div>

        {THEME_SECTIONS.map((section) => (
          <div class="expert-group" key={section.label}>
            <div class="expert-group-label">{section.label}</div>
            {section.settings.map(({ key, label, step, min, max }) => (
              <label class="expert-row" key={key}>
                <span class="expert-row-label">{label}</span>
                <input
                  type="number"
                  class="expert-row-input"
                  value={vals[key]}
                  min={min}
                  max={max}
                  step={step || 1}
                  onChange={(e) =>
                    setVals((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  onBlur={(e) => applyNumeric(key, e.target.value)}
                />
              </label>
            ))}
          </div>
        ))}

        <div class="expert-group">
          <div class="expert-group-label">Colors</div>
          {COLOR_KEYS.map((colorKey) => (
            <label class="expert-row" key={colorKey}>
              <span class="expert-row-label">{colorKey}</span>
              <input
                type="text"
                class="expert-row-input expert-color-input"
                value={vals.C[colorKey]}
                onChange={(e) =>
                  setVals((prev) => ({
                    ...prev,
                    C: { ...prev.C, [colorKey]: e.target.value },
                  }))
                }
                onBlur={(e) => applyColor(colorKey, e.target.value)}
              />
            </label>
          ))}
        </div>

        <div class="expert-group">
          <div class="expert-group-label">Typography</div>
          {['FONT', 'FONT_KN'].map((key) => (
            <label class="expert-row expert-row--wide" key={key}>
              <span class="expert-row-label">{key}</span>
              <input
                type="text"
                class="expert-row-input"
                value={vals[key]}
                onChange={(e) =>
                  setVals((prev) => ({ ...prev, [key]: e.target.value }))
                }
                onBlur={(e) => applyFont(key, e.target.value)}
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Stop selector dropdown ─────────────────────────────────────────────────────

function StopSelector({ stopsData, onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const wrapperRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target))
        onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = Object.entries(stopsData)
    .filter(([stopId, d]) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return (
        stopId.toLowerCase().includes(q) ||
        (d[2] || '').toLowerCase().includes(q)
      );
    })
    .sort(([, a], [, b]) => (a[2] || '').localeCompare(b[2] || ''))
    .slice(0, 100);

  return (
    <div class="stop-selector-dropdown" ref={wrapperRef}>
      <input
        type="text"
        class="stop-search-input"
        placeholder="Search stops by ID or name…"
        value={query}
        onInput={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div class="stop-list">
        {filtered.length > 0 ? (
          filtered.map(([stopId, d]) => (
            <div
              key={stopId}
              class="stop-list-item"
              onClick={() => onSelect(stopId)}
            >
              <span class="stop-list-id">{stopId}</span>
              <span class="stop-list-name">{d[2]}</span>
            </div>
          ))
        ) : (
          <div class="stop-list-empty">No stops found</div>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function BusDiagram() {
  const [city, setCity] = useState(null);
  const [cityData, setCityData] = useState(null);

  const [stopId, setStopId] = useState(null);
  const [diagramData, setDiagramData] = useState(null);

  const [countMajorRoutes, setCountMajorRoutes] = useState(() =>
    readIntParam('routes', 1, 100, DEFAULT_COUNT_MAJOR_ROUTES),
  );
  const [targetMajorStops, setTargetMajorStops] = useState(() =>
    readIntParam('stops', 1, 50, DEFAULT_TARGET_MAJOR_STOPS),
  );
  const countRef = useRef(countMajorRoutes);
  const stopsRef = useRef(targetMajorStops);

  const [expertMode, setExpertMode] = useState(
    () => new URLSearchParams(location.search).get('expert') === '1',
  );
  const [themeRenderKey, setThemeRenderKey] = useState(0);
  const [routeOverrides, setRouteOverrides] = useState(null);
  const [stopOverrides, setStopOverrides] = useState(null);
  const [cellOverrides, setCellOverrides] = useState(null); // Map<"routeId:stopId", boolean>
  const [nameOverrides, setNameOverrides] = useState(null); // Map<stopId, displayName>
  const [routeNameOverrides, setRouteNameOverrides] = useState(null); // Map<routeId, displayName>

  const [showStopSelector, setShowStopSelector] = useState(false);
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const svgNodeRef = useRef(null);
  const svgHostRef = useRef(null);

  useEffect(() => {
    countRef.current = countMajorRoutes;
    stopsRef.current = targetMajorStops;
  }, [countMajorRoutes, targetMajorStops]);

  // ── Sync URL params ──────────────────────────────────────────────────────────

  useEffect(() => {
    syncUrlParams(countMajorRoutes, targetMajorStops, expertMode);
  }, [countMajorRoutes, targetMajorStops, expertMode]);

  // ── Load city data ───────────────────────────────────────────────────────────

  useEffect(() => {
    const currentCity = getCurrentCity();
    setCity(currentCity);
    loadCityData(currentCity)
      .then(setCityData)
      .catch((err) => {
        setError(`Error loading data: ${err.message}`);
        setLoading(false);
      });
  }, []);

  // ── Handle stop selection from hash ─────────────────────────────────────────

  useEffect(() => {
    if (!cityData) return;

    const handleHashChange = async () => {
      setLoading(true);
      setError(null);
      setDiagramData(null);
      setRouteOverrides(null);
      setStopOverrides(null);
      setCellOverrides(null);
      setNameOverrides(null);
      setRouteNameOverrides(null);

      let resolvedStopId = location.hash.slice(1);
      const route = getRoute();
      if (route.path && route.path !== '/') {
        resolvedStopId = route.path.replace(/^\/[a-z]+\//i, '');
      }
      resolvedStopId = resolvedStopId.replace(/^\/+|\/+$/g, '');

      if (!resolvedStopId) {
        setShowMapPicker(true);
        setStopId(null);
        setLoading(false);
        return;
      }

      setShowMapPicker(false);

      if (!cityData.stopsData[resolvedStopId]) {
        setError(`Stop ${resolvedStopId} not found`);
        setLoading(false);
        return;
      }

      setStopId(resolvedStopId);
      document.title = `Transit Route Diagram — ${cityData.stopsData[resolvedStopId][2]} (${resolvedStopId})`;

      const scheduleData = await loadScheduleData(city, resolvedStopId);
      const result = computeDiagramData(
        resolvedStopId,
        cityData.servicesData,
        cityData.stopsData,
        cityData.rankingData,
        scheduleData,
        {
          targetMajorStops: stopsRef.current,
          countMajorRoutes: countRef.current,
        },
      );

      if (!result) {
        setError(`No routes found for stop ${resolvedStopId}.`);
        setLoading(false);
        return;
      }

      setDiagramData(result);
      setLoading(false);
    };

    window.onhashchange = handleHashChange;
    handleHashChange();
  }, [cityData]);

  // Recompute when controls change
  useEffect(() => {
    if (cityData && stopId) window.onhashchange?.();
  }, [countMajorRoutes, targetMajorStops]);

  // ── Render the D3 SVG whenever diagram data / overrides / theme changes ───────

  useEffect(() => {
    if (!svgHostRef.current || !diagramData || !cityData || !stopId || !city)
      return;
    let cancelled = false;

    const applyCell = (routes) => {
      if (!cellOverrides || cellOverrides.size === 0) return routes;
      return routes.map((route) => {
        const seq = (route.seqForGrouping || route.stopSequence || []).map(
          String,
        );
        const seqSet = new Set(seq);
        let changed = false;
        for (const [key, val] of cellOverrides) {
          const colon = key.indexOf(':');
          if (key.slice(0, colon) !== route.routeId) continue;
          const sid = key.slice(colon + 1);
          if (val && !seqSet.has(sid)) {
            seqSet.add(sid);
            changed = true;
          }
          if (!val && seqSet.has(sid)) {
            seqSet.delete(sid);
            changed = true;
          }
        }
        if (!changed) return route;
        const newSeq = seq.filter((s) => seqSet.has(s));
        for (const s of seqSet) {
          if (!seq.includes(s)) newSeq.push(s);
        }
        return { ...route, seqForGrouping: newSeq, stopSequence: newSeq };
      });
    };

    const baseRoutes =
      routeOverrides && routeOverrides.length > 0
        ? routeOverrides
            .map((id) => {
              const inDiagram = diagramData.routes.find(
                (r) => r.routeId === id,
              );
              if (inDiagram) return inDiagram;
              const rd = cityData.servicesData[id];
              if (!rd) return null;
              const destId = Object.keys(rd).find((k) => k !== 'name');
              if (!destId) return null;
              const seq = (rd[destId][0] || []).map(String);
              return {
                routeId: id,
                routeName: rd.name,
                destinationStopId: destId,
                stopSequence: rd[destId][0] || [],
                seqForGrouping: seq,
                tripCount: 0,
              };
            })
            .filter(Boolean)
        : diagramData.routes;
    const cellRoutes = applyCell(
      baseRoutes.length > 0 ? baseRoutes : diagramData.routes,
    );

    const effectiveRoutes =
      routeNameOverrides?.size > 0
        ? cellRoutes.map((route) =>
            routeNameOverrides.has(route.routeId)
              ? { ...route, routeName: routeNameOverrides.get(route.routeId) }
              : route,
          )
        : cellRoutes;

    const effectiveStops =
      stopOverrides && stopOverrides.length > 0
        ? stopOverrides
        : diagramData.orderedStops;

    const effectiveStopsData =
      nameOverrides?.size > 0
        ? {
            ...cityData.stopsData,
            ...Object.fromEntries(
              [...nameOverrides.entries()].map(([id, name]) => {
                const d = cityData.stopsData[id];
                return [
                  id,
                  d ? [d[0], d[1], name, ...d.slice(3)] : [null, null, name],
                ];
              }),
            ),
          }
        : cityData.stopsData;

    renderDiagramSVG(svgHostRef.current, {
      stopId,
      stopsData: effectiveStopsData,
      routes: effectiveRoutes,
      orderedStops: effectiveStops,
      city,
    }).then((node) => {
      if (!cancelled) svgNodeRef.current = node;
    });

    return () => {
      cancelled = true;
    };
  }, [
    diagramData,
    stopId,
    city,
    cityData,
    themeRenderKey,
    routeOverrides,
    stopOverrides,
    cellOverrides,
    nameOverrides,
    routeNameOverrides,
  ]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleStopSelect = (selectedStopId) => {
    setShowStopSelector(false);
    window.location.hash = `#${selectedStopId}`;
  };

  const handleExportSvg = () => {
    const svg = svgNodeRef.current || svgHostRef.current?.querySelector('svg');
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stop-diagram-${stopId}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Loading / error states ────────────────────────────────────────────────────

  if (loading && !diagramData) {
    return (
      <div class="diagram-loading">
        <p class="diagram-loading-text">Loading diagram…</p>
      </div>
    );
  }

  if (showMapPicker && cityData) {
    return (
      <MapPicker
        stopsData={cityData.stopsData}
        onStopSelect={handleStopSelect}
      />
    );
  }

  if (error) {
    return (
      <div class="diagram-error">
        <h2>Error</h2>
        <p>{error}</p>
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────────

  return (
    <div class="diagram-page">
      {/* Controls bar — HTML overlay above the SVG */}
      <div class="controls-bar">
        <div class="stop-selector-wrapper">
          <button
            class="stop-change-button"
            onClick={() => setShowStopSelector(!showStopSelector)}
            title="Change stop"
          >
            <span class="stop-tag">{stopId}</span>
            <span class="stop-change-label">
              {cityData?.stopsData[stopId]?.[2]}
            </span>
          </button>
          {showStopSelector && cityData && (
            <StopSelector
              stopsData={cityData.stopsData}
              onSelect={handleStopSelect}
              onClose={() => setShowStopSelector(false)}
            />
          )}
        </div>
        <Controls
          countMajorRoutes={countMajorRoutes}
          targetMajorStops={targetMajorStops}
          onCountMajorRoutesChange={setCountMajorRoutes}
          onTargetMajorStopsChange={setTargetMajorStops}
          onExportSvg={handleExportSvg}
          expertMode={expertMode}
          onExpertModeToggle={() => setExpertMode((m) => !m)}
        />
      </div>

      {/* SVG host — D3 renders directly into this div */}
      <div class="diagram-svg-host" ref={svgHostRef} />

      {/* Expert panel — shown below the diagram in expert mode */}
      {expertMode && diagramData && cityData && (
        <ExpertPanel
          diagramData={diagramData}
          stopsData={cityData.stopsData}
          servicesData={cityData.servicesData}
          onThemeChange={() => setThemeRenderKey((k) => k + 1)}
          onDataChange={({
            routes,
            stops,
            cellOverrides: co,
            nameOverrides: no,
            routeNameOverrides: rno,
          }) => {
            setRouteOverrides(routes.length > 0 ? routes : null);
            setStopOverrides(stops.length > 0 ? stops : null);
            setCellOverrides(co?.size > 0 ? co : null);
            setNameOverrides(no?.size > 0 ? no : null);
            setRouteNameOverrides(rno?.size > 0 ? rno : null);
          }}
        />
      )}
    </div>
  );
}
