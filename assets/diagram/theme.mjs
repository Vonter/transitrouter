// ════════════════════════════════════════════════════════════════════════════
// Theme — centralised design tokens for the transit diagram.
// Edit this file to tweak sizes, colours and typography.
// ════════════════════════════════════════════════════════════════════════════

// ── Canvas ──────────────────────────────────────────────────────────────────
export let SVG_WIDTH = 660;
export let SVG_ASPECT = 820 / 660; // Canvas height as a multiple of its width

// ── Header ──────────────────────────────────────────────────────────────────
export let HDR1_H = 82; // Main header height (stop name + logo)
export let HEADER_LOGO_X = 16; // Logo X position
export let HEADER_LOGO_Y = 17; // Logo Y position
export let HEADER_LOGO_W = 48; // Logo width
export let HEADER_LOGO_H = 48; // Logo height
export let HEADER_NAME_X = 80; // Stop name text X position
export let HDR_KN_Y = 34; // Y for Kannada stop name
export let HDR_KN_SIZE = 30; // Font size for Kannada stop name
export let HDR_KN_EN_Y = 58; // Y for English name (below Kannada)
export let HDR_KN_EN_SIZE = 12; // Font size for English subtitle
export let HDR_KN_TOWARDS_Y = 76; // Y for "towards" text (Kannada mode)
export let HDR_KN_TOWARDS_SIZE = 24; // Font size for "towards" (Kannada mode)
export let HDR_EN_Y = 38; // Y for English stop name
export let HDR_EN_SIZE = 28; // Font size for English stop name
export let HDR_EN_TOWARDS_Y = 64; // Y for "towards" text (English mode)
export let HDR_EN_TOWARDS_SIZE = 22; // Font size for "towards" (English mode)

// ── Route badges ────────────────────────────────────────────────────────────
export let BADGE_H = 30; // Route badge pill height
export let BADGE_GAP_X = 6; // Gap between badge rows
export let BADGE_TOP_PAD = 10; // Padding above first badge row
export let BADGE_BOT_PAD = 14; // Padding below last badge row
export let BADGE_PADDING_H = 10; // Horizontal padding inside badge pill
export let BADGE_ROW_MARGIN = 16; // Left/right margin for badge rows
export let BADGE_INNER_GAP = 4; // Gap between adjacent badges in a row
export let BADGE_ICON_TEXT_GAP = 6; // Gap between bus icon and route number
export let BADGE_CHAR_SCALE = 0.6; // Badge font-size → char-width multiplier
export let BUS_ICON_W = 14; // Width of the inline bus icon in badges
export let BUS_ICON_H = 16; // Height of the inline bus icon in badges
export let BADGE_FONT_SIZE = 18; // Font size for route number text in badges

// ── Route diagram ───────────────────────────────────────────────────────────
export let DIAGRAM_TOP_PAD = 12; // Space above the highest drawn element
export let CLUSTER_SPACING = 24; // Vertical distance between adjacent route tracks
export let CLUSTER_LABEL_BAND = 72; // Widened track gap that makes room for a row of stop labels
export let BRANCH_CORNER_R = 12; // Corner radius where a track steps to another row
export let ROUTE_LINE_START_X = 108; // X where route lines begin
export let ROUTE_AREA_END_PCT = 0.9; // Fraction of SVG_WIDTH where route area ends
export let ROUTE_LINE_MIN_EXTEND = 24; // Min px a route line extends into the diagram
export let STOP_SPACING_MIN = 26; // Smallest horizontal gap between adjacent stops
export let STOP_SPACING_MAX = 48; // Largest horizontal gap between adjacent stops
export let LABEL_AREA_END_X = 100; // Route label boxes right-align to this x
export let LABEL_GAP = 2; // Gap between adjacent route label boxes
export let LABEL_BOX_H = 12.4; // Height of a route label box
export let LABEL_BOX_RX = 2.2; // Border radius of route label box
export let LABEL_BOX_FONT_SIZE = 10; // Font size inside route ID label boxes
export let LABEL_BOX_CHAR_W = 6.2; // Approx char width for label box sizing/truncation
export let LABEL_BOX_PAD = 4; // Horizontal padding inside a route label box
export let PILL_W_SMALL = 8; // Width of stop marker pill for stops unique to one cluster
export let PILL_OVERHANG = 5; // Px a stop pill extends beyond the first/last track it spans
export let TERMINAL_RADIUS = 2; // Radius of the dot marking a route terminus
export let CURRENT_PILL_W = 8; // Width of current-stop pill
export let DIAGRAM_BOTTOM_PAD = 16; // Space below the lowest drawn element

