export const DEFAULT_CITY = 'blr';
export const AVAILABLE_CITIES = [
  'blr',
  'chennai',
  'delhi',
  'goa',
  'kochi',
  'pune',
  'telangana',
  'andhrapradesh',
  'indore',
  'railways',
  'greyhound',
  'nyc',
];

export const CITY_CONFIGS = {
  blr: {
    city: {
      name: 'Bengaluru',
      code: 'blr',
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
      bounds: {
        lowerLat: 18.35,
        upperLat: 18.75,
        lowerLong: 73.65,
        upperLong: 74.05,
      },
    },
  },
  telangana: {
    city: {
      name: 'Telangana',
      code: 'telangana',
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
      bounds: {
        lowerLat: 12.4,
        upperLat: 19.7,
        lowerLong: 77.0,
        upperLong: 85.5,
      },
    },
  },
  indore: {
    city: {
      name: 'Indore',
      code: 'indore',
      bounds: {
        lowerLat: 22.5,
        upperLat: 22.9,
        lowerLong: 75.6,
        upperLong: 76.1,
      },
    },
  },
  railways: {
    city: {
      name: 'Railways',
      code: 'railways',
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
 * In development (localhost), returns http://localhost:8788
 * In production, returns empty string (uses relative paths)
 */
export const getApiBaseUrl = () => {
  return isDevelopmentMode() ? 'http://localhost:8788' : '';
};

/**
 * Converts an API path to a full URL
 * In development, prepends http://localhost:8788
 * In production, uses the path as-is
 */
export const getApiUrl = (apiPath) => {
  if (!apiPath) return null;
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
