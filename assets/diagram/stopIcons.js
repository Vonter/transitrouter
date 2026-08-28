export const STOP_ICON_OPTIONS = [
  { type: 'metro', label: 'Metro', glyph: 'M' },
  { type: 'bus', label: 'Bus', glyph: 'B' },
  { type: 'railway', label: 'Rail', glyph: 'R' },
  { type: 'airport', label: 'Airport', glyph: '✈' },
];

export const STOP_ICON_ORDER = STOP_ICON_OPTIONS.map(({ type }) => type);

export const orderedStopIconTypes = (types) =>
  STOP_ICON_ORDER.filter((type) => types.includes(type));
