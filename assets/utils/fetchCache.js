import lscache from 'lscache';

// Track in-flight requests to avoid duplicate fetches
const inFlightRequests = new Map();

export default (url, timeout) => {
  // Check local storage cache first
  const data = lscache.get(url);
  if (data) {
    return Promise.resolve(data);
  }

  // Check if there's already an in-flight request for this URL
  if (inFlightRequests.has(url)) {
    return inFlightRequests.get(url);
  }

  // Create the fetch promise
  const fetchPromise = fetch(url)
    .then((r) => {
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}: ${r.statusText}`);
      }
      const contentType = r.headers.get('content-type');
      if (contentType && !contentType.includes('application/json')) {
        throw new Error(`Expected JSON but got ${contentType}`);
      }
      return r.text().then((text) => {
        if (!text || text.trim().length === 0) {
          throw new Error('Empty response');
        }
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new Error(`JSON.parse: ${e.message}`);
        }
      });
    })
    .then((r) => {
      lscache.set(url, r, timeout);
      return r;
    })
    .catch((error) => {
      console.error(`fetchCache error for ${url}:`, error);
      throw error;
    })
    .finally(() => {
      // Remove from in-flight requests when done
      inFlightRequests.delete(url);
    });

  // Track this request
  inFlightRequests.set(url, fetchPromise);

  return fetchPromise;
};
