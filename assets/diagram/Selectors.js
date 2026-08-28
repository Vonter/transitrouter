import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';

// Searchable dropdowns shared by the expert panel and the in-place editor.

// Dropdown to pick a route from a list (mirrors StopSelector's UX).
export function RouteSelector({ routes, onSelect, onClose }) {
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

export function StopSelector({ stopsData, onSelect, onClose }) {
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
