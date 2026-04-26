export const FALLBACK_CITY = 'blr';

const pref = (key) => localStorage.getItem(key);
const storedDefaultCity = pref('defaultCity');
export const DEFAULT_CITY =
  storedDefaultCity && storedDefaultCity !== 'auto'
    ? storedDefaultCity
    : FALLBACK_CITY;

export const isDevMode = () => pref('devMode') === 'true';
export const isApiDisabled = () => isDevMode() && pref('disableApi') === 'true';
export const isAlphaEnabled = () => isDevMode() && pref('alphaFeatures') === 'true';

export const AVAILABLE_CITIES = [
  'blr',
  'chennai',
  'delhi',
  'goa',
  'kochi',
  'pune',
  'mumbai',
  'hublidharwad',
  'telangana',
  'andhrapradesh',
  'ahmedabad',
  'indore',
  'rajkot',
  'railways',
  'greyhound',
  'nyc',
];

export const CITY_CONFIGS = {
  blr: {
    city: {
      name: 'Bengaluru',
      code: 'blr',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 12.8,
        upperLat: 13.15,
        lowerLong: 77.4,
        upperLong: 77.75,
      },
    },
    liveArrivals: {
      enabled: true,
      apiPath: '/api/bmtc/arrivals',
    },
    liveVehicles: {
      enabled: true,
      apiPath: '/api/bmtc/vehicles',
    },
    stopRoutes: {
      enabled: true,
      apiPath: '/api/bmtc/stop-routes',
    },
    stopVehicles: {
      enabled: true,
      apiPath: '/api/bmtc/stop-vehicles',
    },
    normalizeNames: {
      enabled: true,
      removeChars: ['-', ' '],
    },
    maxArrivalTime: 2 * 60 * 60 * 1000, // 2 hours in milliseconds
    disableStopID: true,
  },
  goa: {
    city: {
      name: 'Goa',
      code: 'goa',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 15.1,
        upperLat: 15.9,
        lowerLong: 73.75,
        upperLong: 74.15,
      },
    },
  },
  kochi: {
    city: {
      name: 'Kochi',
      code: 'kochi',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 9.8,
        upperLat: 10.2,
        lowerLong: 76.25,
        upperLong: 76.55,
      },
    },
  },
  chennai: {
    city: {
      name: 'Chennai',
      code: 'chennai',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 12.85,
        upperLat: 13.35,
        lowerLong: 80.0,
        upperLong: 80.4,
      },
    },
  },
  delhi: {
    city: {
      name: 'Delhi',
      code: 'delhi',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 28.35,
        upperLat: 28.95,
        lowerLong: 76.95,
        upperLong: 77.55,
      },
    },
  },
  pune: {
    city: {
      name: 'Pune',
      code: 'pune',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 18.35,
        upperLat: 18.75,
        lowerLong: 73.65,
        upperLong: 74.05,
      },
    },
    liveArrivals: {
      enabled: true,
      apiPath: '/api/pmpml/arrivals',
    },
    liveVehicles: {
      enabled: true,
      apiPath: '/api/pmpml/vehicles',
    },
    stopRoutes: {
      enabled: true,
      apiPath: '/api/pmpml/stop-routes',
    },
    stopVehicles: {
      enabled: true,
      apiPath: '/api/pmpml/stop-vehicles',
    },
    maxArrivalTime: 2 * 60 * 60 * 1000, // 2 hours in milliseconds
  },
  mumbai: {
    city: {
      name: 'Mumbai',
      code: 'mumbai',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 18.90,
        upperLat: 19.31,
        lowerLong: 72.78,
        upperLong: 73.16,
      },
    }
  },
  hublidharwad: {
    city: {
      name: 'Hubli-Dharwad',
      code: 'hublidharwad',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 15.27,
        upperLat: 15.53,
        lowerLong: 74.77,
        upperLong: 75.35,
      },
    }
  },
  telangana: {
    city: {
      name: 'Telangana',
      code: 'telangana',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 15.5,
        upperLat: 20.5,
        lowerLong: 77.0,
        upperLong: 82.0,
      },
    },
  },
  andhrapradesh: {
    city: {
      name: 'Andhra Pradesh',
      code: 'andhrapradesh',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 12.4,
        upperLat: 19.7,
        lowerLong: 77.0,
        upperLong: 85.5,
      },
    },
  },
  ahmedabad: {
    city: {
      name: 'Ahmedabad',
      code: 'ahmedabad',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 22.82,
        upperLat: 23.25,
        lowerLong: 72.28,
        upperLong: 72.83,
      },
    },
  },
  indore: {
    city: {
      name: 'Indore',
      code: 'indore',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 22.5,
        upperLat: 22.9,
        lowerLong: 75.6,
        upperLong: 76.1,
      },
    },
  },
  rajkot: {
    city: {
      name: 'Rajkot',
      code: 'rajkot',
      flag: '🇮🇳',
      bounds: {
        lowerLat: 22.11,
        upperLat: 22.44,
        lowerLong: 70.65,
        upperLong: 70.96,
      },
    },
  },
  railways: {
    city: {
      name: 'Railways',
      code: 'railways',
      flag: '🇮🇳',
      bounds: {
        lowerLat: -5,
        upperLat: 45,
        lowerLong: 70,
        upperLong: 100,
      },
    },
  },
  greyhound: {
    city: {
      name: 'Greyhound',
      code: 'greyhound',
      flag: '🇺🇸',
      bounds: {
        lowerLat: 24.9493,
        upperLat: 49.5904,
        lowerLong: -125.0011,
        upperLong: -66.9326,
      },
    },
    disableStopID: true,
  },
  nyc: {
    city: {
      name: 'New York City',
      code: 'nyc',
      flag: '🇺🇸',
      bounds: {
        lowerLat: 40.5,
        upperLat: 41.0,
        lowerLong: -74.5,
        upperLong: -73.5,
      },
    },
    disableStopID: true,
  },
};

/**
 * Checks if we're running in development mode on localhost
 */
export const isDevelopmentMode = () => {
  return (
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1')
  );
};

/**
 * Gets the base URL for API calls
 * In development (localhost), uses the current origin so it works
 * with whatever port wrangler is running on
 * In production, returns empty string (uses relative paths)
 */
export const getApiBaseUrl = () => {
  return isDevelopmentMode() ? window.location.origin : '';
};

/**
 * Converts an API path to a full URL
 * In development, prepends http://localhost:8788
 * In production, uses the path as-is
 */
export const getApiUrl = (apiPath) => {
  if (!apiPath) return null;
  if (isApiDisabled()) return null;
  return `${getApiBaseUrl()}${apiPath}`;
};

export const getConfigForCity = (cityCode) => {
  const config = CITY_CONFIGS[cityCode] || CITY_CONFIGS[DEFAULT_CITY];
  if (!config) {
    console.error(`No config found for city ${cityCode}`);
    return null;
  }
  return {
    ...config,
    maxArrivalTime: config.maxArrivalTime ?? 24 * 60 * 60 * 1000,
    disableStopID: config.disableStopID ?? false,
  };
};
