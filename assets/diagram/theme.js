// ════════════════════════════════════════════════════════════════════════════
// Theme — centralised design tokens for the transit diagram.
// Edit this file to tweak sizes, colours and typography.
// ════════════════════════════════════════════════════════════════════════════

// ── Canvas ────────────────────────────────────────────────────────────────────
export let SVG_WIDTH = 660;

// ── Header ────────────────────────────────────────────────────────────────────
export let HDR1_H = 82; // Main header height (stop name + logo)
export let HEADER_LOGO_X = 16; // Logo X position
export let HEADER_LOGO_Y = 17; // Logo Y position
export let HEADER_LOGO_W = 48; // Logo width
export let HEADER_LOGO_H = 48; // Logo height
export let HEADER_NAME_X = 80; // Stop name text X position

// Header text — Kannada mode (Kannada name shown large, English as subtitle)
export let HDR_KN_Y = 34; // Y for Kannada stop name
export let HDR_KN_SIZE = 30; // Font size for Kannada stop name
export let HDR_KN_EN_Y = 58; // Y for English name (below Kannada)
export let HDR_KN_EN_SIZE = 12; // Font size for English subtitle
export let HDR_KN_TOWARDS_Y = 76; // Y for "towards" text (Kannada mode)
export let HDR_KN_TOWARDS_SIZE = 24; // Font size for "towards" (Kannada mode)

// Header text — English-only mode
export let HDR_EN_Y = 38; // Y for English stop name
export let HDR_EN_SIZE = 28; // Font size for English stop name
export let HDR_EN_TOWARDS_Y = 64; // Y for "towards" text (English mode)
export let HDR_EN_TOWARDS_SIZE = 22; // Font size for "towards" (English mode)

// ── Route badges ──────────────────────────────────────────────────────────────
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

// ── Route diagram ─────────────────────────────────────────────────────────────
export let LABEL_SPACE = 120; // Vertical space reserved for rotated stop labels
export let MAX_STOP_STEP_PCT = 6; // Max spacing between adjacent stops as % of diagram width
export let CLUSTER_SPACING = 44; // Minimum vertical distance between cluster lines
export let TARGET_CLUSTER_SPAN = 240; // Target total vertical span for all cluster lines
export let MAX_CLUSTER_SPACING = 80; // Cap on cluster spacing for very few clusters
export let ROUTE_LINE_START_X = 112; // X where route lines begin
export let ROUTE_AREA_END_PCT = 0.9; // Fraction of SVG_WIDTH where route area ends
export let ROUTE_LINE_MIN_EXTEND = 24; // Min px a route line extends into the diagram
export let STOP_SPACING = 32; // Fixed horizontal gap between stops
export let LABEL_AREA_END_X = 100; // Route label boxes right-align to this x
export let LABEL_GAP = 2; // Gap between adjacent route label boxes
export let LABEL_BOX_H = 14; // Height of a route label box
export let LABEL_BOX_RX = 2; // Border radius of route label box
export let LABEL_BOX_FONT_SIZE = 10; // Font size inside route ID label boxes
export let LABEL_BOX_CHAR_W = 7.5; // Approx char width for label box sizing/truncation
export let LABEL_BOX_PAD = 4; // Padding subtracted when computing truncation chars
export let PILL_W_BIG = 12; // Width of stop marker pill for stops shared across clusters
export let PILL_W_SMALL = 8; // Width of stop marker pill for stops unique to one cluster
export let PILL_OVERHANG = 6; // Pill extends beyond first/last cluster line
export let TERMINAL_RADIUS = 7; // Radius of terminal stop circle icon
export let CURRENT_PILL_X = 102; // Left edge of current-stop pill
export let CURRENT_PILL_W = 8; // Width of current-stop pill
export let CURRENT_PILL_TOP_PAD = 5; // Px the current-stop pill extends above the first cluster
export let DIAGRAM_BOTTOM_PAD = 50; // Space below last cluster line
export let EXTRA_BOTTOM_PCT = 0.1; // Extra bottom padding as fraction of total height

