import { formatUnits } from 'viem';
import { DecimalPrecisionError, InvalidDecimalError } from './errors';

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Converts an API decimal string (human units, e.g. `"1250.5"`) into base-unit
 * bigint at the given token decimals (e.g. `1250500000n` for 6 decimals).
 *
 * The conversion is exact: a value with more significant fractional digits
 * than `decimals` throws `DecimalPrecisionError` rather than rounding.
 * Hand-rolled instead of viem's `parseUnits`, which silently rounds excess
 * precision (`parseUnits('1.0000005', 6)` → `1000001n`) — unacceptable for
 * financial amounts.
 */
export function decimalToBigInt(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new InvalidDecimalError(`decimals=${decimals}`);
  }
  const match = DECIMAL_RE.exec(value);
  if (!match) throw new InvalidDecimalError(value);

  const [, sign, whole, frac = ''] = match;
  if (frac.length > decimals && !/^0*$/.test(frac.slice(decimals))) {
    throw new DecimalPrecisionError(value, decimals);
  }

  const scaled = BigInt(whole + frac.slice(0, decimals).padEnd(decimals, '0'));
  return sign === '-' ? -scaled : scaled;
}

/**
 * Formats a base-unit bigint back into the API's human decimal-string
 * representation (no trailing fractional zeros, no exponent notation).
 */
export function bigIntToDecimal(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new InvalidDecimalError(`decimals=${decimals}`);
  }
  return formatUnits(value, decimals);
}

/** Vault shares are always reported in 18-decimal units by the Gaia API. */
export const SHARE_DECIMALS = 18;

/** Parses an API share amount (decimal string) into base-unit bigint (1e18). */
export function sharesToBigInt(value: string): bigint {
  return decimalToBigInt(value, SHARE_DECIMALS);
}
