import lscache from 'lscache';

export default (url, timeout) => {
  const data = lscache.get(url);
  if (data) {
    return Promise.resolve(data);
  } else {
    return fetch(url)
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
      });
  }
};