// ── Stop labels ───────────────────────────────────────────────────────────────
export let LABEL_ROT = -35; // Rotation in degrees (negative = counter-clockwise)
export let LABEL_FONT_SIZE = 9; // Font size for stop labels
export let LABEL_CHAR_WIDTH = 5.5; // Approx character width used for overlap detection
export let LABEL_ROW_OFFSET = 13; // Extra y-offset per additional label row (upward)
export let LABEL_ICON_GAP = 6; // Breathing room between stop icon edge and label start
export let LABEL_MAX_DIST = 45; // Hard limit: label anchor never more than this many px from stop icon
export let LABEL_MAX_LINE_CHARS = 20; // Max characters per line before wrapping a stop label
export let LABEL_HORIZ_GAP = 8; // Min horizontal gap between adjacent labels in the same row
export let LABEL_LINE_SPACING_EXTRA = 3; // Extra px added to font size for multi-line label line-height
export let LABEL_ANCHOR_CLAMP = 10; // Max px label anchor is offset from the stop marker

// ── Branch connectors ─────────────────────────────────────────────────────────
export let BRANCH_STROKE_W = 3; // Stroke width for branch connector lines
export let MIN_SHARED_FOR_BRANCH = 2; // Minimum shared stops to show a branch connector

// ── Info panel ────────────────────────────────────────────────────────────────
export let INFO_PANEL_H = 180; // Panel height
export let LEGEND_INNER_W = 95; // Width of the legend content column
export let LEGEND_VERT_PAD = 10; // Vertical padding inside the legend section
export let LEGEND_ICON_TOP = 5; // Top offset for the first legend item
export let LEGEND_ICON_SIZE = 12; // Legend icon size (px)
export let LEGEND_ICON_TEXT_GAP = 4; // Gap between legend icon and its text label
export let QR_MAX_SIZE = 140; // Max QR code side length (px)
export let QR_PAD = 20; // Padding inside QR section used to cap QR size

// ── Colours ───────────────────────────────────────────────────────────────────
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

