export const isDark = document.documentElement.classList.contains('dark');

export const mapStyle = isDark ? '/data/style-dark.json' : '/data/style.json';

// Semantic color palette for map layers — light/dark pairs
const light = {
  stopRed: '#f01b48',
  stopCircleBg: '#fff',
  routeLine: '#1a1a1a',
  routeLineMid: '#666666',
  routeCasing: '#fff',
  text: '#000',
  textHalo: '#fff',
  metroPurple: '#5301a4',
  serviceGreen: '#1e5a0e',
  serviceGreenHalo: '#eeffd1',
  linkBlue: '#007aff',
  routeLineOpacity: 0.5,
  stationHaloWidth: 0.8,
};

const dark = {
  stopRed: '#ff4d6d',
  stopCircleBg: '#1a1a1a',
  routeLine: '#c0c0c0',
  routeLineMid: '#e0e0e0',
  routeCasing: '#0a0a0a',
  text: '#e0e0e0',
  textHalo: '#000',
  metroPurple: '#a855f7',
  serviceGreen: '#66e848',
  serviceGreenHalo: '#0a1a05',
  linkBlue: '#4da3ff',
  routeLineOpacity: 0.8,
  stationHaloWidth: 1.5,
};

export const C = isDark ? dark : light;

// Reusable MapLibre line-gradient for route lines
export const routeLineGradient = [
  'interpolate',
  ['linear'],
  ['line-progress'],
  0,
  C.routeLine,
  0.5,
  C.routeLineMid,
  1,
  C.routeLine,
];

// Station text-color expression with dark-mode brightening
const STATION_COLOR_FIELD = ['get', 'station_colors'];
const stationColorFallback = ['to-color', STATION_COLOR_FIELD];

const DARK_COLOR_MAP = {
  purple: '#c084fc',
  '#800080': '#c084fc',
  '#5301a4': '#a855f7',
  '#7b2fbe': '#c084fc',
  '#9b59b6': '#c084fc',
  '#ee82ee': '#f0abfc',
  violet: '#f0abfc',
  green: '#4ade80',
  '#008000': '#4ade80',
  '#009933': '#4ade80',
  '#00a650': '#4ade80',
  '#009b3a': '#4ade80',
  '#00843d': '#4ade80',
  '#00008b': '#60a5fa',
  '#0000ff': '#60a5fa',
  blue: '#60a5fa',
  '#000080': '#60a5fa',
  '#8b0000': '#f87171',
  maroon: '#f87171',
};

const yellowCase = [
  'any',
  ['==', STATION_COLOR_FIELD, '#ffff00'],
  ['==', STATION_COLOR_FIELD, 'yellow'],
];

export const stationIconColor = isDark
  ? [
      'case',
      yellowCase,
      '#FFEA00',
      ...Object.entries(DARK_COLOR_MAP).flatMap(([src, dest]) => [
        ['==', STATION_COLOR_FIELD, src],
        dest,
      ]),
      '#e0e0e0',
    ]
  : ['case', yellowCase, '#FFEA00', stationColorFallback];

export const stationTextColor = isDark
  ? [
      'case',
      yellowCase,
      '#FFEA00',
      ...Object.entries(DARK_COLOR_MAP).flatMap(([src, dest]) => [
        ['==', STATION_COLOR_FIELD, src],
        dest,
      ]),
      '#e0e0e0',
    ]
  : ['case', yellowCase, '#FFEA00', stationColorFallback];
