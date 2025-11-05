import './i18n';

import { getCurrentCity } from './config';
import { h, render, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import format from 'date-fns/format';
import _formatDuration from 'date-fns/formatDuration';
import { useTranslation } from 'react-i18next';

import fetchCache from './utils/fetchCache';
import { sortServices } from './utils/bus';

const city = getCurrentCity();
const dataPath = `/data/${city}`;
const firstLastJSONPath = `${dataPath}/firstlast.min.json`;
const stopsJSONPath = `${dataPath}/stops.min.json`;

const timeStrToDate = (time) => {
  if (time instanceof Date) return time;
  if (!/\d{4}/.test(time)) return null;
  let h = +time.slice(0, 2);
  const m = +time.slice(2);
  const d = new Date();
  d.setHours(h, m);
  return d;
};

const timeFormat = (time, language) => {
  const date = timeStrToDate(time);
  return date ? format(date, 'HH:mm') : '-';
};

const formatDuration = (duration, language) => {
  const h = duration;
  const hours = Math.floor(h);
  const minutes = Math.round((h - hours) * 60);
  return _formatDuration({ hours, minutes });
};

const convertTimeToNumber = (time) => {
  const h = parseInt(time.slice(0, 2), 10);
  const m = parseInt(time.slice(2), 10);
  return h + m / 60;
};

const TimeRanger = ({ values }) => {
  const { i18n } = useTranslation();
  const nadaEl = <div class="time-ranger nada" />;
  if (!values) return nadaEl;
  const [first, last] = values;
  if (!first || !/\d+/.test(first)) return nadaEl;
  const firstVal = convertTimeToNumber(first);
  const lastVal = convertTimeToNumber(last);
  const left = (firstVal / 24) * 100;
  const duration = (lastVal < firstVal ? lastVal + 24 : lastVal) - firstVal;
  const width = (duration / 24) * 100;
  return (
    <>
      <div class="time-ranger">
        {width + left > 100 && (
          <div
            class="bar"
            style={{
              left: 0,
              width: `${width + left - 100}%`,
            }}
          />
        )}
        <div
          class="bar"
          style={{
            left: `${left}%`,
            width: `${width}%`,
          }}
        />
      </div>
      <span class="time-duration">
        {formatDuration(duration, i18n.resolvedLanguage)}
      </span>
    </>
  );
};

function FirstLastTimes() {
  const { t, i18n } = useTranslation();
  const [stop, setStop] = useState(null);
  const [stopName, setStopName] = useState(null);
  const [data, setData] = useState([]);
  const [hasSaturdayTimings, setHasSaturdayTimings] = useState(false);
  const [hasSundayTimings, setHasSundayTimings] = useState(false);

  const [timeLeft, setTimeLeft] = useState(null);
  const [timeDate, setTimeDate] = useState(null);
  const [timeStr, setTimeStr] = useState('');

  useEffect(() => {
    if (!stop || !stopName) return;
    document.title = t('firstLast.title', {
      stopNumber: stop,
      stopName,
    });
  }, [stop, stopName, i18n.resolvedLanguage]);

  useEffect(() => {
    Promise.all([
      fetchCache(firstLastJSONPath, 24 * 60),
      fetchCache(stopsJSONPath, 24 * 60),
    ]).then(([flData, stopsData]) => {
      window.onhashchange = () => {
        const stop = location.hash.slice(1);
        const data = flData[stop];
        if (!data) {
          alert(t('firstLast.busStopCodeNotFound'));
          return;
        }

        setStop(stop);
        setStopName(stopsData[stop][2]);
        const processedData = data
          .map((d) => {
            const parts = d.split(/\s+/);
            if (parts.length < 7) {
              return parts;
            }
            const timings = parts.slice(-6); // Last 6 elements are timings
            const routeName = parts.slice(0, -6).join(' '); // Everything else is route name
            return [routeName, ...timings];
          })
          .sort((a, b) => sortServices(a[0], b[0]));

        // Combine duplicate services: take earliest first bus and latest last bus
        const serviceMap = new Map();
        processedData.forEach((serviceTimings) => {
          const [service, wd1, wd2, sat1, sat2, sun1, sun2] = serviceTimings;

          if (!serviceMap.has(service)) {
            serviceMap.set(service, [
              service,
              wd1,
              wd2,
              sat1,
              sat2,
              sun1,
              sun2,
            ]);
          } else {
            const existing = serviceMap.get(service);
            // For each day type, take earliest first and latest last
            const combineTimes = (existFirst, existLast, newFirst, newLast) => {
              // Handle special cases like '=' (same as weekday)
              if (newFirst === '=' || !newFirst || !/\d{4}/.test(newFirst)) {
                return [existFirst, existLast];
              }
              if (
                existFirst === '=' ||
                !existFirst ||
                !/\d{4}/.test(existFirst)
              ) {
                return [newFirst, newLast];
              }

              const first = Math.min(
                convertTimeToNumber(existFirst),
                convertTimeToNumber(newFirst),
              );
              const last = Math.max(
                convertTimeToNumber(existLast),
                convertTimeToNumber(newLast),
              );

              // Convert back to HHMM format
              const firstHH = Math.floor(first).toString().padStart(2, '0');
              const firstMM = Math.round((first % 1) * 60)
                .toString()
                .padStart(2, '0');
              const lastHH = Math.floor(last).toString().padStart(2, '0');
              const lastMM = Math.round((last % 1) * 60)
                .toString()
                .padStart(2, '0');

              return [`${firstHH}${firstMM}`, `${lastHH}${lastMM}`];
            };

            const [wdFirst, wdLast] = combineTimes(
              existing[1],
              existing[2],
              wd1,
              wd2,
            );
            const [satFirst, satLast] = combineTimes(
              existing[3],
              existing[4],
              sat1,
              sat2,
            );
            const [sunFirst, sunLast] = combineTimes(
              existing[5],
              existing[6],
              sun1,
              sun2,
            );

            serviceMap.set(service, [
              service,
              wdFirst,
              wdLast,
              satFirst,
              satLast,
              sunFirst,
              sunLast,
            ]);
          }
        });

        const deduplicatedData = Array.from(serviceMap.values());

        // Check if any service has Saturday or Sunday timings
        const hasValidTiming = (time) =>
          time && time !== '=' && /\d{4}/.test(time);
        const hasSat = deduplicatedData.some(
          (d) => hasValidTiming(d[3]) || hasValidTiming(d[4]),
        );
        const hasSun = deduplicatedData.some(
          (d) => hasValidTiming(d[5]) || hasValidTiming(d[6]),
        );

        setData(deduplicatedData);
        setHasSaturdayTimings(hasSat);
        setHasSundayTimings(hasSun);
      };
      window.onhashchange();
    });

    const updateTimeTick = () => {
      const date = new Date();
      setTimeDate(date);
      const val = convertTimeToNumber(format(date, 'HHmm'));
      const left = (val / 24) * 100;
      setTimeLeft(left);
    };
    updateTimeTick();
    setInterval(updateTimeTick, 60 * 1000);
  }, []);

  const formatTimeTick = (timeDate) => {
    const timeStr = timeFormat(timeDate, i18n.resolvedLanguage);
    console.log({ timeDate, timeStr });
    let timeStrComp;
    if (/:/.test(timeStr)) {
      // Make sure there's ":" before making it blink
      const [a, b] = timeStr.split(':');
      timeStrComp = (
        <>
          {a}
          <blink>:</blink>
          {b}
        </>
      );
      return timeStrComp || timeStr;
    }
    return timeStr;
  };

  const isInTimezone = new Date().getTimezoneOffset() === -480;

  return (
    <div>
      {!!data.length}
      <h1>
        {t('firstLast.preHeading')}
        <br />
        <b>
          <span class="stop-tag">{stop || '     '}</span>{' '}
          {stopName ? stopName : <span class="placeholder">██████ ███</span>}
        </b>
      </h1>
      {(hasSaturdayTimings || hasSundayTimings) && (
        <p class="legend">
          <span>
            <span class="abbr">{t('glossary.weekdaysShort')}</span>{' '}
            {t('glossary.weekdays')}
          </span>
          {hasSaturdayTimings && (
            <span>
              <span class="abbr">{t('glossary.saturdaysShort')}</span>{' '}
              {t('glossary.saturdays')}
            </span>
          )}
          {hasSundayTimings && (
            <span>
              <span class="abbr">
                {t('glossary.sundaysPublicHolidaysShort')}
              </span>{' '}
              {t('glossary.sundaysPublicHolidays')}
            </span>
          )}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>{t('glossary.service')}</th>
            {(hasSaturdayTimings || hasSundayTimings) && <th></th>}
            <th>{t('glossary.firstBus')}</th>
            <th>{t('glossary.lastBus')}</th>
            <th class="timerange-header">
              <span>12 🌚</span>
              <span>6</span>
              <span>12 🌞</span>
              <span>6</span>
              {isInTimezone && !!data.length && !!timeLeft && !!timeDate && (
                <div
                  class="timerange-indicator"
                  style={{ left: `${timeLeft}%` }}
                >
                  <span>{formatTimeTick(timeDate)}*</span>
                </div>
              )}
            </th>
          </tr>
        </thead>
        {data.length
          ? data.map((d, i) => {
              const [service, ...times] = d;
              const [wd1raw, wd2raw, sat1raw, sat2raw, sun1raw, sun2raw] =
                times;
              const [wd1, wd2, sat1, sat2, sun1, sun2] = times.map((t) =>
                timeFormat(t, i18n.resolvedLanguage),
              );

              // Calculate dynamic rowspan based on visible day types
              const rowspan =
                1 + (hasSaturdayTimings ? 1 : 0) + (hasSundayTimings ? 1 : 0);

              // If only weekday data, show simplified view
              if (!hasSaturdayTimings && !hasSundayTimings) {
                return (
                  <tbody>
                    <tr>
                      <td>{service}</td>
                      <td class="time-value" title={wd1raw}>
                        {wd1}
                      </td>
                      <td class="time-value" title={wd2raw}>
                        {wd2}
                      </td>
                      <td class="time-cell">
                        <TimeRanger values={[wd1raw, wd2raw]} />
                      </td>
                    </tr>
                  </tbody>
                );
              }

              return (
                <tbody>
                  <tr>
                    <td rowspan={rowspan}>{service}</td>
                    <th>
                      <abbr title={t('glossary.weekdays')}>
                        {t('glossary.weekdaysShort')}
                      </abbr>
                    </th>
                    <td title={wd1raw}>{wd1}</td>
                    <td title={wd2raw}>{wd2}</td>
                    <td class="time-cell">
                      <TimeRanger values={[wd1raw, wd2raw]} />
                    </td>
                  </tr>
                  {hasSaturdayTimings && (
                    <tr>
                      <th>
                        <abbr title={t('glossary.saturdays')}>
                          {t('glossary.saturdaysShort')}
                        </abbr>
                      </th>
                      <td title={sat1raw}>{sat1}</td>
                      <td title={sat2raw}>{sat2}</td>
                      <td class="time-cell">
                        <TimeRanger values={[sat1raw, sat2raw]} />
                      </td>
                    </tr>
                  )}
                  {hasSundayTimings && (
                    <tr>
                      <th>
                        <abbr title={t('glossary.sundaysPublicHolidays')}>
                          {t('glossary.sundaysPublicHolidaysShort')}
                        </abbr>
                      </th>
                      <td title={sun1raw}>{sun1}</td>
                      <td title={sun2raw}>{sun2}</td>
                      <td class="time-cell">
                        <TimeRanger values={[sun1raw, sun2raw]} />
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })
          : [1, 2, 3].map((v) => {
              const placeholderRowspan =
                1 + (hasSaturdayTimings ? 1 : 0) + (hasSundayTimings ? 1 : 0);

              // If only weekday data, show simplified placeholder
              if (!hasSaturdayTimings && !hasSundayTimings) {
                return (
                  <tbody key={v}>
                    <tr>
                      <td>
                        <span class="placeholder">██</span>
                      </td>
                      <td class="time-value">
                        <span class="placeholder">████</span>
                      </td>
                      <td class="time-value">
                        <span class="placeholder">████</span>
                      </td>
                      <td class="time-cell">
                        <TimeRanger />
                      </td>
                    </tr>
                  </tbody>
                );
              }

              return (
                <tbody key={v}>
                  <tr>
                    <td rowspan={placeholderRowspan}>
                      <span class="placeholder">██</span>
                    </td>
                    <th>
                      <abbr title={t('glossary.weekdays')}>
                        {t('glossary.weekdaysShort')}
                      </abbr>
                    </th>
                    <td>
                      <span class="placeholder">████</span>
                    </td>
                    <td>
                      <span class="placeholder">████</span>
                    </td>
                    <td class="time-cell">
                      <TimeRanger />
                    </td>
                  </tr>
                  {hasSaturdayTimings && (
                    <tr>
                      <th>
                        <abbr title={t('glossary.saturdays')}>
                          {t('glossary.saturdaysShort')}
                        </abbr>
                      </th>
                      <td>
                        <span class="placeholder">████</span>
                      </td>
                      <td>
                        <span class="placeholder">████</span>
                      </td>
                      <td class="time-cell">
                        <TimeRanger />
                      </td>
                    </tr>
                  )}
                  {hasSundayTimings && (
                    <tr>
                      <th>
                        <abbr title={t('glossary.sundaysPublicHolidays')}>
                          {t('glossary.sundaysPublicHolidaysShort')}
                        </abbr>
                      </th>
                      <td>
                        <span class="placeholder">████</span>
                      </td>
                      <td>
                        <span class="placeholder">████</span>
                      </td>
                      <td class="time-cell">
                        <TimeRanger />
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })}
        <tfoot>
          <tr>
            <td colspan={hasSaturdayTimings || hasSundayTimings ? 5 : 4}>
              <p>
                {!!data.length && (
                  <>
                    {t('glossary.nServices_plural', { count: data.length })}{' '}
                    ·{' '}
                  </>
                )}
                <a href="/">{t('app.name')}</a>
              </p>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

const $firstlast = document.getElementById('firstlast');
render(<FirstLastTimes />, $firstlast);
