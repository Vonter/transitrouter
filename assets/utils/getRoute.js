import { DEFAULT_CITY } from '../config';

export default () => {
  const path = location.hash.replace(/^#/, '') || '/';
  
  // Handle root path
  if (path === '/') return { page: 'home', city: DEFAULT_CITY };
  
  // Extract city code if present (case insensitive)
  const cityMatch = path.match(/^\/([A-Za-z]*)(\/|$)/);
  const city = cityMatch ? cityMatch[1].toLowerCase() : DEFAULT_CITY;
  
  // Remove city prefix from path for route matching
  const routePath = cityMatch ? path.substring(cityMatch[0].length) : path;
  
  // Match route components
  let [_, page, value, subpage] = 
    routePath.match(/(service|stop|between)s?\/([^\/]+)\/?([^\/]+)?/) || [];
  
  return { 
    city,
    page: page || 'home',
    value,
    path,
    subpage,
    cityPrefix: `/${city}`
  };
};