export function parsePoisCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  return lines.slice(1).map((line) => {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return {
      name: fields[0],
      type: fields[1],
      lat: parseFloat(fields[2]),
      lon: parseFloat(fields[3]),
      color: (fields[4] || '').trim(),
    };
  });
}

export function fetchPois(city) {
  return fetch(`/data/${city}/pois.csv`)
    .then((r) => (r.ok ? r.text() : ''))
    .then((text) => (text ? parsePoisCsv(text) : []))
    .catch(() => []);
}
