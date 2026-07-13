import { describe, expect, it } from 'vitest';
import { bigIntToDecimal, decimalToBigInt, sharesToBigInt } from '../../src/api/decimal';
import { DecimalPrecisionError, InvalidDecimalError } from '../../src/api/errors';

describe('decimalToBigInt', () => {
  it('scales human decimals to base units', () => {
    expect(decimalToBigInt('1250.5', 6)).toBe(1250500000n);
    expect(decimalToBigInt('0', 6)).toBe(0n);
    expect(decimalToBigInt('100', 6)).toBe(100000000n);
    expect(decimalToBigInt('0.000001', 6)).toBe(1n);
  });

  it('handles negative values (signed activity deltas)', () => {
    expect(decimalToBigInt('-1250.5', 6)).toBe(-1250500000n);
    expect(decimalToBigInt('-0.000001', 6)).toBe(-1n);
  });

  it('handles zero-decimal tokens', () => {
    expect(decimalToBigInt('42', 0)).toBe(42n);
  });

  it('accepts lossless trailing zeros beyond the token decimals', () => {
    expect(decimalToBigInt('1.230000000', 6)).toBe(1230000n);
  });

  it('throws instead of rounding excess precision', () => {
    expect(() => decimalToBigInt('1.2345678', 6)).toThrow(DecimalPrecisionError);
  });

  it('rejects malformed values', () => {
    for (const bad of ['', 'abc', '1e18', '1.', '.5', '1,000', 'NaN']) {
      expect(() => decimalToBigInt(bad, 6), bad).toThrow(InvalidDecimalError);
    }
  });
});

describe('bigIntToDecimal', () => {
  it('formats base units back to human decimals', () => {
    expect(bigIntToDecimal(1250500000n, 6)).toBe('1250.5');
    expect(bigIntToDecimal(1n, 6)).toBe('0.000001');
    expect(bigIntToDecimal(-1n, 6)).toBe('-0.000001');
    expect(bigIntToDecimal(0n, 6)).toBe('0');
    expect(bigIntToDecimal(42n, 0)).toBe('42');
  });

  it('round-trips with decimalToBigInt', () => {
    for (const value of ['0', '1', '-1', '1250.5', '0.000001', '-987654.321']) {
      expect(bigIntToDecimal(decimalToBigInt(value, 6), 6)).toBe(value);
    }
  });
});

describe('sharesToBigInt', () => {
  it('parses 18-decimal share amounts', () => {
    expect(sharesToBigInt('95.25')).toBe(95_250000000000000000n);
    expect(sharesToBigInt('-50')).toBe(-50_000000000000000000n);
  });
});
