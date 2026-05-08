import { toHex, type Hex } from 'viem';

// 16-byte ERC-8021 marker: "8021" repeated 8 times
const ERC8021_MARKER = '80218021802180218021802180218021' as const;
const ERC8021_SCHEMA_ID = '00' as const; // Schema 0: simple ASCII codes

/**
 * Encode an ERC-8021 builder code as a calldata suffix.
 * Format: utf8-encoded builder code + codesLength (1 byte) + schemaId (1 byte) + ERC marker (16 bytes)
 *
 * @see https://eips.ethereum.org/EIPS/eip-8021
 */
export function encodeBuilderCode(builderCode: string): Hex {
  const codeHex = toHex(builderCode).slice(2); // UTF-8 hex without 0x prefix
  const codeByteLen = codeHex.length / 2;
  const codeLengthHex = codeByteLen.toString(16).padStart(2, '0');
  return `0x${codeHex}${codeLengthHex}${ERC8021_SCHEMA_ID}${ERC8021_MARKER}` as Hex;
}