// ── Stop labels ─────────────────────────────────────────────────────────────
export let LABEL_ROT = -30; // Rotation in degrees (negative = counter-clockwise)
export let LABEL_FONT_SIZE = 9; // Font size for stop labels
export let LABEL_CHAR_WIDTH = 5.5; // Approx character width used for overlap detection
export let LABEL_ROW_OFFSET = 12; // Extra offset per additional label row (away from the marker)
export let LABEL_ICON_GAP = 6; // Breathing room between stop icon edge and label start
export let LABEL_MAX_LINE_CHARS = 20; // Max characters per line before wrapping a stop label
export let LABEL_HORIZ_GAP = 6; // Min gap between adjacent labels along the rotated text axis
export let LABEL_LINE_SPACING_EXTRA = 3; // Extra px added to font size for multi-line label line-height
export let LABEL_STACK_GAP = 3; // Min clearance between stacked stop labels, across the text axis
export let LABEL_MAX_ROWS = 6; // Max times a stop label steps away from its marker to clear others
export let LABEL_POI_ICON_SIZE = 9; // Size of an interchange icon shown beside a stop label
export let LABEL_POI_ICON_GAP = 2; // Gap between adjacent interchange icons

// ── Info panel ──────────────────────────────────────────────────────────────
export let INFO_PANEL_H = 180; // Panel height
export let LEGEND_INNER_W = 95; // Width of the legend content column
export let LEGEND_VERT_PAD = 10; // Vertical padding inside the legend section
export let LEGEND_ICON_TOP = 5; // Top offset for the first legend item
export let LEGEND_ICON_SIZE = 12; // Legend icon size (px)
export let LEGEND_ICON_TEXT_GAP = 4; // Gap between legend icon and its text label
export let MAP_STOP_ICON_SIZE = 12; // Side length of the bus-stop marker on the area map
export let QR_MAX_SIZE = 140; // Max QR code side length (px)
export let QR_PAD = 20; // Padding inside QR section used to cap QR size

// ── Colours ─────────────────────────────────────────────────────────────────
export let C = {
  primary: '#1B4DA9', // Main blue — route lines, labels, badges
  header1: '#0E3F9A', // Main header background (darker blue)
  header2: '#1B4CA9', // Route badges strip background
  accent: '#E4324B', // Accent red — highlights
  youAreHere: '#CE242B', // You-are-here star colour
  orange: '#FE7C16', // Long-distance bus colour
  white: '#ffffff',
  nearBlack: '#222222',
  muted: '#666666',
  labelMuted: '#888888', // Lighter colour for stop name labels
  pillStroke: '#585858', // Regular stop marker border
  border: 'rgba(0,0,0,0.10)',
  bgLight: '#f5f5f5',
  mapBg: '#e8e4db',
};

// ── Typography ────────────────────────────────────────────────────────────────
export let FONT = `'Manrope', system-ui, -apple-system, sans-serif`;
export let FONT_KN = `'Noto Sans Kannada', 'Manrope', system-ui, sans-serif`;

