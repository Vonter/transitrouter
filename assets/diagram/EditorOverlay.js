import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { RouteSelector, StopSelector } from './Selectors';
import StopLabelEditor, { createStopLabelEdit } from './StopLabelEditor';
import RouteEditor from './RouteEditor';
import { normalizeBranchConfig } from './branching.mjs';

// ══════════════════════════════════════════════════════════════════════════════
// In-place editor for the rendered diagram.
//
// The SVG stays a plain D3 render: this overlay sits on top of it, reads the
// positions of the elements it wants to act on, and turns clicks and drags into
// override callbacks. Nothing it draws ends up in the exported SVG.
//
//   • click a stop name (header, marker or label) → rename it
//   • drag a stop label                           → nudge it off its marker
//   • click a route badge or track chip           → rename / remove / split off
//   • drag a track chip onto another track        → change where routes branch
//   • "+" beside the badges                       → add a route
// ══════════════════════════════════════════════════════════════════════════════

// A drag has to travel this far before it stops counting as a click.
const DRAG_THRESHOLD = 4;

function offsetIn(originEl, el) {
  const a = el.getBoundingClientRect();
  const b = originEl.getBoundingClientRect();
  return {
    left: a.left - b.left,
    top: a.top - b.top,
    width: a.width,
    height: a.height,
  };
}

function popoverPosition(overlay, box, width, height) {
  const below = box.top + box.height + 8;
  return {
    left: Math.max(8, Math.min(box.left, overlay.clientWidth - width - 8)),
    top:
      below + height <= overlay.clientHeight
        ? below
        : Math.max(8, box.top - height - 8),
  };
}

// Screen y of a track's centre line, read from the layout coordinate the
// renderer stamped on it so the diagram's own scaling is accounted for.
function trackScreenY(trackEl) {
  const ctm = trackEl.parentNode.getScreenCTM();
  const y = Number(trackEl.getAttribute('data-track-y'));
  return ctm.f + ctm.d * y;
}

// Route paths are monotonic from left to right. Find the rendered point where
// one crosses a requested screen x so insertion buttons follow diagonal branch
// segments as well as horizontal track sections.
function pointOnPathAtScreenX(path, screenX, originBox) {
  const ctm = path.getScreenCTM();
  const length = path.getTotalLength();
  if (!ctm || !length) return null;

  let low = 0;
  let high = length;
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) / 2;
    const point = path.getPointAtLength(middle);
    const rendered = new DOMPoint(point.x, point.y).matrixTransform(ctm);
    if (rendered.x < screenX) low = middle;
    else high = middle;
  }
  const point = path.getPointAtLength((low + high) / 2);
  const rendered = new DOMPoint(point.x, point.y).matrixTransform(ctm);
  return {
    x: rendered.x - originBox.left,
    y: rendered.y - originBox.top,
  };
}

