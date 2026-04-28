import { toHex, type Hex } from 'viem';

const ERC8021_PREFIX = '8021' as const;

/**
 * Encode an ERC-8021 builder code as a calldata suffix.
 * Format: "8021" marker + utf8-encoded builder code
 *
 * @see https://eips.ethereum.org/EIPS/eip-8021
 */
export function encodeBuilderCode(builderCode: string): Hex {
  const codeHex = toHex(builderCode).slice(2); // remove 0x prefix
  return `0x${ERC8021_PREFIX}${codeHex}` as Hex;
}
