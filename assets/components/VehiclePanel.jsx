import { h, Fragment } from 'preact';
import { useTranslation } from 'react-i18next';
import VehicleChip, { LOAD_LABEL_KEYS } from './VehicleChip';
import LiveDataIndicator from './LiveDataIndicator';

const formatTime = (unixSec) =>
  new Date(unixSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "10:42 ∙ 5 min" label for one stop_time entry of the vehicle response. */
export function formatStopTimeLabel(t, stop) {
  const eta =
    stop.duration_ms == null
      ? ''
      : Math.round(stop.duration_ms / 60000) <= 0
        ? t('vehicle.now')
        : t('vehicle.minutes', { count: Math.round(stop.duration_ms / 60000) });
  return eta ? `${formatTime(stop.arrivalTime)} ∙ ${eta}` : formatTime(stop.arrivalTime);
}

/**
 * What the route popover needs to show a vehicle on its stop list: the
 * vehicle in the shape StopsList already places (after the stop it last
 * passed, else before the next), plus a time label per stop. Both are empty
 * unless the source gave trip updates that match stops of this route/city.
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
    if (s.arrivalTime >= nowSec - 60) stopTimeLabels[s.stopId] = formatStopTimeLabel(t, s);
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
