import { h } from 'preact';
import { useMemo } from 'preact/hooks';

export default function BetweenRoutes(props) {
  const { results, onClickRoute, stopsData, arrivalData, liveApiFailed } =
    props;

  // Helper to get stop name from stop number
  const getStopName = (stopNumber) => {
    if (!stopNumber || !stopsData) return stopNumber;
    const stop = stopsData[stopNumber];
    return stop?.name || stopNumber;
  };

  // Extract available services from arrivalData (from arrivals API or schedules)
  const getAvailableServices = () => {
    if (!arrivalData || !Array.isArray(arrivalData)) return new Set();

    const ONE_HOUR_MS = 60 * 60 * 1000;
    const availableServices = new Set();

    arrivalData.forEach((service) => {
      if (!service || !service.no) return;

      // Check all available arrivals (next, next2, next3, or arrivals array)
      const arrivals =
        service.arrivals ||
        [service.next, service.next2, service.next3].filter(Boolean);

      // Check if any arrival is within the next hour
      const hasArrivalInNextHour = arrivals.some(
        (arrival) =>
          arrival &&
          typeof arrival.duration_ms === 'number' &&
          arrival.duration_ms >= 0 &&
          arrival.duration_ms <= ONE_HOUR_MS,
      );

      if (hasArrivalInNextHour) {
        availableServices.add(String(service.no));
      }
    });

    return availableServices;
  };

  // Helper to get earliest arrival time for a service
  const getEarliestArrivalTime = (serviceNo) => {
    if (!arrivalData || !Array.isArray(arrivalData)) return null;

    const service = arrivalData.find((s) => String(s.no) === String(serviceNo));
    if (!service) return null;

    // Check arrivals array or next/next2/next3
    const arrivals =
      service.arrivals ||
      [service.next, service.next2, service.next3].filter(Boolean);

    if (!arrivals.length) return null;

    // Find the earliest arrival (smallest duration_ms)
    const earliest = arrivals.reduce((earliest, arrival) => {
      if (!arrival || typeof arrival.duration_ms !== 'number') return earliest;
      if (!earliest) return arrival;
      return arrival.duration_ms < earliest.duration_ms ? arrival : earliest;
    }, null);

    return earliest ? earliest.duration_ms : null;
  };

  // Calculate score for a route result
  // Higher score = better route
  const calculateScore = (result) => {
    const { stopsBetween, endService, startService, _nearbyStart } = result;

    // Interchange score: Direct routes (no endService) get high score
    // Routes with interchanges get lower score
    const interchangeScore = endService ? 0 : 10000;

    // Stops score: Fewer stops = higher score
    // Formula: 1000 / (stopsBetween.length + 1)
    // This gives: 0 stops = 1000, 1 stop = 500, 2 stops = 333, etc.
    const stopsScore = 1000 / (stopsBetween.length + 1);

    // Arrival time score: Closer arrivals = higher score
    // Only apply if we have arrival data and this is not a nearby start stop
    let arrivalTimeScore = 0;
    if (arrivalData && !_nearbyStart && startService) {
      const earliestArrivalMs = getEarliestArrivalTime(startService);
      if (earliestArrivalMs !== null && earliestArrivalMs >= 0) {
        // Convert milliseconds to minutes
        const arrivalMinutes = earliestArrivalMs / (60 * 1000);
        // Score: 100 / (arrivalMinutes + 1)
        // This gives: 0 min = 100, 1 min = 50, 5 min = 16.67, 10 min = 9.09, etc.
        arrivalTimeScore = 100 / (arrivalMinutes + 1);
      }
    }

    // If arrivalTimeScore is 0, set totalScore to 0
    const totalScore =
      arrivalTimeScore === 0
        ? 0
        : interchangeScore + stopsScore + arrivalTimeScore;

    return {
      totalScore,
      breakdown: {
        interchangeScore,
        stopsScore,
        arrivalTimeScore,
      },
    };
  };

  // Sort and limit results
  const sortedResults = useMemo(() => {
    if (!results.length) return [];

    // Get available services from arrivalData (arrivals API or schedules)
    const availableServices = getAvailableServices();

    // Filter results to only include routes with startService in available services
    // If no arrivalData is available, show all routes (fallback behavior)
    const filteredResults =
      availableServices.size > 0
        ? results.filter((result) => {
            if (!result.startService) return false;
            return availableServices.has(String(result.startService));
          })
        : results;

    if (!filteredResults.length) return [];

    // Create array with results and their scores
    const resultsWithScores = filteredResults.map((result) => {
      const scoreData = calculateScore(result);
      return {
        result,
        score: scoreData.totalScore,
        breakdown: scoreData.breakdown,
      };
    });

    // Console log all routes with their score breakups
    console.log('=== All Routes with Score Breakups ===');
    resultsWithScores.forEach(({ result, score, breakdown }, index) => {
      console.log(`Route ${index + 1}:`, {
        startService: result.startService,
        endService: result.endService,
        stopsBetween: result.stopsBetween.length,
        scoreBreakdown: {
          interchangeScore: breakdown.interchangeScore,
          stopsScore: breakdown.stopsScore.toFixed(2),
          arrivalTimeScore: breakdown.arrivalTimeScore.toFixed(2),
          totalScore: score.toFixed(2),
        },
      });
    });
    console.log('=====================================');

    // Filter out routes with totalScore of 0
    const nonZeroScoreResults = resultsWithScores.filter(
      (item) => item.score > 0,
    );

    // Sort by score in descending order (higher score first)
    nonZeroScoreResults.sort((a, b) => b.score - a.score);

    // Return top 30 results
    return nonZeroScoreResults.slice(0, 30).map((item) => item.result);
  }, [results, arrivalData]);

  if (!sortedResults.length) {
    return (
      <div class="between-block between-nada">
        {liveApiFailed
          ? 'No live data available'
          : 'No upcoming connecting routes'}
      </div>
    );
  }

  return (
    <div class="between-block">
      {sortedResults.map((result) => {
        const { stopsBetween, _nearbyStart, _nearbyEnd } = result;
        return (
          <div
            class={`between-item ${_nearbyStart ? 'nearby-start' : ''}  ${
              _nearbyEnd ? 'nearby-end' : ''
            }`}
            onClick={(e) => onClickRoute(e, result)}
          >
            <div class="between-inner">
              <div
                class={`between-services ${result.endService ? '' : 'full'}`}
              >
                <span class="start">{result.startService}</span>
                {!!result.endService && (
                  <span class="end">{result.endService}</span>
                )}
              </div>
              <div class={`between-stops ${stopsBetween.length ? '' : 'nada'}`}>
                {result.startStop && (
                  <span class="start">
                    {result.startStop.name || result.startStop.number}
                  </span>
                )}
                <span
                  class={`betweens betweens-${Math.min(
                    6,
                    stopsBetween.length,
                  )}`}
                >
                  {!!stopsBetween.length &&
                    (stopsBetween.length === 1
                      ? getStopName(stopsBetween[0])
                      : `${stopsBetween.length} stops`)}
                </span>
                {result.endStop && (
                  <span class="end">
                    {result.endStop.name || result.endStop.number}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
