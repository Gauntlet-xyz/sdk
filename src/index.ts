export { GauntletClient, AttributionMode } from './client';
export type { GauntletClientConfig } from './client';

export type {
  VaultInfo,
  VaultDeployment,
  EvmVaultDeployment,
  TokenInfo,
  VaultManifest,
} from './evm/types';
export type { VaultFilter } from './evm/vaults';

export { getDepositTx } from './evm/deposit';
export { getWithdrawTx } from './evm/withdraw';
export { getUserCurrentBalance } from './evm/userCurrentBalance';
export { getVaults, VaultId } from './evm/vaults';

export type { EvmDepositParams } from './evm/deposit';
export type { EvmWithdrawParams } from './evm/withdraw';
export type { EvmTxStep } from './evm/adapters/types';
export type { UserCurrentBalanceParams, UserCurrentBalance } from './evm/userCurrentBalance';
export type { PreparedTx } from './attribution';

export {
  GauntletSDKError,
  VaultNotFoundError,
  UnsupportedAssetError,
  ChainMismatchError,
  UnsupportedDepositModeError,
  RpcNotConfiguredError,
  AccountRequiredError,
  UnsupportedProtocolError,
  InvalidWithdrawParamsError,
  UnimplementedFeatureError,
  UnitConversionError,
} from './errors';
