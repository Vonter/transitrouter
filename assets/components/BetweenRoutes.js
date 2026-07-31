import { h, Fragment } from 'preact';
import { useMemo } from 'preact/hooks';
import { getConfigForCity } from '../city-config';
import { isDark } from '../utils/theme';

const ONE_HOUR_MS = 60 * 60 * 1000;
// Mirrors raptor.js's WALK_SPEED_MPS — used only to *display* an estimated
// walk duration; the search itself already baked the real figure into
// alightTime, which isn't carried on the leg as a bare duration.
const WALK_SPEED_MPS = 1.1;

// Same start/end pair the between-popover list already uses for its
// start(red)→end(purple) gradient (see #between-popover .between-stops in
// app.css) — reused here so the detail timeline reads as the same visual
// language rather than introducing a new accent color.
const TIMELINE_START_COLOR = isDark ? '#ff4d6d' : '#f01b48';
const TIMELINE_END_COLOR = isDark ? '#b967ff' : '#972ffe';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const START_RGB = hexToRgb(TIMELINE_START_COLOR);
const END_RGB = hexToRgb(TIMELINE_END_COLOR);
function timelineColor(t) {
  const r = Math.round(START_RGB.r + (END_RGB.r - START_RGB.r) * t);
  const g = Math.round(START_RGB.g + (END_RGB.g - START_RGB.g) * t);
  const b = Math.round(START_RGB.b + (END_RGB.b - START_RGB.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

// Day offset relative to today, e.g. a 01:30 departure for a trip that
// starts tonight is "+1d" — riders need this since RAPTOR itineraries can
// span midnight.
function dayOffsetSuffix(epochMinutes) {
  const d = new Date(epochMinutes * 60000);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const offset = Math.round((dayStart - todayStart) / 86400000);
  if (offset === 0) return '';
  return ` (${offset > 0 ? '+' : ''}${offset}d)`;
}

function formatEpochMinutes(mins) {
  if (typeof mins !== 'number' || Number.isNaN(mins)) return null;
  const d = new Date(mins * 60000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}${dayOffsetSuffix(mins)}`;
}

// `realBoardTime` (from refineWithSchedule) is a bare "HH:MM" string with no
// date attached, so the day offset is derived from the estimated `boardTime`
// epoch instead — the clock reading is real, the day label is approximate.
function formatBoardTime(leg) {
  if (leg.realBoardTime) return `${leg.realBoardTime}${dayOffsetSuffix(leg.boardTime)}`;
  return formatEpochMinutes(leg.boardTime);
}

function formatWalkMinutes(distanceMeters) {
  if (!distanceMeters) return null;
  return Math.max(1, Math.round(distanceMeters / WALK_SPEED_MPS / 60));
}

// A location endpoint has no graph-precomputed distance to any given stop
// (unlike stop-to-stop transfers/clusters, which are Voronoi-derived at
// build time) — its walk leg is computed on the fly from real coordinates.
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// stop.coordinates is [lng, lat] (see app.js's stopsData/cityDataMap).
function locationToStopMeters(location, stop) {
  if (!location || !stop?.coordinates) return null;
  const [lng, lat] = stop.coordinates;
  return haversineMeters(location.lat, location.lon, lat, lng);
}

// Total door-to-door minutes for a RAPTOR itinerary, including a location
// endpoint's walk to/from its nearest stop (not captured by the search
// itself — every candidate cluster stop is seeded at the same start time,
// so RAPTOR's own timing never includes "walk from the actual point to
// whichever stop was used"). Only itineraries carry real board/alight times
// (epoch-minutes) — legacy single-city itineraries have no timing data at
// all, just a topological route match, so there's no reliable basis to show
// a duration for those.
function computeItineraryDurationMinutes(itinerary, cityDataMap, startLocation, endLocation) {
  const legs = itinerary?.legs;
  if (!legs?.length) return null;
  const first = legs[0];
  const last = legs[legs.length - 1];
  if (typeof last.alightTime !== 'number') return null;
  let startTime;
  if (first.kind === 'ride' && typeof first.boardTime === 'number') {
    startTime = first.boardTime;
  } else if (first.kind === 'walk' && typeof first.alightTime === 'number') {
    startTime = first.alightTime - (formatWalkMinutes(first.distanceMeters) || 0);
  } else {
    return null;
  }
  let totalMinutes = last.alightTime - startTime;

  if (startLocation) {
    const [startCity, startStopNum] = itinerary.startId.split('^');
    const firstStop = cityDataMap?.get(startCity)?.stopsData?.[startStopNum];
    totalMinutes += formatWalkMinutes(locationToStopMeters(startLocation, firstStop)) || 0;
  }
  if (endLocation) {
    const [endCity, endStopNum] = last.to.split('^');
    const lastStop = cityDataMap?.get(endCity)?.stopsData?.[endStopNum];
    totalMinutes += formatWalkMinutes(locationToStopMeters(endLocation, lastStop)) || 0;
  }
  return totalMinutes;
}

function formatDuration(minutes) {
  if (typeof minutes !== 'number' || Number.isNaN(minutes) || minutes < 0) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h}h ${m}m`;
}

function getArrivals(service) {
  return (
    service.arrivals ||
    [
      service.next,
      service.next2,
      service.next3,
      service.next4,
      service.next5,
    ].filter(Boolean)
  );
}

function getAvailableServices(arrivalData) {
  if (!arrivalData?.length) return new Set();
  const services = new Set();
  for (const service of arrivalData) {
    if (!service?.no) continue;
    const hasUpcoming = getArrivals(service).some(
      (a) =>
        a &&
        typeof a.duration_ms === 'number' &&
        a.duration_ms >= 0 &&
        a.duration_ms <= ONE_HOUR_MS,
    );
    if (hasUpcoming) services.add(String(service.no));
  }
  return services;
}

function getServiceArrivalInfo(arrivalByService, serviceNo) {
  if (!arrivalByService?.size) return null;
  const service = arrivalByService.get(String(serviceNo));
  if (!service) return null;

  const arrivals = getArrivals(service);
  const earliest = arrivals.reduce((best, a) => {
    if (!a || typeof a.duration_ms !== 'number') return best;
    if (!best || a.duration_ms < best.duration_ms) return a;
    return best;
  }, null);

  return {
    earliestMs: earliest?.duration_ms ?? null,
    frequency: service.frequency || arrivals.length || 0,
  };
}

function calculateScore(itinerary, arrivalByService, staticFrequency) {
  const rideLegs = itinerary.legs.filter((leg) => leg.kind === 'ride');
  const startService = rideLegs[0]?.service;
  const isDirect = rideLegs.length <= 1;
  // stopsBetween.length equivalent — candidate transfer stops riding along on
  // the first ride leg (see dataWorker.js's handleBetweenRoutes); always 0 for
  // a direct itinerary or a RAPTOR one (which never sets transferCandidates).
  const transferCandidateCount = itinerary.legs[0]?.transferCandidates?.length || 0;
  const interchangeScore = isDirect ? 10000 : 0;
  const stopsScore = 1000 / (transferCandidateCount + 1);

  let arrivalTimeScore = 0;
  let frequencyScore = 0;
  const hasData = arrivalByService?.size > 0;

  if (!itinerary._nearbyStart && startService && hasData) {
    const info = getServiceArrivalInfo(arrivalByService, startService);
    if (info) {
      if (info.earliestMs !== null && info.earliestMs >= 0) {
        arrivalTimeScore = 100 / (info.earliestMs / 60000 + 1);
      }
      frequencyScore = Math.min(250, 100 * info.frequency);
    }
  }

  if (arrivalTimeScore > 0)
    return interchangeScore + stopsScore + arrivalTimeScore + frequencyScore;
  if (frequencyScore > 0) return interchangeScore + stopsScore + frequencyScore;

  const staticTrips = startService && staticFrequency?.[startService];
  if (staticTrips > 0) {
    const staticScore = Math.min(250, staticTrips);
    return interchangeScore + stopsScore + staticScore;
  }

  return hasData ? 0 : interchangeScore + stopsScore;
}

export function sortAndFilterResults(results, arrivalData, staticFrequency) {
  if (!results.length) return [];

  const startServiceOf = (itinerary) =>
    itinerary.legs.find((leg) => leg.kind === 'ride')?.service;

  const available = getAvailableServices(arrivalData);
  const filtered =
    available.size > 0
      ? results.filter((r) => {
          const s = startServiceOf(r);
          return s && available.has(String(s));
        })
      : results;

  const arrivalByService = new Map(
    (arrivalData || []).map((s) => [String(s.no), s]),
  );
  const scored = filtered
    .map((result) => ({
      result,
      score: calculateScore(result, arrivalByService, staticFrequency),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  if (!scored.length) return [];
  const topScore = scored[0].score;
  const threshold = topScore * 0.25;

  return scored
    .filter((item) => item.score >= threshold)
    .map((item) => item.result);
}

function getCityName(cityCode) {
  return getConfigForCity(cityCode)?.city?.name || cityCode;
}

// Shared between legacy (single-city, no timing) and RAPTOR (cross-city,
// timed) itineraries — both now use the same {startId, legs} shape (see
// dataWorker.js's handleBetweenRoutes). `resolveStop(id)` is the one thing
// that differs by mode: legacy ids are bare stop numbers looked up in
// `stopsData`; RAPTOR ids are `city^number` looked up via `cityDataMap`. A
// legacy itinerary's `_nearbyStart`/`_nearbyEnd` flags stand in for a real
// leading/trailing walk leg, which the worker never materializes (unlike
// RAPTOR, whose own search already produces one when needed).
function ItineraryItem({ itinerary, resolveStop, startLocation, endLocation, onClickRoute }) {
  const legs = itinerary.legs;
  const rides = legs.filter((leg) => leg.kind === 'ride');
  const isDirect = rides.length <= 1;
  const startService = rides[0]?.service;
  const endService = isDirect ? null : rides[rides.length - 1]?.service;

  const hasLeadingWalk = legs[0]?.kind === 'walk';
  const nearbyStart = hasLeadingWalk || itinerary._nearbyStart === true;
  const nearbyEnd =
    (legs.length > 1 && legs[legs.length - 1].kind === 'walk') ||
    itinerary._nearbyEnd === true;

  const startId = hasLeadingWalk ? legs[0].to : itinerary.startId;
  const startName = resolveStop(startId)?.name || startId;

  const lastLeg = legs[legs.length - 1];
  const endName = resolveStop(lastLeg.to)?.name || lastLeg.to;

  const interchangeStops = legs.slice(hasLeadingWalk ? 1 : 0, -1).map((leg) => leg.to);
  const interchangeCount = interchangeStops.length;

  // A location endpoint never produces a leading/trailing walk *leg* (every
  // candidate cluster stop is seeded equally, see computeRaptorRoute), so it
  // needs its own flag alongside nearbyStart/nearbyEnd for the same "you'll
  // need to walk" visual treatment.
  const classes = [
    'between-item',
    (nearbyStart || startLocation) && 'nearby-start',
    (nearbyEnd || endLocation) && 'nearby-end',
  ]
    .filter(Boolean)
    .join(' ');

  const visitedCities = [
    ...new Set([
      resolveStop(itinerary.startId)?.city,
      ...legs.map((leg) => resolveStop(leg.to)?.city),
    ]),
  ].filter(Boolean);
  const isMultiCity = visitedCities.length > 1;

  return (
    <div class={classes} onClick={(e) => onClickRoute(e, itinerary)}>
      <div class="between-inner">
        <div class={`between-services ${isDirect ? 'full' : ''}`}>
          <span class="start">{startService}</span>
          {!isDirect && <span class="end">{endService}</span>}
        </div>
        <div class={`between-stops ${interchangeCount ? '' : 'nada'}`}>
          <span class="start">{startName}</span>
          <span
            class={`betweens betweens-${Math.min(6, interchangeCount)}`}
          >
            {interchangeCount > 0 &&
              (interchangeCount === 1
                ? resolveStop(interchangeStops[0])?.name
                : `${interchangeCount} stops`)}
          </span>
          <span class="end">{endName}</span>
        </div>
      </div>
      {isMultiCity && (
        <div class="between-item-leg-city">
          via {visitedCities.map((c) => getCityName(c)).join(' · ')}
        </div>
      )}
    </div>
  );
}

// Normalizes an itinerary's legs into a stop/segment timeline for
// `ItineraryDetail` — shared by both RAPTOR itineraries (real board/alight
// times, cross-city, own walk legs already baked in by the search) and
// legacy single-city results (no timing, single-city, a leading/trailing
// walk only ever implied by `_nearbyStart`/`_nearbyEnd` since the worker
// never materializes a real walk leg — `literalStartStop`/`literalEndStop`
// exist purely to let this fall-back walk annotation compare against the
// stop the user actually picked; RAPTOR callers never pass them, since a
// walk leg already exists in `legs` whenever one applies).
function buildSteps(itinerary, { resolveStop, startLocation, endLocation, literalStartStop, literalEndStop }) {
  const nameOf = (stop) => stop?.name || resolveStop(stop?.number)?.name || stop?.number;

  const stopIds = [itinerary.startId, ...itinerary.legs.map((l) => l.to)];
  const stops = stopIds.map((id, i) => {
    const incoming = itinerary.legs[i - 1];
    const outgoing = itinerary.legs[i];
    return {
      ...resolveStop(id),
      isStart: i === 0 && !startLocation,
      isEnd: i === stopIds.length - 1 && !endLocation,
      arrive: incoming?.kind === 'ride' ? formatEpochMinutes(incoming.alightTime) : null,
      depart: outgoing?.kind === 'ride' ? formatBoardTime(outgoing) : null,
      extra:
        incoming?.transferCandidates?.length > 1
          ? `+${incoming.transferCandidates.length - 1} more possible transfer stop(s)`
          : null,
    };
  });

  const segments = itinerary.legs.map((leg) => ({
    kind: leg.kind,
    service: leg.service,
    city: leg.fromStop?.split('^')[0],
    walkMinutes: leg.kind === 'walk' ? formatWalkMinutes(leg.distanceMeters) : null,
    alternates: leg.alternates || null,
  }));

  // A location endpoint never produces a real leading/trailing walk leg
  // (every candidate cluster stop is seeded equally) — add one here purely
  // for display, from the actual searched point to whichever stop the
  // itinerary boarded/alighted at.
  if (startLocation) {
    const firstStop = resolveStop(itinerary.startId);
    stops.unshift({ name: startLocation.name || 'Selected Location', isStart: true, isLocation: true });
    segments.unshift({ kind: 'walk', walkMinutes: formatWalkMinutes(locationToStopMeters(startLocation, firstStop)) });
  } else if (literalStartStop && String(itinerary.startId) !== String(literalStartStop.number)) {
    stops[0].isStart = false;
    stops.unshift({ number: literalStartStop.number, name: nameOf(literalStartStop), isStart: true });
    segments.unshift({ kind: 'walk' });
  }

  const lastLegTo = itinerary.legs[itinerary.legs.length - 1].to;
  if (endLocation) {
    const lastStop = resolveStop(lastLegTo);
    stops[stops.length - 1].isEnd = false;
    segments.push({ kind: 'walk', walkMinutes: formatWalkMinutes(locationToStopMeters(endLocation, lastStop)) });
    stops.push({ name: endLocation.name || 'Selected Location', isEnd: true, isLocation: true });
  } else if (literalEndStop && String(lastLegTo) !== String(literalEndStop.number)) {
    stops[stops.length - 1].isEnd = false;
    segments.push({ kind: 'walk' });
    stops.push({ number: literalEndStop.number, name: nameOf(literalEndStop), isEnd: true });
  }

  return { stops, segments };
}

function oxfordJoin(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return items.join(' or ');
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

// "Alternatively at 14:00, 14:05, or 210-ND at 14:10" — groups a leg's
// alternates by route number: the *same* service as the one actually ridden
// is shown as bare times (no need to repeat its name, since it's already the
// service shown for this leg), while any genuinely different service gets
// its own name attached, with its own times comma-grouped together rather
// than repeating the service name per departure.
function formatAlternatesText(mainService, alternates) {
  if (!alternates?.length) return null;

  const ownTimes = [];
  const otherTimesByService = new Map();
  alternates.forEach(({ service, time }) => {
    if (service === mainService) {
      ownTimes.push(time);
      return;
    }
    if (!otherTimesByService.has(service)) otherTimesByService.set(service, []);
    otherTimesByService.get(service).push(time);
  });

  const items = [...ownTimes];
  for (const [service, times] of otherTimesByService) {
    items.push(`${service} at ${times.join(', ')}`);
  }
  if (!items.length) return null;

  const prefix = ownTimes.length ? 'Alternatively at ' : 'Alternatively, ';
  return prefix + oxfordJoin(items);
}

function ItineraryDetail({ stops, segments, getServiceHref }) {
  const n = stops.length;
  return (
    <div class="itinerary-detail">
      <div class="itinerary-timeline">
        {stops.map((stop, i) => {
          const color = timelineColor(n > 1 ? i / (n - 1) : 0);
          return (
            <Fragment key={i}>
              <div class="itin-stop-row">
                <div class="itin-rail">
                  <span class="itin-dot" style={{ borderColor: color }} />
                </div>
                <div class="itin-stop-info">
                  <span class="itin-stop-name">{stop.name}</span>
                  {stop.extra && <span class="itin-stop-extra">{stop.extra}</span>}
                  {stop.arrive && (
                    <span class="itin-time arrive">Arrive {stop.arrive}</span>
                  )}
                  {stop.depart && (
                    <span class="itin-time depart">Depart {stop.depart}</span>
                  )}
                </div>
              </div>
              {segments[i] && (
                <div class={`itin-seg-row ${segments[i].kind}`}>
                  <div class="itin-rail">
                    <span
                      class="itin-line"
                      style={
                        segments[i].kind === 'walk'
                          ? { borderLeftColor: timelineColor((i + 0.5) / (n - 1)) }
                          : { backgroundColor: timelineColor((i + 0.5) / (n - 1)) }
                      }
                    />
                  </div>
                  <div class="itin-seg-info">
                    {segments[i].kind === 'ride' ? (
                      <a
                        class="service-tag"
                        href={getServiceHref?.(segments[i].service, segments[i].city)}
                      >
                        {segments[i].service}
                      </a>
                    ) : (
                      <span class="itin-walk-label">
                        Walk{segments[i].walkMinutes ? ` · ${segments[i].walkMinutes} min` : ''}
                      </span>
                    )}
                    {segments[i].alternates?.length > 0 && (
                      <span class="itin-seg-alternates">
                        {formatAlternatesText(segments[i].service, segments[i].alternates)}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

export default function BetweenRoutes({
  results,
  itineraries,
  onClickRoute,
  stopsData,
  cityDataMap,
  arrivalData,
  staticFrequency,
  selectedIndex,
  getServiceHref,
  startStop,
  endStop,
  startLocation,
  endLocation,
}) {
  const isAllMode = !!itineraries;

  // Legacy results still need scoring/filtering (no arrival-aware ranking
  // happens before they reach here); RAPTOR itineraries arrive pre-sorted by
  // the search itself.
  const sortedResults = useMemo(
    () => (isAllMode ? itineraries : sortAndFilterResults(results || [], arrivalData, staticFrequency)),
    [isAllMode, itineraries, results, arrivalData, staticFrequency],
  );

  // `city^number` (RAPTOR) vs bare stop number (legacy, single-city) — see
  // dataWorker.js's handleBetweenRoutes and raptor.js for where each side of
  // this shape originates.
  const resolveStop = isAllMode
    ? (id) => {
        const [city, number] = String(id).split('^');
        const s = cityDataMap?.get(city)?.stopsData?.[number];
        return { name: s?.name || number, coordinates: s?.coordinates, city, number };
      }
    : (id) => {
        const s = stopsData?.[id];
        return { name: s?.name || id, coordinates: s?.coordinates, city: undefined, number: id };
      };

  if (!sortedResults.length) {
    return (
      <div class="between-block between-nada">
        {isAllMode ? 'No route found.' : 'No upcoming connecting routes'}
      </div>
    );
  }

  if (selectedIndex != null && sortedResults[selectedIndex]) {
    const { stops, segments } = buildSteps(sortedResults[selectedIndex], {
      resolveStop,
      startLocation,
      endLocation,
      literalStartStop: isAllMode ? undefined : startStop,
      literalEndStop: isAllMode ? undefined : endStop,
    });
    return <ItineraryDetail stops={stops} segments={segments} getServiceHref={getServiceHref} />;
  }

  return (
    <div class="between-block">
      {sortedResults.map((itinerary, i) => (
        <ItineraryItem
          key={i}
          itinerary={itinerary}
          resolveStop={resolveStop}
          startLocation={startLocation}
          endLocation={endLocation}
          onClickRoute={(e) => onClickRoute(e, itinerary, i)}
        />
      ))}
    </div>
  );
}
