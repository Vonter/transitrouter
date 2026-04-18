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

// station-color field accessor
const STATION_COLOR = ['get', 'station-color'];

// Dark-mode brightening map: raw line colors → legible versions on dark backgrounds
const DARK_COLOR_MAP = {
  // Yellows
  '#FFD700': '#FFEA00',
  '#ffdf00': '#FFEA00',
  '#ffff00': '#FFEA00',
  yellow: '#FFEA00',
  // Purples / violets
  purple: '#c084fc',
  violet: '#f0abfc',
  '#800080': '#c084fc',
  '#5301a4': '#a855f7',
  '#553592': '#a855f7',
  '#4B0082': '#818cf8',
  '#7b2fbe': '#c084fc',
  '#77248b': '#c084fc',
  '#9b59b6': '#c084fc',
  '#e542de': '#f0abfc',
  '#ee82ee': '#f0abfc',
  '#cc338b': '#f472b6',
  // Blues
  blue: '#60a5fa',
  '#000080': '#60a5fa',
  '#00008b': '#60a5fa',
  '#0000ff': '#60a5fa',
  '#4169e1': '#60a5fa',
  '#3281c4': '#60a5fa',
  // Greens
  green: '#4ade80',
  '#008000': '#4ade80',
  '#009933': '#4ade80',
  '#53b848': '#4ade80',
  '#00a650': '#4ade80',
  '#009b3a': '#4ade80',
  '#00843d': '#4ade80',
  // Teals
  '#0097A7': '#4dd0e1',
  '#00897B': '#34d399',
  // Reds / oranges
  maroon: '#f87171',
  '#8b0000': '#f87171',
  '#ff0000': '#f87171',
  '#ff4040': '#f87171',
  '#ff8c00': '#fb923c',
  '#ff9900': '#fb923c',
  // Browns (commuter rail)
  '#795548': '#bcaaa4',
  '#5D4037': '#a1887f',
};

// Station color expression: uses line color directly in light mode;
// in dark mode, maps known dark colors to bright equivalents.
export const stationIconColor = isDark
  ? [
      'case',
      ...Object.entries(DARK_COLOR_MAP).flatMap(([src, dest]) => [
        ['==', STATION_COLOR, src],
        dest,
      ]),
      ['to-color', STATION_COLOR],
    ]
  : ['to-color', STATION_COLOR];

export const stationTextColor = stationIconColor;
