import getRoute from './utils/getRoute';
import {
  DEFAULT_CITY as SHARED_DEFAULT_CITY,
  AVAILABLE_CITIES as SHARED_AVAILABLE_CITIES,
  CITY_CONFIGS,
  getConfigForCity as sharedGetConfigForCity,
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
  return !!CITY_CONFIGS[cityCode];
};

export const getCityBounds = () => {
  const config = getConfigForCity(getCurrentCity());
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
