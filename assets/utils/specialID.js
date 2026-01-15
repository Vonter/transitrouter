// MapLibre GL JS varint limit is approximately 2^63, but JavaScript safe integer
// limit is 2^53. We use a conservative limit to avoid varint encoding issues.
const VARINT_SAFE_LIMIT = 9007199254740991; // Number.MAX_SAFE_INTEGER

// Store reverse mapping for IDs that exceed varint limits
// This is a simple in-memory cache that persists during the session
const idReverseMap = new Map();

// Fast FNV-1a hash function (32-bit) - optimized for performance
const fnv1a32 = (str) => {
  let hash = 2166136261; // FNV offset basis
  const fnvPrime = 16777619; // FNV prime for 32-bit
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // Standard FNV-1a multiplication (JS engines optimize this well)
    hash = (hash * fnvPrime) >>> 0; // Force to 32-bit unsigned
  }
  return hash;
};

// Estimate if old encoding will exceed varint limit based on string length
// Each alphanumeric char produces 2-3 digit char code (48-122)
// Worst case: 3 digits per char, so 3n digits = 10^(3n) as a number
// We want 10^(3n) < VARINT_SAFE_LIMIT, so 3n < log10(VARINT_SAFE_LIMIT) ≈ 15.95
// Therefore n < 5.3, so we use n <= 5 as safe threshold
// For n > 5, we check more carefully, but n > 10 will almost certainly fail
const willOldEncodingExceedLimit = (str) => {
  // Quick check: if string is very short, old encoding will definitely work
  if (str.length <= 5) return false;
  // If string is very long, old encoding will definitely fail
  if (str.length > 10) return true;
  // For medium lengths, estimate: assume average 2.5 digits per char
  // 2.5 * length digits = 10^(2.5*length) as number
  // Check if 10^(2.5*length) > VARINT_SAFE_LIMIT
  const estimatedDigits = Math.ceil(str.length * 2.5);
  return estimatedDigits > 15; // log10(VARINT_SAFE_LIMIT) ≈ 15.95
};

// Optimized old encoding - direct string building instead of regex
const oldEncode = (str) => {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122)
    ) {
      result += code;
    }
  }
  return result ? parseInt(result, 10) : NaN;
};

// Fast old decode - optimized path without regex where possible
const oldDecode = (numStr) => {
  // Old encoding uses pairs of digits (char codes)
  // Try to decode by splitting into 2-3 digit groups
  const charCodes = [];
  let i = 0;

  while (i < numStr.length) {
    // Try 2-digit code first (most common: 48-122)
    if (i + 2 <= numStr.length) {
      const code2 = parseInt(numStr.substr(i, 2), 10);
      if (code2 >= 32 && code2 <= 126) {
        charCodes.push(code2);
        i += 2;
        continue;
      }
    }
    // Try 3-digit code (for codes 100-126)
    if (i + 3 <= numStr.length) {
      const code3 = parseInt(numStr.substr(i, 3), 10);
      if (code3 >= 100 && code3 <= 126) {
        charCodes.push(code3);
        i += 3;
        continue;
      }
    }
    // If neither works, skip one digit and try again
    i++;
  }

  return charCodes.length > 0 ? String.fromCharCode(...charCodes) : null;
};

export const encode = (id) => {
  const str = String(id);

  // Fast path: for short identifiers, old encoding will work and is more efficient
  // Skip hash-based encoding entirely for short strings
  if (!willOldEncodingExceedLimit(str)) {
    const oldEncoded = oldEncode(str);
    // For short strings, old encoding should always work
    if (
      !isNaN(oldEncoded) &&
      oldEncoded > 0 &&
      oldEncoded <= VARINT_SAFE_LIMIT
    ) {
      return oldEncoded;
    }
  }

  // For longer identifiers, check if old encoding might still work
  // (some long strings with many non-alphanumeric chars might still encode small)
  if (str.length <= 15) {
    const oldEncoded = oldEncode(str);
    if (
      !isNaN(oldEncoded) &&
      oldEncoded > 0 &&
      oldEncoded <= VARINT_SAFE_LIMIT
    ) {
      return oldEncoded;
    }
  }

  // Only use hash-based encoding when necessary (long/complex IDs)
  let hash = fnv1a32(str);
  const baseHash = hash;

  // Handle collisions efficiently - use linear probing with a small limit
  let attempts = 0;
  const maxAttempts = 10;
  while (attempts < maxAttempts) {
    const normalizedHash = hash % VARINT_SAFE_LIMIT;
    const existing = idReverseMap.get(normalizedHash);
    if (existing === undefined) {
      // Slot is free
      idReverseMap.set(normalizedHash, str);
      return normalizedHash;
    } else if (existing === str) {
      // Already stored
      return normalizedHash;
    }
    // Collision - linear probe with better distribution
    hash = baseHash + attempts * 2654435761; // Golden ratio multiplier for better distribution
    attempts++;
  }

  // If all slots are taken, use the hash anyway (rare case)
  return baseHash % VARINT_SAFE_LIMIT;
};

export const decode = (number) => {
  // Fast path: check reverse map first (for hashed IDs from current session)
  const cached = idReverseMap.get(number);
  if (cached !== undefined) {
    return cached;
  }

  // Try old decoding method (optimized)
  const numStr = String(number);
  const decoded = oldDecode(numStr);
  if (decoded !== null) {
    // Quick verification: check if re-encoding matches (only for short strings)
    if (decoded.length <= 20) {
      const reencoded = oldEncode(decoded);
      if (reencoded === number) {
        return decoded;
      }
    }
  }

  // Fallback: return number as string
  return String(number);
};
