import './i18n';

import { getCurrentCity } from './config';
import { h, render } from 'preact';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import format from 'date-fns/format';
import { useTranslation } from 'react-i18next';

import Fuse from 'fuse.js';
import fetchCache from './utils/fetchCache';
import { sortServices } from './utils/bus';

const city = getCurrentCity();
const dataPath = `/data/${city}`;
const SCHEDULE_CDN = `https://data.transitrouter.vonter.in/${city}/schedule`;
const firstLastJSONPath = `${dataPath}/firstlast.min.json`;
const stopsJSONPath = `${dataPath}/stops.min.json`;
const servicesJSONPath = `${dataPath}/services.min.json`;

// ── Hash routing ──────────────────────────────────────────────
// #/{city}/{stopId}                              → stop timetable
// #/{city}/{stopId}/{routeNo}                    → trip grid
// #/{city}/{stopId}/{routeNo}/{time}/{dest}      → route timetable
// #/{city}/route/{routeNo}[/{stopId}]            → route overview

const enc = encodeURIComponent;
const dec = decodeURIComponent;

const parseHash = () => {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[1] === 'route') {
    return {
      view: 'route-overview',
      routeNo: dec(parts[2] || ''),
      stopId: parts[3] ? dec(parts[3]) : null,
    };
  }
  const stopId = parts[1] || '';
  const routeNo = parts[2] ? dec(parts[2]) : null;
  const time = parts[3] ? dec(parts[3]) : null;
  const dest = parts[4] ? dec(parts[4]) : null;
  if (routeNo && time && dest) return { view: 'route-timetable', stopId, routeNo, time, dest };
  if (routeNo) return { view: 'trip-grid', stopId, routeNo };
  if (stopId) return { view: 'stop-timetable', stopId };
  return { view: 'empty' };
};

const buildHash = (view, p = {}) => {
  const pre = `#/${city}`;
  switch (view) {
    case 'stop-timetable': return `${pre}/${p.stopId}`;
    case 'trip-grid': return `${pre}/${p.stopId}/${enc(p.routeNo)}`;
    case 'route-timetable': return `${pre}/${p.stopId}/${enc(p.routeNo)}/${enc(p.time)}/${enc(p.dest)}`;
    case 'route-overview': return p.stopId
      ? `${pre}/route/${enc(p.routeNo)}/${enc(p.stopId)}`
      : `${pre}/route/${enc(p.routeNo)}`;
    default: return pre;
  }
};

const navigate = (view, params) => {
  location.hash = buildHash(view, params);
};

// ── Utilities ─────────────────────────────────────────────────

const parseTime = (time) => {
  if (typeof time === 'string' && /^\d{1,2}:\d{2}$/.test(time)) {
    const [h, m] = time.split(':').map(Number);
    return h + m / 60;
  }
  if (typeof time === 'string' && /\d{4}/.test(time)) {
    return parseInt(time.slice(0, 2), 10) + parseInt(time.slice(2), 10) / 60;
  }
  return NaN;
};

