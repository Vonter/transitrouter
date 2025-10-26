import getRoute from './utils/getRoute';

// Constants
export const DEFAULT_CITY = 'blr';

// City configs
const CITY_CONFIGS = {
  blr: {
    city: {
      name: 'Bengaluru',
      code: 'blr',
      bounds: {
        lowerLat: 12.8,
        upperLat: 13.15,
        lowerLong: 77.4,
        upperLong: 77.75
      }
    }
  },
  goa: {
    city: {
      name: 'Goa',
      code: 'goa',
      bounds: {
        lowerLat: 15.1,
        upperLat: 15.9,
        lowerLong: 73.75,
        upperLong: 74.15
      }
    }
  },
  kochi: {
    city: {
      name: 'Kochi',
      code: 'kochi',
      bounds: {
        lowerLat: 9.8,
        upperLat: 10.2,
        lowerLong: 76.25,
        upperLong: 76.55
      }
    }
  },
  chennai: {
    city: {
      name: 'Chennai',
      code: 'chennai',
      bounds: {
        lowerLat: 12.85,
        upperLat: 13.35,
        lowerLong: 80.0,
        upperLong: 80.4
      }
    }
  },
  delhi: {
    city: {
      name: 'Delhi',
      code: 'delhi',
      bounds: {
        lowerLat: 28.35,
        upperLat: 28.95,
        lowerLong: 76.95,
        upperLong: 77.55
      }
    }
  },
  railways: {
    city: {
      name: 'Railways',
      code: 'railways',
      bounds: {
        lowerLat: -5,
        upperLat: 45,
        lowerLong: 70,
        upperLong: 100
      }
    }
  }
};

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

export const getConfigForCity = (cityCode) => {
  const config = CITY_CONFIGS[cityCode] || CITY_CONFIGS[DEFAULT_CITY];
  if (!config) {
    console.error(`No config found for city ${cityCode}`);
    return null;
  }
  return config;
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