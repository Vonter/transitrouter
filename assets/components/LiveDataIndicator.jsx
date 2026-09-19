import { h } from 'preact';

const SOURCE_TITLES = {
  'gtfs-rt': 'Live data from the GTFS-RT.',
  api: 'Live data from the API.',
};

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
 * Live data status next to a stop heading: a spinner while fetching, a warning
 * when live data is unavailable, and a green dot while live ETAs are flowing —
 * filled for 'api', a ring for 'gtfs-rt', with the source named on hover.
 */
export default function LiveDataIndicator({ loading, error, source }) {
  const sourceTitle =
    !loading && !error && source ? SOURCE_TITLES[source] : null;
  if (!loading && !error && !sourceTitle) return null;

  return (
    <span
      class={`live-data-loading-container ${error ? 'error' : ''}`}
      title={
        error
          ? 'Live data unavailable. Estimated based on timetable schedule.'
          : loading
            ? 'Fetching live information'
            : sourceTitle
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
