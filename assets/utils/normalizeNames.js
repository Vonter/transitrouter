import { getConfigForCity } from '../city-config';

/**
 * Default characters to remove when normalizing names
 */
const DEFAULT_NORMALIZE_CHARS = ['-', ' '];

/**
 * Normalizes a name by removing specified characters.
 * Used for comparing route names, stop names, etc. when searching or matching URLs.
 *
 * @param {string} name - The name to normalize
 * @param {string} cityCode - The city code to get normalization config from
 * @returns {string} The normalized name (lowercase with specified characters removed)
 */
export const normalizeName = (name, cityCode) => {
  if (!name) return '';

  const config = getConfigForCity(cityCode);
  const normalizeConfig = config?.normalizeNames;

  // If normalization is not enabled for this city, return lowercase name as-is
  if (!normalizeConfig?.enabled) {
    return name.toLowerCase();
  }

  const charsToRemove = normalizeConfig.removeChars || DEFAULT_NORMALIZE_CHARS;

  let normalized = name.toLowerCase();
  for (const char of charsToRemove) {
    normalized = normalized.split(char).join('');
  }

  return normalized;
};

/**
 * Compares two names using normalization rules for the specified city.
 *
 * @param {string} name1 - First name to compare
 * @param {string} name2 - Second name to compare
 * @param {string} cityCode - The city code to get normalization config from
 * @returns {boolean} True if the normalized names match
 */
export const compareNormalizedNames = (name1, name2, cityCode) => {
  return normalizeName(name1, cityCode) === normalizeName(name2, cityCode);
};