// ── Default snapshot (used by resetTheme and ExpertPanel initialisation) ──
export const DEFAULTS = {
  SVG_WIDTH: 660,
  SVG_ASPECT: 820 / 660,
  HDR1_H: 82,
  HEADER_LOGO_X: 16,
  HEADER_LOGO_Y: 17,
  HEADER_LOGO_W: 48,
  HEADER_LOGO_H: 48,
  HEADER_NAME_X: 80,
  HDR_KN_Y: 34,
  HDR_KN_SIZE: 30,
  HDR_KN_EN_Y: 58,
  HDR_KN_EN_SIZE: 12,
  HDR_KN_TOWARDS_Y: 76,
  HDR_KN_TOWARDS_SIZE: 24,
  HDR_EN_Y: 38,
  HDR_EN_SIZE: 28,
  HDR_EN_TOWARDS_Y: 64,
  HDR_EN_TOWARDS_SIZE: 22,
  BADGE_H: 30,
  BADGE_GAP_X: 6,
  BADGE_TOP_PAD: 10,
  BADGE_BOT_PAD: 14,
  BADGE_PADDING_H: 10,
  BADGE_ROW_MARGIN: 16,
  BADGE_INNER_GAP: 4,
  BADGE_ICON_TEXT_GAP: 6,
  BADGE_CHAR_SCALE: 0.6,
  BUS_ICON_W: 14,
  BUS_ICON_H: 16,
  BADGE_FONT_SIZE: 18,
  DIAGRAM_TOP_PAD: 12,
  CLUSTER_SPACING: 24,
  CLUSTER_LABEL_BAND: 72,
  BRANCH_CORNER_R: 12,
  ROUTE_LINE_START_X: 108,
  ROUTE_AREA_END_PCT: 0.9,
  ROUTE_LINE_MIN_EXTEND: 24,
  STOP_SPACING_MIN: 26,
  STOP_SPACING_MAX: 48,
  LABEL_AREA_END_X: 100,
  LABEL_GAP: 2,
  LABEL_BOX_H: 12.4,
  LABEL_BOX_RX: 2.2,
  LABEL_BOX_FONT_SIZE: 10,
  LABEL_BOX_CHAR_W: 6.2,
  LABEL_BOX_PAD: 4,
  PILL_W_SMALL: 8,
  PILL_OVERHANG: 5,
  TERMINAL_RADIUS: 2,
  CURRENT_PILL_W: 8,
  DIAGRAM_BOTTOM_PAD: 16,
  LABEL_ROT: -30,
  LABEL_FONT_SIZE: 9,
  LABEL_CHAR_WIDTH: 5.5,
  LABEL_ROW_OFFSET: 12,
  LABEL_ICON_GAP: 6,
  LABEL_MAX_LINE_CHARS: 20,
  LABEL_HORIZ_GAP: 6,
  LABEL_LINE_SPACING_EXTRA: 3,
  LABEL_STACK_GAP: 3,
  LABEL_MAX_ROWS: 6,
  LABEL_POI_ICON_SIZE: 9,
  LABEL_POI_ICON_GAP: 2,
  INFO_PANEL_H: 180,
  LEGEND_INNER_W: 95,
  LEGEND_VERT_PAD: 10,
  LEGEND_ICON_TOP: 5,
  LEGEND_ICON_SIZE: 12,
  LEGEND_ICON_TEXT_GAP: 4,
  MAP_STOP_ICON_SIZE: 12,
  QR_MAX_SIZE: 140,
  QR_PAD: 20,
  C: {
    primary: '#1B4DA9',
    header1: '#0E3F9A',
    header2: '#1B4CA9',
    accent: '#E4324B',
    youAreHere: '#CE242B',
    orange: '#FE7C16',
    white: '#ffffff',
    nearBlack: '#222222',
    muted: '#666666',
    labelMuted: '#888888',
    pillStroke: '#585858',
    border: 'rgba(0,0,0,0.10)',
    bgLight: '#f5f5f5',
    mapBg: '#e8e4db',
  },
  FONT: `'Manrope', system-ui, -apple-system, sans-serif`,
  FONT_KN: `'Noto Sans Kannada', 'Manrope', system-ui, sans-serif`,
};

