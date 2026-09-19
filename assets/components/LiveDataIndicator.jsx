import { h } from 'preact';

import { isDevMode } from '../city-config.js';

const SOURCE_TITLES = {
  'gtfs-rt': 'Live data from the GTFS-RT.',
  api: 'Live data from the API.',
};

const DEFAULT_ERROR_TITLE =
  'Live data unavailable. Estimated based on timetable schedule.';

const toggleTooltip = (e) => {
  e.stopPropagation();
  const container = e.currentTarget;
  container.classList.toggle('show-tooltip');
  const closeTooltip = (event) => {
    if (!container.contains(event.target)) {
      container.classList.remove('show-tooltip');
      document.removeEventListener('click', closeTooltip);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', closeTooltip);
  }, 0);
};

/**
 * Live data status next to a stop or service heading: a spinner while
 * fetching, a warning when live data is unavailable, and a green dot while
 * live data is flowing — filled for 'api', a ring for 'gtfs-rt', with the
 * source named on hover.
 *
 * Only the warning is for everyone: it explains why the times below are
 * estimates. Which source a working feed came from is developer-facing
 * detail, so the spinner and the dot are gated behind Developer Mode.
 */
export default function LiveDataIndicator({
  loading,
  error,
  source,
  errorTitle = DEFAULT_ERROR_TITLE,
}) {
  const sourceTitle =
    !loading && !error && source ? SOURCE_TITLES[source] : null;
  if (!error && (!isDevMode() || (!loading && !sourceTitle))) return null;

  return (
    <span
      class={`live-data-loading-container ${error ? 'error' : ''}`}
      title={
        error ? errorTitle : loading ? 'Fetching live information' : sourceTitle
      }
      onClick={toggleTooltip}
    >
      {error ? (
        <span class="live-data-warning">⚠</span>
      ) : loading ? (
        <span class="live-data-loading" />
      ) : (
        <span class={`live-data-source live-data-source-${source}`} />
      )}
    </span>
  );
}
