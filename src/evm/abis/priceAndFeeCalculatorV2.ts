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
    inputs: [{ name: 'vault', internalType: 'address', type: 'address' }],
    name: 'getVaultState',
    outputs: [
      {
        name: '',
        internalType: 'struct VaultPriceStateV2',
        type: 'tuple',
        components: [
          { name: 'paused', internalType: 'bool', type: 'bool' },
          { name: 'pauseOnBadAnchorUpdate', internalType: 'bool', type: 'bool' },
          { name: 'maxPriceAge', internalType: 'uint16', type: 'uint16' },
          { name: 'minUpdateIntervalMinutes', internalType: 'uint16', type: 'uint16' },
          { name: 'maxPriceToleranceRatio', internalType: 'uint16', type: 'uint16' },
          { name: 'minPriceToleranceRatio', internalType: 'uint16', type: 'uint16' },
          { name: 'maxUpdateDelayDays', internalType: 'uint8', type: 'uint8' },
          { name: 'accrualLag', internalType: 'uint32', type: 'uint32' },
          { name: 'anchorTimestamp', internalType: 'uint32', type: 'uint32' },
          { name: 'driftTimestamp', internalType: 'uint32', type: 'uint32' },
          { name: 'anchorPrice', internalType: 'uint128', type: 'uint128' },
          { name: 'driftPrice', internalType: 'uint128', type: 'uint128' },
          { name: 'highestPrice', internalType: 'uint128', type: 'uint128' },
          { name: 'lastTotalSupply', internalType: 'uint128', type: 'uint128' },
        ],
      },
      {
        name: '',
        internalType: 'struct VaultAccruals',
        type: 'tuple',
        components: [
          {
            name: 'fees',
            internalType: 'struct Fee',
            type: 'tuple',
            components: [
              { name: 'tvl', internalType: 'uint16', type: 'uint16' },
              { name: 'performance', internalType: 'uint16', type: 'uint16' },
            ],
          },
          { name: 'accruedFees', internalType: 'uint112', type: 'uint112' },
          { name: 'accruedProtocolFees', internalType: 'uint112', type: 'uint112' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'vault', internalType: 'address', type: 'address' }],
    name: 'isVaultPaused',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
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
