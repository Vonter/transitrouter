import { h } from 'preact';
import { useMemo } from 'preact/hooks';

const ONE_HOUR_MS = 60 * 60 * 1000;

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

function sortAndFilterResults(results, arrivalData, staticFrequency) {
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

export default function BetweenRoutes({ results, onClickRoute, stopsData, arrivalData, staticFrequency }) {
  const sortedResults = useMemo(
    () => sortAndFilterResults(results, arrivalData, staticFrequency),
    [results, arrivalData, staticFrequency],
  );

  if (!sortedResults.length) {
    return (
      <div class="between-block between-nada">
        No upcoming connecting routes
      </div>
    );
  }

  return (
    <div class="between-block">
      {sortedResults.map((result) => (
        <RouteItem
          result={result}
          stopsData={stopsData}
          onClickRoute={onClickRoute}
        />
      ))}
    </div>
  );
}