const timeFormat = (time) => {
  if (typeof time === 'string' && /^\d{1,2}:\d{2}$/.test(time)) return time;
  if (time instanceof Date) return format(time, 'HH:mm');
  const val = parseTime(time);
  if (isNaN(val)) return '-';
  const h = Math.floor(val), m = Math.round((val - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const hasValidTiming = (t) =>
  t && t !== '=' && !isNaN(parseTime(t));

const combineTimes = (ef, el, nf, nl) => {
  if (!nf || nf === '=' || !hasValidTiming(nf)) return [ef, el];
  if (!ef || ef === '=' || !hasValidTiming(ef)) return [nf, nl];
  const first = Math.min(parseTime(ef), parseTime(nf));
  const last = Math.max(parseTime(el), parseTime(nl));
  const fmt = (v) => {
    const h = Math.floor(v), m = Math.round((v % 1) * 60);
    return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
  };
  return [fmt(first), fmt(last)];
};

const stopName = (stops, id) => stops?.[id]?.[2] || id;
const stopFullName = (stops, id) => {
  const name = stopName(stops, id);
  const suffix = stops?.[id]?.[3] || '';
  return suffix ? `${name} ${suffix}` : name;
};

const computeHeadway = (count, first, last) => {
  if (!count || count <= 1 || !hasValidTiming(first) || !hasValidTiming(last)) return null;
  const span = parseTime(last) - parseTime(first);
  const adjusted = span <= 0 ? span + 24 : span;
  return adjusted > 0 ? Math.round((adjusted * 60) / (count - 1)) : null;
};

const formatHeadway = (min) => {
  if (!min) return '—';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

// ── Shared components ─────────────────────────────────────────

const BackButton = ({ onClick, label }) => (
  <button class="back-button" onClick={onClick}>
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
    {label}
  </button>
);

const RouteHeader = ({ routeNo, routeName, backLabel }) => (
  <header class="subpage-header">
    <BackButton onClick={() => history.back()} label={backLabel} />
    <div class="route-timetable-title">
      <span class="route-badge">{routeNo}</span>
      <span class="route-name">{routeName}</span>
    </div>
  </header>
);

const StopRow = ({ sid, idx, total, isCurrent, time, loading, stopsData, href }) => {
  const cls = [
    'route-stop clickable',
    isCurrent && 'current',
    idx === 0 && 'first',
    idx === total - 1 && 'last',
  ].filter(Boolean).join(' ');
  return (
    <a class={cls} key={sid} href={href}>
      {time !== undefined && (
        <span class="stop-time-col">
          {loading ? <span class="placeholder">█████</span>
            : time ? timeFormat(time) : '—'}
        </span>
      )}
      <span class="stop-line"><span class="stop-dot" /></span>
      <span class="stop-info">
        <span class="stop-label">{stopName(stopsData, sid)}</span>
      </span>
    </a>
  );
};

const StopListPlaceholder = () => (
  <div class="route-stops-loading">
    {[1, 2, 3, 4, 5].map((i) => (
      <div class="route-stop placeholder-stop" key={i}>
        <span class="stop-time-col"><span class="placeholder">█████</span></span>
        <span class="stop-line"><span class="stop-dot" /></span>
        <span class="stop-info"><span class="placeholder">████████████</span></span>
      </div>
    ))}
  </div>
);

const TimeRanger = ({ values }) => {
  if (!values) return <div class="time-ranger nada" />;
  const [first, last] = values;
  if (!first || !hasValidTiming(first)) return <div class="time-ranger nada" />;
  const fv = parseTime(first), lv = parseTime(last);
  const left = (fv / 24) * 100;
  const dur = (lv < fv ? lv + 24 : lv) - fv;
  const width = (dur / 24) * 100;
  return (
    <div class="time-ranger" title={`${timeFormat(first)} – ${timeFormat(last)}`}>
      {width + left > 100 && <div class="bar" style={{ left: 0, width: `${width + left - 100}%` }} />}
      <div class="bar" style={{ left: `${left}%`, width: `${width}%` }} />
    </div>
  );
};

// ── Trip grid (Level 2) ──────────────────────────────────────

function TripGridPage({ stopId, routeNo, stopsData }) {
  const { t } = useTranslation();
  const [serviceData, setServiceData] = useState(null);
  const [loading, setLoading] = useState(true);
  const now = format(new Date(), 'HH:mm');

  useEffect(() => {
    setLoading(true);
    fetchCache(`${SCHEDULE_CDN}/${stopId}.json`, 60)
      .then((data) => setServiceData(data.services.filter((s) => s.no === routeNo)))
      .catch(() => setServiceData([]))
      .finally(() => setLoading(false));
  }, [stopId, routeNo]);

  return (
    <div class="trip-grid-page">
      <header class="subpage-header">
        <BackButton onClick={() => history.back()} label={t('timetable.backToStop')} />
        <h1 class="subpage-title">
          <span class="route-badge">{routeNo}</span>
          <span>{t('timetable.preHeading')}<br />{stopFullName(stopsData, stopId)}</span>
        </h1>
      </header>
      <div class="trip-grid-content">
        {loading && <div class="trip-grid-loading"><span class="placeholder">████ ████ ████ ████ ████ ████</span></div>}
        {!loading && !serviceData?.length && <p class="trip-grid-empty">{t('timetable.noSchedule')}</p>}
        {serviceData?.map((svc) => (
          <div class="trip-grid-section" key={`${svc.origin}-${svc.destination}`}>
            <div class="trip-grid-meta">
              <span class="trip-count">{svc.trip_count} {t('timetable.tripsLabel')}</span>
              <span class="trip-direction">{stopName(stopsData, svc.origin)} → {stopName(stopsData, svc.destination)}</span>
            </div>
            <div class="trip-grid">
              {svc.trips.map((time) => (
                <button
                  key={time}
                  class={`trip-chip${time < now ? ' past' : ''}`}
                  onClick={() => navigate('route-timetable', { stopId, routeNo, time, dest: svc.destination })}
                >{time}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Route timetable (Level 3) ────────────────────────────────

function RouteTimetablePage({ stopId, routeNo, selectedTime, dest, stopsData }) {
  const { t } = useTranslation();
  const [routeStops, setRouteStops] = useState(null);
  const [stopTimes, setStopTimes] = useState(null);
  const [routeName, setRouteName] = useState('');
  const [loading, setLoading] = useState(true);
  const panelRef = useRef(null);

  useEffect(() => {
    setLoading(true);
    fetchCache(servicesJSONPath, 24 * 60).then((services) => {
      const route = services[routeNo];
      if (!route) { setLoading(false); return; }
      setRouteName(route.name || '');
      const stops = route[dest]?.[0];
      if (!stops) { setLoading(false); return; }
      setRouteStops(stops);

      fetchCache(`${SCHEDULE_CDN}/${stopId}.json`, 60).then((sched) => {
        const svc = sched.services.find((s) => s.no === routeNo && s.destination === dest);
        const idx = svc?.trips?.indexOf(selectedTime) ?? -1;
        if (idx < 0) { setLoading(false); return; }
        return Promise.all(
          stops.map((sid) =>
            fetchCache(`${SCHEDULE_CDN}/${sid}.json`, 60)
              .then((d) => [sid, d.services.find((s) => s.no === routeNo && s.destination === dest)?.trips?.[idx] || null])
              .catch(() => [sid, null])
          ),
        );
      }).then((results) => {
        if (results) {
          setStopTimes(Object.fromEntries(results));
        }
        setLoading(false);
      });
    });
  }, [routeNo, dest, selectedTime, stopId]);

  useEffect(() => {
    if (!loading && panelRef.current) {
      panelRef.current.querySelector('.route-stop.current')
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [loading]);

  return (
    <div class="route-timetable-page" ref={panelRef}>
      <RouteHeader routeNo={routeNo} routeName={routeName} backLabel={t('timetable.backToTrips')} />
      <div class="route-stops-list">
        {loading && !routeStops && <StopListPlaceholder />}
        {routeStops?.map((sid, idx) => (
          <StopRow
            key={sid} sid={sid} idx={idx} total={routeStops.length}
            isCurrent={sid === stopId}
            time={stopTimes?.[sid]} loading={loading && !stopTimes}
            stopsData={stopsData}
            href={buildHash('stop-timetable', { stopId: sid })}
          />
        ))}
      </div>
    </div>
  );
}

// ── Route overview ───────────────────────────────────────────

function RouteOverviewPage({ routeNo, stopId: contextStopId, stopsData }) {
  const { t } = useTranslation();
  const [routeName, setRouteName] = useState('');
  const [variants, setVariants] = useState([]);
  const [loading, setLoading] = useState(true);
  const now = format(new Date(), 'HH:mm');

  useEffect(() => {
    setLoading(true);
    fetchCache(servicesJSONPath, 24 * 60).then((services) => {
      const route = services[routeNo];
      if (!route) { setLoading(false); return; }
      setRouteName(route.name || '');

      const entries = Object.entries(route)
        .filter(([k, v]) => k !== 'name' && Array.isArray(v) && v.length > 0)
        .map(([dest, v]) => ({ destination: dest, stops: v[0] }))
        .filter((v) => !contextStopId || v.stops.includes(contextStopId));

      Promise.all(entries.map((v) => {
        const sid = contextStopId && v.stops.includes(contextStopId) ? contextStopId : v.stops[0];
        return fetchCache(`${SCHEDULE_CDN}/${sid}.json`, 60)
          .then((d) => {
            const svc = d?.services?.find((s) => s.no === routeNo && s.destination === v.destination);
            return { ...v, scheduleStopId: sid, trips: svc?.trips || [], tripCount: svc?.trip_count || 0 };
          })
          .catch(() => ({ ...v, scheduleStopId: sid, trips: [], tripCount: 0 }));
      })).then((results) => { setVariants(results); setLoading(false); });
    });
  }, [routeNo, contextStopId]);

  return (
    <div class="route-overview-page">
      <RouteHeader routeNo={routeNo} routeName={routeName} backLabel={contextStopId ? t('timetable.backToStop') : 'Back'} />
      {loading && <div class="trip-grid-loading"><span class="placeholder">████ ████ ████ ████ ████ ████</span></div>}
      {variants.filter((v) => v.trips.length > 0).map((v) => (
        <div class="route-variant" key={v.destination}>
          <div class="variant-header">{stopName(stopsData, v.scheduleStopId)} → {stopName(stopsData, v.destination)}</div>
          <div class="trip-grid">
            {v.trips.map((time) => (
              <a
                key={time}
                class={`trip-chip${time < now ? ' past' : ''}`}
                href={buildHash('route-timetable', { stopId: v.scheduleStopId, routeNo, time, dest: v.destination })}
              >{timeFormat(time)}</a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Stop timetable (Level 1) ─────────────────────────────────

function StopTimetablePage({ stopId, stopsData, flData }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState([]);
  const [tripCounts, setTripCounts] = useState({});
  const [destinations, setDestinations] = useState({});
  const [hasSat, setHasSat] = useState(false);
  const [hasSun, setHasSun] = useState(false);
  const [timeLeft, setTimeLeft] = useState(null);
  const [timeDate, setTimeDate] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const currentStopName = stopFullName(stopsData, stopId);

  useEffect(() => {
    document.title = t('timetable.title', { stopNumber: stopId, stopName: currentStopName });
  }, [stopId, currentStopName, i18n.resolvedLanguage]);

  useEffect(() => {
    const raw = flData?.[stopId];
    if (!raw) return;

    const parsed = raw.map((d) => {
      const parts = d.split(/\s+/);
      if (parts.length < 7) return parts;
      return [parts.slice(0, -6).join(' '), ...parts.slice(-6)];
    });

    const serviceMap = new Map();
    parsed.forEach(([svc, wd1, wd2, sat1, sat2, sun1, sun2]) => {
      if (!serviceMap.has(svc)) {
        serviceMap.set(svc, [svc, wd1, wd2, sat1, sat2, sun1, sun2]);
      } else {
        const e = serviceMap.get(svc);
        const [wf, wl] = combineTimes(e[1], e[2], wd1, wd2);
        const [sf, sl] = combineTimes(e[3], e[4], sat1, sat2);
        const [uf, ul] = combineTimes(e[5], e[6], sun1, sun2);
        serviceMap.set(svc, [svc, wf, wl, sf, sl, uf, ul]);
      }
    });

    const deduped = Array.from(serviceMap.values());

    fetchCache(`${SCHEDULE_CDN}/${stopId}.json`, 60)
      .then((sched) => {
        const counts = {}, destCounts = {};
        sched.services.forEach((s) => {
          counts[s.no] = (counts[s.no] || 0) + s.trip_count;
          if (!destCounts[s.no]) destCounts[s.no] = {};
          destCounts[s.no][s.destination] = (destCounts[s.no][s.destination] || 0) + s.trip_count;
        });
        const dests = {};
        for (const [no, dc] of Object.entries(destCounts)) {
          dests[no] = [Object.entries(dc).sort((a, b) => b[1] - a[1])[0][0]];
        }
        setTripCounts(counts);
        setDestinations(dests);
        deduped.sort((a, b) => (counts[b[0]] || 0) - (counts[a[0]] || 0));
        setData([...deduped]);
      })
      .catch(() => {
        deduped.sort((a, b) => sortServices(a[0], b[0]));
        setData(deduped);
      });

    setHasSat(deduped.some((d) => hasValidTiming(d[3]) || hasValidTiming(d[4])));
    setHasSun(deduped.some((d) => hasValidTiming(d[5]) || hasValidTiming(d[6])));
  }, [stopId, flData]);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTimeDate(d);
      setTimeLeft((parseTime(format(d, 'HHmm')) / 24) * 100);
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, []);

  const isInTimezone = new Date().getTimezoneOffset() === -480;
  const hasMultiDay = hasSat || hasSun;
  const rowspan = 1 + (hasSat ? 1 : 0) + (hasSun ? 1 : 0);

  const fuse = useMemo(() => {
    if (!data.length) return null;
    return new Fuse(
      data.map((d) => ({
        service: d[0],
        dest: (destinations[d[0]] || []).map((id) => stopName(stopsData, id)).join(' '),
        row: d,
      })),
      { keys: ['service', 'dest'], threshold: 0.35 },
    );
  }, [data, destinations, stopsData]);

  const filteredData = useMemo(() => {
    if (!searchQuery || !fuse) return data;
    return fuse.search(searchQuery).map((r) => r.item.row);
  }, [searchQuery, fuse, data]);

  const renderRow = (d) => {
    const [service, wd1, wd2, sat1, sat2, sun1, sun2] = d;
    const onClick = () => navigate('route-overview', { routeNo: service, stopId });
    const count = tripCounts[service] || 0;
    const destNames = (destinations[service] || []).map((id) => stopName(stopsData, id)).join(', ');

    const dayRow = (first, last, label) => (
      <tr onClick={onClick}>
        {label && <th><abbr title={label[1]}>{label[0]}</abbr></th>}
        <td class="time-value headway">{formatHeadway(computeHeadway(count, first, last))}</td>
        <td class="time-cell"><TimeRanger values={[first, last]} /></td>
      </tr>
    );

    if (!hasMultiDay) {
      return (
        <tbody key={service}>
          <tr class="service-row" onClick={onClick}>
            <td class="service-name">{service}</td>
            <td class="dest-cell">{destNames}</td>
            <td class="time-value headway">{formatHeadway(computeHeadway(count, wd1, wd2))}</td>
            <td class="time-cell"><TimeRanger values={[wd1, wd2]} /></td>
          </tr>
        </tbody>
      );
    }

    return (
      <tbody key={service}>
        <tr class="service-row" onClick={onClick}>
          <td rowspan={rowspan} class="service-name">{service}</td>
          <th><abbr title={t('glossary.weekdays')}>{t('glossary.weekdaysShort')}</abbr></th>
          <td rowspan={rowspan} class="dest-cell">{destNames}</td>
          <td class="time-value headway">{formatHeadway(computeHeadway(count, wd1, wd2))}</td>
          <td class="time-cell"><TimeRanger values={[wd1, wd2]} /></td>
        </tr>
        {hasSat && dayRow(sat1, sat2, [t('glossary.saturdaysShort'), t('glossary.saturdays')])}
        {hasSun && dayRow(sun1, sun2, [t('glossary.sundaysPublicHolidaysShort'), t('glossary.sundaysPublicHolidays')])}
      </tbody>
    );
  };

  const renderPlaceholder = (v) => (
    <tbody key={v}>
      <tr>
        <td {... hasMultiDay ? { rowspan: rowspan } : {}}><span class="placeholder">██</span></td>
        {hasMultiDay && <th><abbr title={t('glossary.weekdays')}>{t('glossary.weekdaysShort')}</abbr></th>}
        <td {... hasMultiDay ? { rowspan: rowspan } : {}}><span class="placeholder">██████</span></td>
        <td><span class="placeholder">██</span></td>
        <td class="time-cell"><TimeRanger /></td>
      </tr>
      {hasMultiDay && hasSat && (
        <tr>
          <th><abbr title={t('glossary.saturdays')}>{t('glossary.saturdaysShort')}</abbr></th>
          <td><span class="placeholder">██</span></td>
          <td class="time-cell"><TimeRanger /></td>
        </tr>
      )}
      {hasMultiDay && hasSun && (
        <tr>
          <th><abbr title={t('glossary.sundaysPublicHolidays')}>{t('glossary.sundaysPublicHolidaysShort')}</abbr></th>
          <td><span class="placeholder">██</span></td>
          <td class="time-cell"><TimeRanger /></td>
        </tr>
      )}
    </tbody>
  );

  return (
    <div>
      <h1>
        {t('timetable.preHeading')}<br />
        <b>{currentStopName || <span class="placeholder">██████ ███</span>}</b>
      </h1>
      {hasMultiDay && (
        <p class="legend">
          <span><span class="abbr">{t('glossary.weekdaysShort')}</span> {t('glossary.weekdays')}</span>
          {hasSat && <span><span class="abbr">{t('glossary.saturdaysShort')}</span> {t('glossary.saturdays')}</span>}
          {hasSun && <span><span class="abbr">{t('glossary.sundaysPublicHolidaysShort')}</span> {t('glossary.sundaysPublicHolidays')}</span>}
        </p>
      )}
      {!!data.length && (
        <div class="timetable-search">
          <input type="text" placeholder={t('search.placeholder')} value={searchQuery} onInput={(e) => setSearchQuery(e.target.value)} />
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>{t('glossary.service')}</th>
            {hasMultiDay && <th />}
            <th>Destination</th>
            <th>Avg. Headway</th>
            <th class="timerange-header">
              <span>12</span><span>6</span><span>12</span><span>6</span>
              {isInTimezone && data.length > 0 && timeLeft != null && timeDate && (
                <div class="timerange-indicator" style={{ left: `${timeLeft}%` }}>
                  <span>{timeFormat(timeDate)}*</span>
                </div>
              )}
            </th>
          </tr>
        </thead>
        {data.length ? filteredData.map(renderRow) : [1, 2, 3].map(renderPlaceholder)}
      </table>
    </div>
  );
}

// ── Root router ───────────────────────────────────────────────

function Timetable() {
  const { t } = useTranslation();
  const [routeState, setRouteState] = useState(parseHash);
  const [stopsData, setStopsData] = useState(null);
  const [flData, setFlData] = useState(null);

  useEffect(() => {
    Promise.all([
      fetchCache(stopsJSONPath, 24 * 60),
      fetchCache(firstLastJSONPath, 24 * 60),
    ]).then(([stops, fl]) => { setStopsData(stops); setFlData(fl); });
  }, []);

  useEffect(() => {
    const onHash = () => {
      const parsed = parseHash();
      if (parsed.view === 'stop-timetable' && flData && !flData[parsed.stopId]) {
        alert(t('timetable.busStopCodeNotFound'));
        return;
      }
      setRouteState(parsed);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [flData]);

  if (!stopsData || !flData) {
    return <div><h1>{t('timetable.preHeading')}<br /><b><span class="placeholder">██████ ███</span></b></h1></div>;
  }

  const { view, stopId, routeNo, time, dest } = routeState;
  switch (view) {
    case 'trip-grid':
      return <TripGridPage stopId={stopId} routeNo={routeNo} stopsData={stopsData} />;
    case 'route-timetable':
      return <RouteTimetablePage stopId={stopId} routeNo={routeNo} selectedTime={time} dest={dest} stopsData={stopsData} />;
    case 'route-overview':
      return <RouteOverviewPage routeNo={routeNo} stopId={stopId} stopsData={stopsData} />;
    default:
      return <StopTimetablePage stopId={stopId} stopsData={stopsData} flData={flData} />;
  }
}

render(<Timetable />, document.getElementById('timetable'));
