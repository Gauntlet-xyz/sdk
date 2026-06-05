// Compact ABI derived from aera-finance/aera-contracts-v3@f4e3433058c29c3a0b1348ffbd358cc036a1687f
// source: src/core/interfaces/IPriceAndFeeCalculatorV2.sol
export const priceAndFeeCalculatorV2Abi = [
  {
    type: 'function',
    inputs: [
      { name: 'vault', internalType: 'address', type: 'address' },
      { name: 'token', internalType: 'contract IERC20', type: 'address' },
      { name: 'tokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'convertTokenToUnits',
    outputs: [{ name: 'unitsAmount', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'vault', internalType: 'address', type: 'address' },
      { name: 'token', internalType: 'contract IERC20', type: 'address' },
      { name: 'tokenAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'rounding', internalType: 'enum Math.Rounding', type: 'uint8' },
    ],
    name: 'convertTokenToUnitsIfActive',
    outputs: [{ name: 'unitsAmount', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'vault', internalType: 'address', type: 'address' },
      { name: 'token', internalType: 'contract IERC20', type: 'address' },
      { name: 'unitsAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'convertUnitsToToken',
    outputs: [{ name: 'tokenAmount', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'vault', internalType: 'address', type: 'address' },
      { name: 'token', internalType: 'contract IERC20', type: 'address' },
      { name: 'unitsAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'rounding', internalType: 'enum Math.Rounding', type: 'uint8' },
    ],
    name: 'convertUnitsToTokenIfActive',
    outputs: [{ name: 'tokenAmount', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'vault', internalType: 'address', type: 'address' }],
    name: 'getAnchorTimestamp',
    outputs: [{ name: 'timestamp', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'version',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'pure',
  },
] as const;
