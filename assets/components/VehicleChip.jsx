import { h } from 'preact';
import { useTranslation } from 'react-i18next';

import busTinyImagePath from '../images/bus-tiny.png';

// Load codes arrivals use, mapped to their existing glossary labels.
export const LOAD_LABEL_KEYS = {
  SEA: 'glossary.seatsAvailable',
  SDA: 'glossary.standingAvailable',
  LSD: 'glossary.limitedStanding',
};

/**
 * The orange vehicle chip (bus icon + number) shown on the route popover's
 * stop list, reused wherever a vehicle is signified. `size` scales it:
 * 'sm' (default, route stop list), 'md' (search results), 'lg' (popover header).
 * `load` (SEA/SDA/LSD), when known, adds a small circle coloured like the
 * arrivals load colours.
 */
export default function VehicleChip({ number, size = 'sm', load, ...rest }) {
  const { t } = useTranslation();
  const loadKey = LOAD_LABEL_KEYS[load];
  return (
    <span class={`vehicle-inline vehicle-inline--${size}`} {...rest}>
      <img src={busTinyImagePath} width="14" height="14" alt="Bus" />
      <span class="vehicle-inline-number">{number}</span>
      {loadKey && (
        <span
          class={`vehicle-load vehicle-load-${load.toLowerCase()}`}
          title={t(loadKey)}
          role="img"
          aria-label={t(loadKey)}
        />
      )}
    </span>
  );
}