// ── Default snapshot (used by resetTheme and ExpertPanel initialisation) ──────
export const DEFAULTS = {
  SVG_WIDTH: 660,
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
  LABEL_SPACE: 120,
  MAX_STOP_STEP_PCT: 6,
  CLUSTER_SPACING: 44,
  TARGET_CLUSTER_SPAN: 240,
  MAX_CLUSTER_SPACING: 80,
  ROUTE_LINE_START_X: 112,
  ROUTE_AREA_END_PCT: 0.9,
  ROUTE_LINE_MIN_EXTEND: 24,
  STOP_SPACING: 32,
  LABEL_AREA_END_X: 100,
  LABEL_GAP: 2,
  LABEL_BOX_H: 14,
  LABEL_BOX_RX: 2,
  LABEL_BOX_FONT_SIZE: 10,
  LABEL_BOX_CHAR_W: 7.5,
  LABEL_BOX_PAD: 4,
  PILL_W_BIG: 12,
  PILL_W_SMALL: 8,
  PILL_OVERHANG: 6,
  TERMINAL_RADIUS: 7,
  CURRENT_PILL_X: 102,
  CURRENT_PILL_W: 8,
  CURRENT_PILL_TOP_PAD: 5,
  DIAGRAM_BOTTOM_PAD: 50,
  EXTRA_BOTTOM_PCT: 0.1,
  LABEL_ROT: -35,
  LABEL_FONT_SIZE: 9,
  LABEL_CHAR_WIDTH: 5.5,
  LABEL_ROW_OFFSET: 13,
  LABEL_ICON_GAP: 6,
  LABEL_MAX_DIST: 45,
  LABEL_MAX_LINE_CHARS: 20,
  LABEL_HORIZ_GAP: 8,
  LABEL_LINE_SPACING_EXTRA: 3,
  LABEL_ANCHOR_CLAMP: 10,
  BRANCH_STROKE_W: 3,
  MIN_SHARED_FOR_BRANCH: 2,
  INFO_PANEL_H: 180,
  LEGEND_INNER_W: 95,
  LEGEND_VERT_PAD: 10,
  LEGEND_ICON_TOP: 5,
  LEGEND_ICON_SIZE: 12,
  LEGEND_ICON_TEXT_GAP: 4,
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

// ── Current values snapshot (reads live bindings) ─────────────────────────────
export function getCurrentThemeValues() {
  return {
    SVG_WIDTH,
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
    LABEL_SPACE,
    MAX_STOP_STEP_PCT,
    CLUSTER_SPACING,
    TARGET_CLUSTER_SPAN,
    MAX_CLUSTER_SPACING,
    ROUTE_LINE_START_X,
    ROUTE_AREA_END_PCT,
    ROUTE_LINE_MIN_EXTEND,
    STOP_SPACING,
    LABEL_AREA_END_X,
    LABEL_GAP,
    LABEL_BOX_H,
    LABEL_BOX_RX,
    LABEL_BOX_FONT_SIZE,
    LABEL_BOX_CHAR_W,
    LABEL_BOX_PAD,
    PILL_W_BIG,
    PILL_W_SMALL,
    PILL_OVERHANG,
    TERMINAL_RADIUS,
    CURRENT_PILL_X,
    CURRENT_PILL_W,
    CURRENT_PILL_TOP_PAD,
    DIAGRAM_BOTTOM_PAD,
    EXTRA_BOTTOM_PCT,
    LABEL_ROT,
    LABEL_FONT_SIZE,
    LABEL_CHAR_WIDTH,
    LABEL_ROW_OFFSET,
    LABEL_ICON_GAP,
    LABEL_MAX_DIST,
    LABEL_MAX_LINE_CHARS,
    LABEL_HORIZ_GAP,
    LABEL_LINE_SPACING_EXTRA,
    LABEL_ANCHOR_CLAMP,
    BRANCH_STROKE_W,
    MIN_SHARED_FOR_BRANCH,
    INFO_PANEL_H,
    LEGEND_INNER_W,
    LEGEND_VERT_PAD,
    LEGEND_ICON_TOP,
    LEGEND_ICON_SIZE,
    LEGEND_ICON_TEXT_GAP,
    QR_MAX_SIZE,
    QR_PAD,
    C: { ...C },
    FONT,
    FONT_KN,
  };
}

// ── Theme patcher (updates live module bindings) ───────────────────────────────
export function patchTheme(key, value) {
  switch (key) {
    case 'SVG_WIDTH':
      SVG_WIDTH = value;
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
    case 'LABEL_SPACE':
      LABEL_SPACE = value;
      break;
    case 'MAX_STOP_STEP_PCT':
      MAX_STOP_STEP_PCT = value;
      break;
    case 'CLUSTER_SPACING':
      CLUSTER_SPACING = value;
      break;
    case 'TARGET_CLUSTER_SPAN':
      TARGET_CLUSTER_SPAN = value;
      break;
    case 'MAX_CLUSTER_SPACING':
      MAX_CLUSTER_SPACING = value;
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
    case 'STOP_SPACING':
      STOP_SPACING = value;
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
    case 'PILL_W_BIG':
      PILL_W_BIG = value;
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
    case 'CURRENT_PILL_X':
      CURRENT_PILL_X = value;
      break;
    case 'CURRENT_PILL_W':
      CURRENT_PILL_W = value;
      break;
    case 'CURRENT_PILL_TOP_PAD':
      CURRENT_PILL_TOP_PAD = value;
      break;
    case 'DIAGRAM_BOTTOM_PAD':
      DIAGRAM_BOTTOM_PAD = value;
      break;
    case 'EXTRA_BOTTOM_PCT':
      EXTRA_BOTTOM_PCT = value;
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
    case 'LABEL_MAX_DIST':
      LABEL_MAX_DIST = value;
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
    case 'LABEL_ANCHOR_CLAMP':
      LABEL_ANCHOR_CLAMP = value;
      break;
    case 'BRANCH_STROKE_W':
      BRANCH_STROKE_W = value;
      break;
    case 'MIN_SHARED_FOR_BRANCH':
      MIN_SHARED_FOR_BRANCH = value;
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

// ── Theme resetter ─────────────────────────────────────────────────────────────
export function resetTheme() {
  SVG_WIDTH = DEFAULTS.SVG_WIDTH;
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
  LABEL_SPACE = DEFAULTS.LABEL_SPACE;
  MAX_STOP_STEP_PCT = DEFAULTS.MAX_STOP_STEP_PCT;
  CLUSTER_SPACING = DEFAULTS.CLUSTER_SPACING;
  TARGET_CLUSTER_SPAN = DEFAULTS.TARGET_CLUSTER_SPAN;
  MAX_CLUSTER_SPACING = DEFAULTS.MAX_CLUSTER_SPACING;
  ROUTE_LINE_START_X = DEFAULTS.ROUTE_LINE_START_X;
  ROUTE_AREA_END_PCT = DEFAULTS.ROUTE_AREA_END_PCT;
  ROUTE_LINE_MIN_EXTEND = DEFAULTS.ROUTE_LINE_MIN_EXTEND;
  STOP_SPACING = DEFAULTS.STOP_SPACING;
  LABEL_AREA_END_X = DEFAULTS.LABEL_AREA_END_X;
  LABEL_GAP = DEFAULTS.LABEL_GAP;
  LABEL_BOX_H = DEFAULTS.LABEL_BOX_H;
  LABEL_BOX_RX = DEFAULTS.LABEL_BOX_RX;
  LABEL_BOX_FONT_SIZE = DEFAULTS.LABEL_BOX_FONT_SIZE;
  LABEL_BOX_CHAR_W = DEFAULTS.LABEL_BOX_CHAR_W;
  LABEL_BOX_PAD = DEFAULTS.LABEL_BOX_PAD;
  PILL_W_BIG = DEFAULTS.PILL_W_BIG;
  PILL_W_SMALL = DEFAULTS.PILL_W_SMALL;
  PILL_OVERHANG = DEFAULTS.PILL_OVERHANG;
  TERMINAL_RADIUS = DEFAULTS.TERMINAL_RADIUS;
  CURRENT_PILL_X = DEFAULTS.CURRENT_PILL_X;
  CURRENT_PILL_W = DEFAULTS.CURRENT_PILL_W;
  CURRENT_PILL_TOP_PAD = DEFAULTS.CURRENT_PILL_TOP_PAD;
  DIAGRAM_BOTTOM_PAD = DEFAULTS.DIAGRAM_BOTTOM_PAD;
  EXTRA_BOTTOM_PCT = DEFAULTS.EXTRA_BOTTOM_PCT;
  LABEL_ROT = DEFAULTS.LABEL_ROT;
  LABEL_FONT_SIZE = DEFAULTS.LABEL_FONT_SIZE;
  LABEL_CHAR_WIDTH = DEFAULTS.LABEL_CHAR_WIDTH;
  LABEL_ROW_OFFSET = DEFAULTS.LABEL_ROW_OFFSET;
  LABEL_ICON_GAP = DEFAULTS.LABEL_ICON_GAP;
  LABEL_MAX_DIST = DEFAULTS.LABEL_MAX_DIST;
  LABEL_MAX_LINE_CHARS = DEFAULTS.LABEL_MAX_LINE_CHARS;
  LABEL_HORIZ_GAP = DEFAULTS.LABEL_HORIZ_GAP;
  LABEL_LINE_SPACING_EXTRA = DEFAULTS.LABEL_LINE_SPACING_EXTRA;
  LABEL_ANCHOR_CLAMP = DEFAULTS.LABEL_ANCHOR_CLAMP;
  BRANCH_STROKE_W = DEFAULTS.BRANCH_STROKE_W;
  MIN_SHARED_FOR_BRANCH = DEFAULTS.MIN_SHARED_FOR_BRANCH;
  INFO_PANEL_H = DEFAULTS.INFO_PANEL_H;
  LEGEND_INNER_W = DEFAULTS.LEGEND_INNER_W;
  LEGEND_VERT_PAD = DEFAULTS.LEGEND_VERT_PAD;
  LEGEND_ICON_TOP = DEFAULTS.LEGEND_ICON_TOP;
  LEGEND_ICON_SIZE = DEFAULTS.LEGEND_ICON_SIZE;
  LEGEND_ICON_TEXT_GAP = DEFAULTS.LEGEND_ICON_TEXT_GAP;
  QR_MAX_SIZE = DEFAULTS.QR_MAX_SIZE;
  QR_PAD = DEFAULTS.QR_PAD;
  C = { ...DEFAULTS.C };
  FONT = DEFAULTS.FONT;
  FONT_KN = DEFAULTS.FONT_KN;
}
