export const DEFAULT_BRANCH_CONFIG = Object.freeze({
  angle: 45,
  length: 100,
});

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, number))
    : fallback;
};

export function normalizeBranchConfig(config) {
  return {
    angle: clamp(config?.angle, 15, 75, DEFAULT_BRANCH_CONFIG.angle),
    length: clamp(config?.length, 40, 200, DEFAULT_BRANCH_CONFIG.length),
  };
}

export function isDefaultBranchConfig(config) {
  const value = normalizeBranchConfig(config);
  return (
    value.angle === DEFAULT_BRANCH_CONFIG.angle &&
    value.length === DEFAULT_BRANCH_CONFIG.length
  );
}

export function branchTransitionRun(verticalChange, availableWidth, config) {
  const { angle, length } = normalizeBranchConfig(config);
  const angleRun =
    Math.abs(verticalChange) / Math.tan((angle * Math.PI) / 180);
  return Math.max(8, Math.min((angleRun * length) / 100, availableWidth));
}