// ── Current values snapshot (reads live bindings) ─────────────────────────
export function getCurrentThemeValues() {
  return {
    SVG_WIDTH,
    SVG_ASPECT,
    HDR1_H,
    HEADER_LOGO_X,
    HEADER_LOGO_Y,
    HEADER_LOGO_W,
    HEADER_LOGO_H,
    HEADER_NAME_X,
    HDR_KN_Y,
    HDR_KN_SIZE,
    HDR_KN_EN_Y,
    HDR_KN_EN_SIZE,
    HDR_KN_TOWARDS_Y,
    HDR_KN_TOWARDS_SIZE,
    HDR_EN_Y,
    HDR_EN_SIZE,
    HDR_EN_TOWARDS_Y,
    HDR_EN_TOWARDS_SIZE,
    BADGE_H,
    BADGE_GAP_X,
    BADGE_TOP_PAD,
    BADGE_BOT_PAD,
    BADGE_PADDING_H,
    BADGE_ROW_MARGIN,
    BADGE_INNER_GAP,
    BADGE_ICON_TEXT_GAP,
    BADGE_CHAR_SCALE,
    BUS_ICON_W,
    BUS_ICON_H,
    BADGE_FONT_SIZE,
    DIAGRAM_TOP_PAD,
    CLUSTER_SPACING,
    CLUSTER_LABEL_BAND,
    BRANCH_CORNER_R,
    ROUTE_LINE_START_X,
    ROUTE_AREA_END_PCT,
    ROUTE_LINE_MIN_EXTEND,
    STOP_SPACING_MIN,
    STOP_SPACING_MAX,
    LABEL_AREA_END_X,
    LABEL_GAP,
    LABEL_BOX_H,
    LABEL_BOX_RX,
    LABEL_BOX_FONT_SIZE,
    LABEL_BOX_CHAR_W,
    LABEL_BOX_PAD,
    PILL_W_SMALL,
    PILL_OVERHANG,
    TERMINAL_RADIUS,
    CURRENT_PILL_W,
    DIAGRAM_BOTTOM_PAD,
    LABEL_ROT,
    LABEL_FONT_SIZE,
    LABEL_CHAR_WIDTH,
    LABEL_ROW_OFFSET,
    LABEL_ICON_GAP,
    LABEL_MAX_LINE_CHARS,
    LABEL_HORIZ_GAP,
    LABEL_LINE_SPACING_EXTRA,
    LABEL_STACK_GAP,
    LABEL_MAX_ROWS,
    LABEL_POI_ICON_SIZE,
    LABEL_POI_ICON_GAP,
    INFO_PANEL_H,
    LEGEND_INNER_W,
    LEGEND_VERT_PAD,
    LEGEND_ICON_TOP,
    LEGEND_ICON_SIZE,
    LEGEND_ICON_TEXT_GAP,
    MAP_STOP_ICON_SIZE,
    QR_MAX_SIZE,
    QR_PAD,
    C: { ...C },
    FONT,
    FONT_KN,
  };
}

