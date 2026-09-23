import { h, Fragment } from 'preact';
import { useTranslation } from 'react-i18next';
import VehicleChip, { LOAD_LABEL_KEYS } from './VehicleChip';
import LiveDataIndicator from './LiveDataIndicator';

const formatTime = (unixSec) =>
  new Date(unixSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// How long a stop's time still reads as "Now", either side of it — beyond
// this it always shows the real elapsed time ("N min ago"/"N min"), never
// hidden and never silently rounded to "Now" for longer than this.
const NOW_WINDOW_SEC = 120;

/**
 * "10:42 ∙ 5 min" (upcoming), "10:42 ∙ Now" (within NOW_WINDOW_SEC either
 * way), or "10:42 ∙ 22 min ago" beyond that (the source's stop-time data is
 * stale — this feed doesn't always extend a trip's remaining stops as it
 * advances, so "no data past this point" and "running late" can't be told
 * apart here, but the actual elapsed time is still shown either way).
 * Computed from `stop.arrivalTime` directly rather than the response's own
 * `duration_ms`, which is clamped to 0 for a past time and so can't tell
 * "just now" from "long ago".
 */
export function formatStopTimeLabel(t, stop, nowMs = Date.now()) {
  if (stop.arrivalTime == null) return formatTime(stop.arrivalTime);
  const elapsedSec = nowMs / 1000 - stop.arrivalTime;
  let eta;
  if (elapsedSec > NOW_WINDOW_SEC) eta = t('vehicle.minutesAgo', { count: Math.round(elapsedSec / 60) });
  else if (elapsedSec >= -NOW_WINDOW_SEC) eta = t('vehicle.now');
  else eta = t('vehicle.minutes', { count: Math.round(-elapsedSec / 60) });
  return `${formatTime(stop.arrivalTime)} ∙ ${eta}`;
}

/**
 * What the route popover needs to show a vehicle on its stop list: the
 * vehicle in the shape StopsList already places (after the stop it last
 * passed, else before the next), plus a time label per stop. Both are empty
 * unless the source gave trip updates that match stops of this route/city.
 *
 * Every known stop gets a label (not just ones near "now") — the feed only
 * ever reports a handful of stops per trip, and one this stale, per
 * formatStopTimeLabel, is still worth showing rather than going blank.
 */
export function buildRouteVehicleView(t, info, isKnownStop, nowMs = Date.now()) {
  const nowSec = nowMs / 1000;
  const stops = (info?.stops || [])
    .filter((s) => s.arrivalTime != null && isKnownStop(s.stopId))
    .sort((a, b) => a.arrivalTime - b.arrivalTime);
  if (!stops.length) return { vehicles: [], stopTimeLabels: {} };

  const stopTimeLabels = {};
  let last = null;
  let next = null;
  for (const s of stops) {
    stopTimeLabels[s.stopId] = formatStopTimeLabel(t, s, nowMs);
    if (s.arrivalTime <= nowSec) last = s;
    else if (!next) next = s;
  }
  return {
    vehicles: [
      {
        vehicleId: info.vehicleId,
        vehicleNumber: info.vehicleNumber,
        serviceType: null,
        load: info.load,
        stops: {
          lastLocationId: last?.stopId ?? null,
          currentLocationId: null,
          nextLocationId: next?.stopId ?? null,
        },
      },
    ],
    stopTimeLabels,
  };
}

/**
 * Vehicle-specific notes shown in the popover: not-found/failed state, the
 * load (only when the source reports occupancy) and an estimated-position
 * note. With `withHeader` (no route to show) it is the whole popover
 * content, headed by the vehicle number; otherwise it sits inside the route
 * popover, whose header and stop list carry the rest.
 */
export default function VehiclePanel({ panel, withHeader }) {
  const { t } = useTranslation();
  const { info, notFound, estimated } = panel;

  if (!info) {
    return (
      <>
        <header>
          <h1>
            <VehicleChip number={panel.id} size="lg" />
          </h1>
        </header>
        <div class="popover-scroll">
          <p class="vehicle-error" role="alert">
            {notFound ? t('vehicle.notActive') : t('vehicle.loadFailed')}
          </p>
        </div>
      </>
    );
  }

  const loadKey = LOAD_LABEL_KEYS[info.load];
  const notes = (
    <>
      {loadKey && <p class="vehicle-occupancy">{t(loadKey)}</p>}
      {!info.location && estimated && (
        <p class="vehicle-estimated">{t('vehicle.estimatedPosition')}</p>
      )}
    </>
  );

  if (!withHeader) return <div class="vehicle-panel">{notes}</div>;
  return (
    <>
      <header>
        <div class="service-header-row">
          <h1>
            <VehicleChip number={info.vehicleNumber} size="lg" />
          </h1>
          <LiveDataIndicator source={info.source} />
        </div>
      </header>
      <div class="popover-scroll vehicle-panel">{notes}</div>
    </>
  );
}
