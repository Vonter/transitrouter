import getRoute from './utils/getRoute';
import {
  DEFAULT_CITY as SHARED_DEFAULT_CITY,
  AVAILABLE_CITIES as SHARED_AVAILABLE_CITIES,
  CITY_CONFIGS,
  getConfigForCity as sharedGetConfigForCity,
  isAlphaEnabled,
} from './city-config';

export const DEFAULT_CITY = SHARED_DEFAULT_CITY;
export const AVAILABLE_CITIES = SHARED_AVAILABLE_CITIES;
export const getConfigForCity = sharedGetConfigForCity;

export const getCurrentCity = () => {
  try {
    const { city } = getRoute();
    return city || DEFAULT_CITY;
  } catch (e) {
    return DEFAULT_CITY;
  }
};

export const isCitySupported = (cityCode) => {
  if (cityCode === 'all') return isAlphaEnabled();
  return !!CITY_CONFIGS[cityCode];
};

// India/South-Asia initial extent used when city === 'all'
const ALL_MODE_BOUNDS = [66, 6, 98, 38];

export const getCityBounds = () => {
  const currentCity = getCurrentCity();
  if (currentCity === 'all') return ALL_MODE_BOUNDS;
  const config = getConfigForCity(currentCity);
  if (!config?.city?.bounds) {
    console.error('Invalid city config:', config);
    return [0, 0, 0, 0]; // Safe fallback
  }

  const { lowerLat, upperLat, lowerLong, upperLong } = config.city.bounds;
  return [lowerLong, lowerLat, upperLong, upperLat];
};

export const getCityInfo = () => {
  const config = getConfigForCity(getCurrentCity());
  return config?.city;
};

// Default export returns current city's config
export default () => getConfigForCity(getCurrentCity());
