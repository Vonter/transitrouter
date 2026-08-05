export function insertNearest(results, entry, limit = 25) {
  if (
    results.length === limit &&
    entry.distance >= results[results.length - 1].distance
  ) {
    return;
  }

  let low = 0;
  let high = results.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (results[mid].distance <= entry.distance) low = mid + 1;
    else high = mid;
  }
  results.splice(low, 0, entry);
  if (results.length > limit) results.pop();
}