// ── Theme patcher (updates live module bindings) ──────────────────────────
export function patchTheme(key, value) {
  switch (key) {
    case 'SVG_WIDTH':
      SVG_WIDTH = value;
      break;
    case 'SVG_ASPECT':
      SVG_ASPECT = value;
      break;
    case 'HDR1_H':
      HDR1_H = value;
      break;
    case 'HEADER_LOGO_X':
      HEADER_LOGO_X = value;
      break;
    case 'HEADER_LOGO_Y':
      HEADER_LOGO_Y = value;
      break;
    case 'HEADER_LOGO_W':
      HEADER_LOGO_W = value;
      break;
    case 'HEADER_LOGO_H':
      HEADER_LOGO_H = value;
      break;
    case 'HEADER_NAME_X':
      HEADER_NAME_X = value;
      break;
    case 'HDR_KN_Y':
      HDR_KN_Y = value;
      break;
    case 'HDR_KN_SIZE':
      HDR_KN_SIZE = value;
      break;
    case 'HDR_KN_EN_Y':
      HDR_KN_EN_Y = value;
      break;
    case 'HDR_KN_EN_SIZE':
      HDR_KN_EN_SIZE = value;
      break;
    case 'HDR_KN_TOWARDS_Y':
      HDR_KN_TOWARDS_Y = value;
      break;
    case 'HDR_KN_TOWARDS_SIZE':
      HDR_KN_TOWARDS_SIZE = value;
      break;
    case 'HDR_EN_Y':
      HDR_EN_Y = value;
      break;
    case 'HDR_EN_SIZE':
      HDR_EN_SIZE = value;
      break;
    case 'HDR_EN_TOWARDS_Y':
      HDR_EN_TOWARDS_Y = value;
      break;
    case 'HDR_EN_TOWARDS_SIZE':
      HDR_EN_TOWARDS_SIZE = value;
      break;
    case 'BADGE_H':
      BADGE_H = value;
      break;
    case 'BADGE_GAP_X':
      BADGE_GAP_X = value;
      break;
    case 'BADGE_TOP_PAD':
      BADGE_TOP_PAD = value;
      break;
    case 'BADGE_BOT_PAD':
      BADGE_BOT_PAD = value;
      break;
    case 'BADGE_PADDING_H':
      BADGE_PADDING_H = value;
      break;
    case 'BADGE_ROW_MARGIN':
      BADGE_ROW_MARGIN = value;
      break;
    case 'BADGE_INNER_GAP':
      BADGE_INNER_GAP = value;
      break;
    case 'BADGE_ICON_TEXT_GAP':
      BADGE_ICON_TEXT_GAP = value;
      break;
    case 'BADGE_CHAR_SCALE':
      BADGE_CHAR_SCALE = value;
      break;
    case 'BUS_ICON_W':
      BUS_ICON_W = value;
      break;
    case 'BUS_ICON_H':
      BUS_ICON_H = value;
      break;
    case 'BADGE_FONT_SIZE':
      BADGE_FONT_SIZE = value;
      break;
    case 'DIAGRAM_TOP_PAD':
      DIAGRAM_TOP_PAD = value;
      break;
    case 'CLUSTER_SPACING':
      CLUSTER_SPACING = value;
      break;
    case 'CLUSTER_LABEL_BAND':
      CLUSTER_LABEL_BAND = value;
      break;
    case 'BRANCH_CORNER_R':
      BRANCH_CORNER_R = value;
      break;
    case 'ROUTE_LINE_START_X':
      ROUTE_LINE_START_X = value;
      break;
    case 'ROUTE_AREA_END_PCT':
      ROUTE_AREA_END_PCT = value;
      break;
    case 'ROUTE_LINE_MIN_EXTEND':
      ROUTE_LINE_MIN_EXTEND = value;
      break;
    case 'STOP_SPACING_MIN':
      STOP_SPACING_MIN = value;
      break;
    case 'STOP_SPACING_MAX':
      STOP_SPACING_MAX = value;
      break;
    case 'LABEL_AREA_END_X':
      LABEL_AREA_END_X = value;
      break;
    case 'LABEL_GAP':
      LABEL_GAP = value;
      break;
    case 'LABEL_BOX_H':
      LABEL_BOX_H = value;
      break;
    case 'LABEL_BOX_RX':
      LABEL_BOX_RX = value;
      break;
    case 'LABEL_BOX_FONT_SIZE':
      LABEL_BOX_FONT_SIZE = value;
      break;
    case 'LABEL_BOX_CHAR_W':
      LABEL_BOX_CHAR_W = value;
      break;
    case 'LABEL_BOX_PAD':
      LABEL_BOX_PAD = value;
      break;
    case 'PILL_W_SMALL':
      PILL_W_SMALL = value;
      break;
    case 'PILL_OVERHANG':
      PILL_OVERHANG = value;
      break;
    case 'TERMINAL_RADIUS':
      TERMINAL_RADIUS = value;
      break;
    case 'CURRENT_PILL_W':
      CURRENT_PILL_W = value;
      break;
    case 'DIAGRAM_BOTTOM_PAD':
      DIAGRAM_BOTTOM_PAD = value;
      break;
    case 'LABEL_ROT':
      LABEL_ROT = value;
      break;
    case 'LABEL_FONT_SIZE':
      LABEL_FONT_SIZE = value;
      break;
    case 'LABEL_CHAR_WIDTH':
      LABEL_CHAR_WIDTH = value;
      break;
    case 'LABEL_ROW_OFFSET':
      LABEL_ROW_OFFSET = value;
      break;
    case 'LABEL_ICON_GAP':
      LABEL_ICON_GAP = value;
      break;
    case 'LABEL_MAX_LINE_CHARS':
      LABEL_MAX_LINE_CHARS = value;
      break;
    case 'LABEL_HORIZ_GAP':
      LABEL_HORIZ_GAP = value;
      break;
    case 'LABEL_LINE_SPACING_EXTRA':
      LABEL_LINE_SPACING_EXTRA = value;
      break;
    case 'LABEL_STACK_GAP':
      LABEL_STACK_GAP = value;
      break;
    case 'LABEL_MAX_ROWS':
      LABEL_MAX_ROWS = value;
      break;
    case 'LABEL_POI_ICON_SIZE':
      LABEL_POI_ICON_SIZE = value;
      break;
    case 'LABEL_POI_ICON_GAP':
      LABEL_POI_ICON_GAP = value;
      break;
    case 'INFO_PANEL_H':
      INFO_PANEL_H = value;
      break;
    case 'LEGEND_INNER_W':
      LEGEND_INNER_W = value;
      break;
    case 'LEGEND_VERT_PAD':
      LEGEND_VERT_PAD = value;
      break;
    case 'LEGEND_ICON_TOP':
      LEGEND_ICON_TOP = value;
      break;
    case 'LEGEND_ICON_SIZE':
      LEGEND_ICON_SIZE = value;
      break;
    case 'LEGEND_ICON_TEXT_GAP':
      LEGEND_ICON_TEXT_GAP = value;
      break;
    case 'MAP_STOP_ICON_SIZE':
      MAP_STOP_ICON_SIZE = value;
      break;
    case 'QR_MAX_SIZE':
      QR_MAX_SIZE = value;
      break;
    case 'QR_PAD':
      QR_PAD = value;
      break;
    case 'C':
      C = { ...C, ...value };
      break;
    case 'FONT':
      FONT = value;
      break;
    case 'FONT_KN':
      FONT_KN = value;
      break;
    default:
      break;
  }
}

