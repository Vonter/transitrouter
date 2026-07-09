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

function getServiceArrivalInfo(arrivalData, serviceNo) {
  if (!arrivalData?.length) return null;
  const service = arrivalData.find((s) => String(s.no) === String(serviceNo));
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

function calculateScore(result, arrivalData, staticFrequency) {
  const { stopsBetween, endService, startService, _nearbyStart } = result;
  const interchangeScore = endService ? 0 : 10000;
  const stopsScore = 1000 / (stopsBetween.length + 1);

  let arrivalTimeScore = 0;
  let frequencyScore = 0;
  const hasData = arrivalData?.length > 0;

  if (!_nearbyStart && startService && hasData) {
    const info = getServiceArrivalInfo(arrivalData, startService);
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

  const available = getAvailableServices(arrivalData);
  const filtered =
    available.size > 0
      ? results.filter(
          (r) => r.startService && available.has(String(r.startService)),
        )
      : results;

  const scored = filtered
    .map((result) => ({
      result,
      score: calculateScore(result, arrivalData, staticFrequency),
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

function RouteItem({ result, stopsData, onClickRoute }) {
  const { startStop, endStop, startService, endService, stopsBetween } = result;
  const { _nearbyStart, _nearbyEnd } = result;

  const getStopName = (stopNumber) =>
    stopsData?.[stopNumber]?.name || stopNumber;

  const startName = startStop?.name || startStop?.number;
  const endName = endStop?.name || endStop?.number;
  const isDirect = !endService;
  const interchangeCount = stopsBetween.length;

  const classes = [
    'between-item',
    _nearbyStart && 'nearby-start',
    _nearbyEnd && 'nearby-end',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div class={classes} onClick={(e) => onClickRoute(e, result)}>
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
                ? getStopName(stopsBetween[0])
                : `${interchangeCount} stops`)}
          </span>
          <span class="end">{endName}</span>
        </div>
      </div>
    </div>
  );
}

function getCityName(cityCode) {
  return getConfigForCity(cityCode)?.city?.name || cityCode;
}

function ItineraryItem({ itinerary, cityDataMap, onClickRoute }) {
  const [startCity, startStopNumber] = itinerary.startId.split('^');
  const legs = itinerary.legs;
  const cities = new Set([startCity, ...legs.map((leg) => leg.to.split('^')[0])]);
  const isMultiCity = cities.size > 1;

  const getStopName = (cityCode, stopNumber) =>
    cityDataMap?.get(cityCode)?.stopsData?.[stopNumber]?.name || stopNumber;

  const rides = legs.filter((leg) => leg.kind === 'ride');
  const isDirect = rides.length <= 1;
  const startService = rides[0]?.service;
  const endService = isDirect ? null : rides[rides.length - 1]?.service;

  const nearbyStart = legs.length > 1 && legs[0].kind === 'walk';
  const nearbyEnd = legs.length > 1 && legs[legs.length - 1].kind === 'walk';

  const [startCityId, startStopId] = nearbyStart
    ? legs[0].to.split('^')
    : [startCity, startStopNumber];
  const startName = getStopName(startCityId, startStopId);

  const lastLeg = legs[legs.length - 1];
  const [endCityId, endStopId] = lastLeg.to.split('^');
  const endName = getStopName(endCityId, endStopId);

  const interchangeStops = legs
    .slice(nearbyStart ? 1 : 0, -1)
    .map((leg) => leg.to);
  const interchangeCount = interchangeStops.length;

  const classes = [
    'between-item',
    nearbyStart && 'nearby-start',
    nearbyEnd && 'nearby-end',
  ]
    .filter(Boolean)
    .join(' ');

  const visitedCities = [
    ...new Set([startCity, ...legs.map((leg) => leg.to.split('^')[0])]),
  ];

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
                ? getStopName(...interchangeStops[0].split('^'))
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

// Normalizes a RAPTOR itinerary's legs into a stop/segment timeline for
// `ItineraryDetail`. Board/alight times come straight from the search
// (epoch-minutes) — `realBoardTime` (a real per-day schedule lookup done by
// `refineWithSchedule`) is preferred over the estimated `boardTime` when present.
function buildRaptorSteps(itinerary, cityDataMap) {
  const stopAt = (globalId) => {
    const [city, number] = globalId.split('^');
    return { name: cityDataMap?.get(city)?.stopsData?.[number]?.name || number, city, number };
  };

  const stopIds = [itinerary.startId, ...itinerary.legs.map((l) => l.to)];
  const stops = stopIds.map((id, i) => {
    const incoming = itinerary.legs[i - 1];
    const outgoing = itinerary.legs[i];
    return {
      ...stopAt(id),
      isStart: i === 0,
      isEnd: i === stopIds.length - 1,
      arrive: incoming?.kind === 'ride' ? formatEpochMinutes(incoming.alightTime) : null,
      depart: outgoing?.kind === 'ride' ? formatBoardTime(outgoing) : null,
    };
  });

  const segments = itinerary.legs.map((leg) => ({
    kind: leg.kind,
    service: leg.service,
    city: leg.fromStop?.split('^')[0],
    walkMinutes: leg.kind === 'walk' ? formatWalkMinutes(leg.distanceMeters) : null,
    alternates: leg.alternates || null,
  }));

  return { stops, segments };
}

// Normalizes a single-transfer city-scoped `result` (RouteItem's data shape)
// into the same {stops, segments} timeline shape. `stopsBetween` is only a
// set of *candidate* interchange stops (routes' common stops), not a
// resolved single transfer point — the first candidate is shown as
// representative, with the rest noted as additional possibilities.
function buildLegacySteps(result, userStartStop, userEndStop, getStopName) {
  const stops = [];
  const segments = [];
  const nameOf = (stop) => stop?.name || getStopName(stop?.number) || stop?.number;

  stops.push({ number: userStartStop.number, name: nameOf(userStartStop), isStart: true });

  if (result._nearbyStart && String(result.startStop?.number) !== String(userStartStop.number)) {
    segments.push({ kind: 'walk' });
    stops.push({ number: result.startStop.number, name: nameOf(result.startStop) });
  }

  segments.push({ kind: 'ride', service: result.startService });

  if (result.endService) {
    const transferNumber = result.stopsBetween?.[0];
    stops.push({
      number: transferNumber,
      name: getStopName(transferNumber),
      extra: result.stopsBetween.length > 1 ? `+${result.stopsBetween.length - 1} more possible transfer stop(s)` : null,
    });
    segments.push({ kind: 'ride', service: result.endService });
  }

  const endIsFinal = !(result._nearbyEnd && String(result.endStop?.number) !== String(userEndStop.number));
  stops.push({ number: result.endStop.number, name: nameOf(result.endStop), isEnd: endIsFinal });

  if (!endIsFinal) {
    segments.push({ kind: 'walk' });
    stops.push({ number: userEndStop.number, name: nameOf(userEndStop), isEnd: true });
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
}) {
  const sortedResults = useMemo(
    () => sortAndFilterResults(results || [], arrivalData, staticFrequency),
    [results, arrivalData, staticFrequency],
  );

  if (itineraries) {
    if (!itineraries.length) {
      return (
        <div class="between-block between-nada">No route found.</div>
      );
    }

    if (selectedIndex != null && itineraries[selectedIndex]) {
      const { stops, segments } = buildRaptorSteps(itineraries[selectedIndex], cityDataMap);
      return <ItineraryDetail stops={stops} segments={segments} getServiceHref={getServiceHref} />;
    }

    return (
      <div class="between-block">
        {itineraries.map((itinerary, i) => (
          <ItineraryItem
            key={i}
            itinerary={itinerary}
            cityDataMap={cityDataMap}
            onClickRoute={(e) => onClickRoute(e, itinerary, i)}
          />
        ))}
      </div>
    );
  }

  if (!sortedResults.length) {
    return (
      <div class="between-block between-nada">
        No upcoming connecting routes
      </div>
    );
  }

  if (selectedIndex != null && sortedResults[selectedIndex]) {
    const getStopName = (stopNumber) => stopsData?.[stopNumber]?.name || stopNumber;
    const { stops, segments } = buildLegacySteps(
      sortedResults[selectedIndex],
      startStop,
      endStop,
      getStopName,
    );
    return <ItineraryDetail stops={stops} segments={segments} getServiceHref={getServiceHref} />;
  }

  return (
    <div class="between-block">
      {sortedResults.map((result, i) => (
        <RouteItem
          result={result}
          stopsData={stopsData}
          onClickRoute={(e) => onClickRoute(e, result, i)}
        />
      ))}
    </div>
  );
}
