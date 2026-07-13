export { GauntletClient, AttributionMode } from './client';
export type { GauntletClientConfig } from './client';
export { ContractVersion } from './evm/types';

export * from './api';

export type {
  VaultInfo,
  VaultDeployment,
  EvmVaultDeployment,
  TokenInfo,
  VaultManifest,
} from './evm/types';
export type { VaultFilter } from './evm/vaults';

export { getDepositTx } from './evm/deposit';
export { getDepositReceiverApprovalTx } from './evm/depositReceiverApproval';
export { getWithdrawTx } from './evm/withdraw';
export { getUserCurrentBalance } from './evm/userCurrentBalance';
export { getVaults, VaultId } from './evm/vaults';
export { resolveAeraRuntimeContracts, resolveContractVersion } from './evm/aeraContracts';
export {
  Rounding,
  convertTokenToUnits,
  convertTokenToUnitsIfActive,
  convertUnitsToToken,
  convertUnitsToTokenIfActive,
  getAnchorTimestamp,
  getVaultState,
  isVaultPaused,
} from './evm/aeraContracts/priceAndFeeCalculator';

export type { EvmDepositParams } from './evm/deposit';
export type { EvmDepositReceiverApprovalParams } from './evm/depositReceiverApproval';
export type { EvmWithdrawParams } from './evm/withdraw';
export type { EvmTxStep } from './evm/adapters/types';
export type { UserCurrentBalanceParams, UserCurrentBalance } from './evm/userCurrentBalance';
export type { PreparedTx } from './attribution';
export type { AeraRuntimeContracts, AeraTokenModeSupport } from './evm/aeraContracts';
export type { NormalizedVaultPriceState } from './evm/aeraContracts/priceAndFeeCalculator';

export {
  GauntletSDKError,
  VaultNotFoundError,
  UnsupportedAssetError,
  ChainMismatchError,
  UnsupportedDepositModeError,
  RpcNotConfiguredError,
  AccountRequiredError,
  UnsupportedProtocolError,
  UnsupportedFeatureError,
  InvalidWithdrawParamsError,
  UnimplementedFeatureError,
  UnitConversionError,
  StalePriceError,
  InvalidSolverTipError,
} from './errors';