// ── Theme resetter ───────────────────────────────────────────────────────
export function resetTheme() {
  SVG_WIDTH = DEFAULTS.SVG_WIDTH;
  SVG_ASPECT = DEFAULTS.SVG_ASPECT;
  HDR1_H = DEFAULTS.HDR1_H;
  HEADER_LOGO_X = DEFAULTS.HEADER_LOGO_X;
  HEADER_LOGO_Y = DEFAULTS.HEADER_LOGO_Y;
  HEADER_LOGO_W = DEFAULTS.HEADER_LOGO_W;
  HEADER_LOGO_H = DEFAULTS.HEADER_LOGO_H;
  HEADER_NAME_X = DEFAULTS.HEADER_NAME_X;
  HDR_KN_Y = DEFAULTS.HDR_KN_Y;
  HDR_KN_SIZE = DEFAULTS.HDR_KN_SIZE;
  HDR_KN_EN_Y = DEFAULTS.HDR_KN_EN_Y;
  HDR_KN_EN_SIZE = DEFAULTS.HDR_KN_EN_SIZE;
  HDR_KN_TOWARDS_Y = DEFAULTS.HDR_KN_TOWARDS_Y;
  HDR_KN_TOWARDS_SIZE = DEFAULTS.HDR_KN_TOWARDS_SIZE;
  HDR_EN_Y = DEFAULTS.HDR_EN_Y;
  HDR_EN_SIZE = DEFAULTS.HDR_EN_SIZE;
  HDR_EN_TOWARDS_Y = DEFAULTS.HDR_EN_TOWARDS_Y;
  HDR_EN_TOWARDS_SIZE = DEFAULTS.HDR_EN_TOWARDS_SIZE;
  BADGE_H = DEFAULTS.BADGE_H;
  BADGE_GAP_X = DEFAULTS.BADGE_GAP_X;
  BADGE_TOP_PAD = DEFAULTS.BADGE_TOP_PAD;
  BADGE_BOT_PAD = DEFAULTS.BADGE_BOT_PAD;
  BADGE_PADDING_H = DEFAULTS.BADGE_PADDING_H;
  BADGE_ROW_MARGIN = DEFAULTS.BADGE_ROW_MARGIN;
  BADGE_INNER_GAP = DEFAULTS.BADGE_INNER_GAP;
  BADGE_ICON_TEXT_GAP = DEFAULTS.BADGE_ICON_TEXT_GAP;
  BADGE_CHAR_SCALE = DEFAULTS.BADGE_CHAR_SCALE;
  BUS_ICON_W = DEFAULTS.BUS_ICON_W;
  BUS_ICON_H = DEFAULTS.BUS_ICON_H;
  BADGE_FONT_SIZE = DEFAULTS.BADGE_FONT_SIZE;
  DIAGRAM_TOP_PAD = DEFAULTS.DIAGRAM_TOP_PAD;
  CLUSTER_SPACING = DEFAULTS.CLUSTER_SPACING;
  CLUSTER_LABEL_BAND = DEFAULTS.CLUSTER_LABEL_BAND;
  BRANCH_CORNER_R = DEFAULTS.BRANCH_CORNER_R;
  ROUTE_LINE_START_X = DEFAULTS.ROUTE_LINE_START_X;
  ROUTE_AREA_END_PCT = DEFAULTS.ROUTE_AREA_END_PCT;
  ROUTE_LINE_MIN_EXTEND = DEFAULTS.ROUTE_LINE_MIN_EXTEND;
  STOP_SPACING_MIN = DEFAULTS.STOP_SPACING_MIN;
  STOP_SPACING_MAX = DEFAULTS.STOP_SPACING_MAX;
  LABEL_AREA_END_X = DEFAULTS.LABEL_AREA_END_X;
  LABEL_GAP = DEFAULTS.LABEL_GAP;
  LABEL_BOX_H = DEFAULTS.LABEL_BOX_H;
  LABEL_BOX_RX = DEFAULTS.LABEL_BOX_RX;
  LABEL_BOX_FONT_SIZE = DEFAULTS.LABEL_BOX_FONT_SIZE;
  LABEL_BOX_CHAR_W = DEFAULTS.LABEL_BOX_CHAR_W;
  LABEL_BOX_PAD = DEFAULTS.LABEL_BOX_PAD;
  PILL_W_SMALL = DEFAULTS.PILL_W_SMALL;
  PILL_OVERHANG = DEFAULTS.PILL_OVERHANG;
  TERMINAL_RADIUS = DEFAULTS.TERMINAL_RADIUS;
  CURRENT_PILL_W = DEFAULTS.CURRENT_PILL_W;
  DIAGRAM_BOTTOM_PAD = DEFAULTS.DIAGRAM_BOTTOM_PAD;
  LABEL_ROT = DEFAULTS.LABEL_ROT;
  LABEL_FONT_SIZE = DEFAULTS.LABEL_FONT_SIZE;
  LABEL_CHAR_WIDTH = DEFAULTS.LABEL_CHAR_WIDTH;
  LABEL_ROW_OFFSET = DEFAULTS.LABEL_ROW_OFFSET;
  LABEL_ICON_GAP = DEFAULTS.LABEL_ICON_GAP;
  LABEL_MAX_LINE_CHARS = DEFAULTS.LABEL_MAX_LINE_CHARS;
  LABEL_HORIZ_GAP = DEFAULTS.LABEL_HORIZ_GAP;
  LABEL_LINE_SPACING_EXTRA = DEFAULTS.LABEL_LINE_SPACING_EXTRA;
  LABEL_STACK_GAP = DEFAULTS.LABEL_STACK_GAP;
  LABEL_MAX_ROWS = DEFAULTS.LABEL_MAX_ROWS;
  LABEL_POI_ICON_SIZE = DEFAULTS.LABEL_POI_ICON_SIZE;
  LABEL_POI_ICON_GAP = DEFAULTS.LABEL_POI_ICON_GAP;
  INFO_PANEL_H = DEFAULTS.INFO_PANEL_H;
  LEGEND_INNER_W = DEFAULTS.LEGEND_INNER_W;
  LEGEND_VERT_PAD = DEFAULTS.LEGEND_VERT_PAD;
  LEGEND_ICON_TOP = DEFAULTS.LEGEND_ICON_TOP;
  LEGEND_ICON_SIZE = DEFAULTS.LEGEND_ICON_SIZE;
  LEGEND_ICON_TEXT_GAP = DEFAULTS.LEGEND_ICON_TEXT_GAP;
  MAP_STOP_ICON_SIZE = DEFAULTS.MAP_STOP_ICON_SIZE;
  QR_MAX_SIZE = DEFAULTS.QR_MAX_SIZE;
  QR_PAD = DEFAULTS.QR_PAD;
  C = { ...DEFAULTS.C };
  FONT = DEFAULTS.FONT;
  FONT_KN = DEFAULTS.FONT_KN;
}