export default function EditorOverlay({
  hostRef,
  renderKey,
  routes,
  stops,
  stopsData,
  detectedStopIcons,
  stopIconOverrides,
  currentStopId,
  labelOffsets,
  branchOverrides,
  availableRoutes,
  onApplyStop,
  onRenameTowards,
  onMoveLabel,
  onApplyRoute,
  onRemoveRoute,
  onMoveRouteToTrack,
  onAddRoute,
  onAddStop,
  onRemoveStop,
}) {
  const overlayRef = useRef(null);
  const stateRef = useRef({});
  const cancelInlineRef = useRef(false);
  const [nameEdit, setNameEdit] = useState(null);
  const [stopMenu, setStopMenu] = useState(null);
  const [routeMenu, setRouteMenu] = useState(null);
  const [addAnchor, setAddAnchor] = useState(null);
  const [stopAnchors, setStopAnchors] = useState({ gaps: [], stops: [] });
  const [showAddRoute, setShowAddRoute] = useState(false);
  const [addStopAt, setAddStopAt] = useState(null);
  const [ghost, setGhost] = useState(null);
  const [dropY, setDropY] = useState(null);

  // Live values for the pointer handlers, which are bound once per SVG render.
  stateRef.current = {
    routes,
    labelOffsets,
    branchOverrides,
    detectedStopIcons,
    stopIconOverrides,
    onMoveLabel,
    onMoveRouteToTrack,
  };

  const closeAll = () => {
    setNameEdit(null);
    setStopMenu(null);
    setRouteMenu(null);
    setShowAddRoute(false);
    setAddStopAt(null);
  };

  // ── Where the "+ route" button goes ────────────────────────────────────────

  useLayoutEffect(() => {
    const measure = () => {
      const overlay = overlayRef.current;
      const badges = hostRef.current?.querySelectorAll('.route-badge');
      if (!overlay || !badges?.length) return setAddAnchor(null);
      const last = offsetIn(overlay, badges[badges.length - 1]);
      setAddAnchor({
        left: last.left + last.width + 6,
        top: last.top,
        height: last.height,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [renderKey]);

  // Build insertion points from route adjacency rather than the global stop
  // list. On a branched diagram, consecutive entries in that global list can
  // belong to entirely different tracks or even share the same visual column.
  useLayoutEffect(() => {
    const measure = () => {
      const overlay = overlayRef.current;
      const host = hostRef.current;
      if (!overlay || !host) return;

      const originBox = overlay.getBoundingClientRect();

      const elements = [
        ...host.querySelectorAll(
          '#current-stop-pill [data-stop-id], #stop-pills [data-stop-id]',
        ),
      ];
      const byId = new Map(
        elements.map((el) => [el.getAttribute('data-stop-id'), el]),
      );
      const positioned = stops
        .map((stopId, index) => {
          const el = byId.get(String(stopId));
          if (!el) return null;
          const box = offsetIn(overlay, el);
          return {
            stopId: String(stopId),
            index,
            x: box.left + box.width / 2,
            y: box.top + box.height / 2,
            right: box.left + box.width,
            top: box.top,
          };
        })
        .filter(Boolean);

      const positionedById = new Map(
        positioned.map((item) => [item.stopId, item]),
      );
      const shownStops = new Set(stops.map(String));
      const pathsByKey = new Map(
        [...host.querySelectorAll('.route-track')].map((path) => [
          path.getAttribute('data-track-key'),
          path,
        ]),
      );
      const trackKeyByRoute = new Map(
        [...host.querySelectorAll('.route-chip')].map((chip) => [
          chip.getAttribute('data-route-id'),
          chip.getAttribute('data-track-key'),
        ]),
      );
      const pairs = new Map();

      routes.forEach((route) => {
        const sequence = (route.seqForGrouping || route.stopSequence || []).map(
          String,
        );
        const currentIndex = sequence.indexOf(currentStopId);
        const forward =
          currentIndex < 0 ? sequence : sequence.slice(currentIndex);
        const path = pathsByKey.get(trackKeyByRoute.get(String(route.routeId)));
        let previous = null;
        let candidates = [];

        forward.forEach((stopId) => {
          if (!shownStops.has(stopId)) {
            if (previous && stopsData[stopId]) candidates.push(stopId);
            return;
          }
          if (previous && previous !== stopId) {
            const key = `${previous}:${stopId}`;
            if (!pairs.has(key)) {
              pairs.set(key, {
                key,
                leftId: previous,
                rightId: stopId,
                paths: new Set(),
                candidateStopIds: new Set(),
              });
            }
            const pair = pairs.get(key);
            if (path) pair.paths.add(path);
            candidates.forEach((id) => pair.candidateStopIds.add(id));
          }
          previous = stopId;
          candidates = [];
        });
      });

      const gaps = [...pairs.values()]
        .map((pair) => {
          const left = positionedById.get(pair.leftId);
          const right = positionedById.get(pair.rightId);
          if (!left || !right || right.x - left.x < 2) return null;

          const x = (left.x + right.x) / 2;
          const points = [...pair.paths]
            .map((path) =>
              pointOnPathAtScreenX(path, originBox.left + x, originBox),
            )
            .filter(Boolean);
          if (!points.length) return null;
          const desiredY = (left.y + right.y) / 2;
          const point = points.reduce((closest, candidate) =>
            Math.abs(candidate.y - desiredY) < Math.abs(closest.y - desiredY)
              ? candidate
              : closest,
          );
          const rightIndex = stops.indexOf(pair.rightId);
          const leftIndex = stops.indexOf(pair.leftId);
          return {
            key: pair.key,
            index: rightIndex >= 0 ? rightIndex : leftIndex + 1,
            x: point.x,
            y: point.y,
            leftId: pair.leftId,
            rightId: pair.rightId,
            candidateStopIds: [...pair.candidateStopIds],
          };
        })
        .filter(Boolean);

      setStopAnchors({
        stops: positioned.filter((item) => item.stopId !== currentStopId),
        gaps,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [renderKey, stops.join(','), currentStopId]);

  // Any re-render of the SVG invalidates the positions the popovers were
  // anchored to, so they close rather than float somewhere meaningless.
  useEffect(closeAll, [renderKey]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && closeAll();
    // Clicks on the diagram itself are handled by its own listener below.
    const onDown = (e) => {
      if (overlayRef.current?.contains(e.target)) return;
      if (hostRef.current?.contains(e.target)) return;
      closeAll();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, []);

  // ── Pointer handling on the rendered SVG ───────────────────────────────────

  useEffect(() => {
    const svg = hostRef.current?.querySelector('svg');
    const overlay = overlayRef.current;
    if (!svg || !overlay) return;
    svg.classList.add('diagram-svg--editable');

    const openStopEditor = (stopId, el, value) => {
      const box = offsetIn(overlay, el);
      const detected = stateRef.current.detectedStopIcons[stopId] || new Map();
      const override = stateRef.current.stopIconOverrides?.get(stopId);
      setRouteMenu(null);
      setNameEdit(null);
      setStopMenu(
        createStopLabelEdit(
          stopId,
          value,
          detected,
          override,
          popoverPosition(overlay, box, 284, 330),
        ),
      );
    };

    const openTowardsEditor = (el) => {
      const box = offsetIn(overlay, el);
      setRouteMenu(null);
      setStopMenu(null);
      cancelInlineRef.current = false;
      setNameEdit({
        kind: 'towards',
        value: el.textContent.replace(/^\(|\)$/g, '').trim(),
        left: box.left,
        top: box.top + box.height / 2 - 14,
        width: Math.max(180, box.width),
      });
    };

    const openRouteMenu = (routeId, el) => {
      const box = offsetIn(overlay, el);
      const route = stateRef.current.routes.find((r) => r.routeId === routeId);
      const chip = [...svg.querySelectorAll('.route-chip')].find(
        (item) => item.getAttribute('data-route-id') === routeId,
      );
      const trackKey = chip?.getAttribute('data-track-key') || '';
      setNameEdit(null);
      setStopMenu(null);
      setRouteMenu({
        routeId,
        label: route?.displayId || routeId,
        name: route?.routeName || '',
        trackKey,
        branch: normalizeBranchConfig(
          stateRef.current.branchOverrides?.get(trackKey),
        ),
        ...popoverPosition(overlay, box, 260, 430),
      });
    };

    // Drags the rotated label group by rewriting its transform live, then
    // commits the total nudge once the pointer is released.
    const dragLabel = (e, labelEl) => {
      const stopId = labelEl.getAttribute('data-stop-id');
      const base = labelEl.getAttribute('transform');
      const k = labelEl.parentNode.getScreenCTM().a || 1;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragging = true;
        labelEl.setAttribute(
          'transform',
          `translate(${dx / k},${dy / k}) ${base}`,
        );
      };

      const onUp = (ev) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const { labelOffsets: offsets, onMoveLabel: move } = stateRef.current;
        if (!dragging) {
          openStopEditor(
            stopId,
            labelEl,
            labelEl.getAttribute('data-stop-name') || '',
          );
          return;
        }
        const [px, py] = offsets?.get(stopId) || [0, 0];
        move(stopId, [
          px + (ev.clientX - startX) / k,
          py + (ev.clientY - startY) / k,
        ]);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    // Drags a route chip across the stack of tracks. Dropping it clear of the
    // outermost track splits the route onto a track of its own.
    const dragChip = (e, chipEl) => {
      const routeId = chipEl.getAttribute('data-route-id');
      const fromKey = chipEl.getAttribute('data-track-key');
      const label = chipEl.querySelector('text')?.textContent || routeId;
      const tracks = [...svg.querySelectorAll('.route-track')]
        .map((t) => ({
          key: t.getAttribute('data-track-key'),
          y: trackScreenY(t),
        }))
        .sort((a, b) => a.y - b.y);
      if (!tracks.length) return;
      const pitch =
        tracks.length > 1
          ? Math.min(...tracks.slice(1).map((t, i) => t.y - tracks[i].y))
          : 24;

      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;

      const targetFor = (clientY) => {
        if (
          clientY < tracks[0].y - pitch ||
          clientY > tracks[tracks.length - 1].y + pitch
        )
          return null;
        return tracks.reduce((best, t) =>
          Math.abs(t.y - clientY) < Math.abs(best.y - clientY) ? t : best,
        );
      };

      const onMove = (ev) => {
        if (
          !dragging &&
          Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD
        )
          return;
        dragging = true;
        chipEl.classList.add('route-chip--dragging');
        const origin = overlay.getBoundingClientRect();
        setGhost({
          label,
          left: ev.clientX - origin.left,
          top: ev.clientY - origin.top,
        });
        const target = targetFor(ev.clientY);
        setDropY(target ? target.y - origin.top : null);
      };

      const onUp = (ev) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        chipEl.classList.remove('route-chip--dragging');
        setGhost(null);
        setDropY(null);
        if (!dragging) {
          openRouteMenu(routeId, chipEl);
          return;
        }
        const target = targetFor(ev.clientY);
        const targetKey = target ? target.key : '';
        if (targetKey !== fromKey) {
          stateRef.current.onMoveRouteToTrack(routeId, targetKey);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      const el = e.target;
      const chip = el.closest?.('.route-chip');
      const badge = el.closest?.('.route-badge');
      const label = el.closest?.('.stop-label');
      const header = el.closest?.('.stop-name-text');
      const towards = el.closest?.('.towards-text');
      const pill = el.closest?.('#stop-pills [data-stop-id]');
      const currentPill = el.closest?.('#current-stop-pill [data-stop-id]');

      if (chip) {
        e.preventDefault();
        dragChip(e, chip);
      } else if (badge) {
        e.preventDefault();
        openRouteMenu(badge.getAttribute('data-route-id'), badge);
      } else if (label) {
        e.preventDefault();
        dragLabel(e, label);
      } else if (towards) {
        e.preventDefault();
        openTowardsEditor(towards);
      } else if (header) {
        e.preventDefault();
        openStopEditor(
          header.parentNode.getAttribute('data-stop-id'),
          header,
          header.textContent,
        );
      } else if (pill || currentPill) {
        e.preventDefault();
        const stopPill = pill || currentPill;
        openStopEditor(
          stopPill.getAttribute('data-stop-id'),
          stopPill,
          stopPill.getAttribute('data-stop-name') || '',
        );
      } else {
        closeAll();
      }
    };

    svg.addEventListener('pointerdown', onPointerDown);
    return () => {
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.classList.remove('diagram-svg--editable');
    };
  }, [renderKey]);

  // ── Overlay chrome ─────────────────────────────────────────────────────────

  return (
    <div class="diagram-editor" ref={overlayRef}>
      {addAnchor && (
        <div
          class="editor-add-wrapper"
          style={{ left: `${addAnchor.left}px`, top: `${addAnchor.top}px` }}
        >
          <button
            class="editor-add-route"
            style={{ height: `${addAnchor.height}px` }}
            title="Add a route to this diagram"
            disabled={availableRoutes.length === 0}
            onClick={() => setShowAddRoute((v) => !v)}
          >
            +
          </button>
          {showAddRoute && (
            <RouteSelector
              routes={availableRoutes}
              onSelect={(routeId) => {
                setShowAddRoute(false);
                onAddRoute(routeId);
              }}
              onClose={() => setShowAddRoute(false)}
            />
          )}
        </div>
      )}

      {stopAnchors.gaps
        .filter((anchor) => anchor.candidateStopIds.length > 0)
        .map((anchor) => (
          <div
            class={`editor-stop-action editor-stop-insert${
              addStopAt === anchor.key ? ' editor-stop-insert--active' : ''
            }`}
            key={`gap-${anchor.key}`}
            style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}
          >
            <button
              class="editor-stop-action-button editor-stop-insert-button"
              title={`Add a stop between ${
                stopsData[anchor.leftId]?.[2] || anchor.leftId
              } and ${stopsData[anchor.rightId]?.[2] || anchor.rightId}`}
              aria-label="Add a stop here"
              onClick={() =>
                setAddStopAt((current) =>
                  current === anchor.key ? null : anchor.key,
                )
              }
            >
              +
            </button>
            {addStopAt === anchor.key && (
              <StopSelector
                stopsData={Object.fromEntries(
                  anchor.candidateStopIds.map((stopId) => [
                    stopId,
                    stopsData[stopId],
                  ]),
                )}
                onSelect={(stopId) => {
                  setAddStopAt(null);
                  onAddStop(stopId, anchor.index);
                }}
                onClose={() => setAddStopAt(null)}
              />
            )}
          </div>
        ))}

      {stopAnchors.stops.map((anchor) => (
        <button
          class="editor-stop-action editor-stop-remove-button"
          key={`remove-${anchor.stopId}`}
          style={{ left: `${anchor.right}px`, top: `${anchor.top}px` }}
          title={`Remove ${stopsData[anchor.stopId]?.[2] || anchor.stopId}`}
          onClick={() => onRemoveStop(anchor.stopId)}
        >
          ×
        </button>
      ))}

      {nameEdit && (
        <input
          class="editor-inline-input"
          aria-label="Towards text"
          style={{
            left: `${nameEdit.left}px`,
            top: `${nameEdit.top}px`,
            width: `${nameEdit.width}px`,
          }}
          value={nameEdit.value}
          autoFocus
          onInput={(e) => setNameEdit({ ...nameEdit, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur();
            if (e.key === 'Escape') {
              cancelInlineRef.current = true;
              e.target.blur();
            }
          }}
          onBlur={() => {
            const value = nameEdit.value.trim();
            setNameEdit(null);
            if (!cancelInlineRef.current) onRenameTowards(value);
            cancelInlineRef.current = false;
          }}
        />
      )}

      {stopMenu && (
        <StopLabelEditor
          value={stopMenu}
          onChange={setStopMenu}
          onClose={() => setStopMenu(null)}
          onApply={({ stopId, name, iconOverride }) => {
            onApplyStop(stopId, name, iconOverride);
            setStopMenu(null);
          }}
        />
      )}

      {routeMenu && (
        <RouteEditor
          value={routeMenu}
          onChange={setRouteMenu}
          onClose={() => setRouteMenu(null)}
          onApply={(edit) => {
            onApplyRoute(edit);
            setRouteMenu(null);
          }}
          onSplit={() => {
            onMoveRouteToTrack(routeMenu.routeId, '');
            setRouteMenu(null);
          }}
          onRemove={() => {
            onRemoveRoute(routeMenu.routeId);
            setRouteMenu(null);
          }}
        />
      )}

      {dropY !== null && (
        <div class="editor-drop-guide" style={{ top: `${dropY}px` }} />
      )}

      {ghost && (
        <div
          class="editor-drag-ghost"
          style={{ left: `${ghost.left}px`, top: `${ghost.top}px` }}
        >
          {ghost.label}
        </div>
      )}
    </div>
  );
}
