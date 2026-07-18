import { DEFAULT_CITY } from '../config';

/**
 * Parses the value segment of an all-mode URL.
 * "blr^12F~chennai^104P" → [{ city: 'blr', id: '12F' }, { city: 'chennai', id: '104P' }]
 */
export const parseAllModeValue = (value) => {
  if (!value) return [];
  return value.split('~').map((part) => {
    const idx = part.indexOf('^');
    if (idx === -1) return null;
    return { city: part.slice(0, idx), id: part.slice(idx + 1) };
  }).filter(Boolean);
};

export default () => {
  const path = location.hash.replace(/^#/, '') || '/';

  // Handle root path
  if (path === '/') return { page: 'home', city: DEFAULT_CITY };

  // Extract city code if present (case insensitive); 'all' is a valid reserved code
  const cityMatch = path.match(/^\/([A-Za-z]*)(\/|$)/);
  const city = cityMatch ? cityMatch[1].toLowerCase() : DEFAULT_CITY;

  // Remove city prefix from path for route matching
  const routePath = cityMatch ? path.substring(cityMatch[0].length) : path;

  // Match route components
  let [_, page, value, subpage] =
    routePath.match(/(service|stop|between|location)s?\/([^\/]+)\/?([^\/]+)?/) || [];

  // Decode URI components to handle encoded whitespace and special characters
  try {
    if (page) page = decodeURIComponent(page);
    if (value) value = decodeURIComponent(value);
    if (subpage) subpage = decodeURIComponent(subpage);
  } catch (e) {
    // If decoding fails, use the original values
    console.warn('Failed to decode URI components:', e);
  }

  return {
    city,
    page: page || 'home',
    value,
    path,
    subpage,
    cityPrefix: `/${city}`,
  };
};
