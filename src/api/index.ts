export { GauntletApi } from './client';
export type {
  ActivityOptions,
  AmountPair,
  ChainSyncStatus,
  HealthResponse,
  LatestPriceOptions,
  LatestPriceResponse,
  PageOptions,
  PositionTimeseriesPoint,
  PriceTimeseriesOptions,
  PriceTimeseriesResponse,
  TimeseriesMeta,
  TimeWindowOptions,
  TokenRef,
  TvlResponse,
  UserActivity,
  UserActivityResponse,
  UserAllPositionsResponse,
  UserPosition,
  UserPositionLatestResponse,
  UserPositionsTimeseriesResponse,
  VaultDetail,
  VaultDetailResponse,
  VaultMetrics,
  VaultTimeseriesPoint,
  VaultTimeseriesResponse,
} from './client';

export { DEFAULT_API_URL } from './http';
export type { GauntletApiConfig } from './http';

export { bigIntToDecimal, decimalToBigInt, SHARE_DECIMALS, sharesToBigInt } from './decimal';

export {
  apiVaultIdFromVaultId,
  formatApiVaultId,
  parseApiVaultId,
  vaultIdFromApiVaultId,
} from './caip';
export type { ApiVaultId } from './caip';

export { getActivityFlows, stitchActivityFlows, waitForRequestSettlement } from './activity';
export type {
  ActivityFlow,
  ActivityFlowKind,
  ActivityFlowsOptions,
  ActivityFlowStatus,
  AssetAmount,
  WaitForSettlementOptions,
} from './activity';

export { buildPositionHistory, getPositionHistory } from './positionHistory';
export type { PositionHistory, PositionHistoryPoint } from './positionHistory';

export {
  DecimalPrecisionError,
  GauntletApiError,
  InvalidCaipIdError,
  InvalidDecimalError,
  SettlementTimeoutError,
} from './errors';

export type { components as GaiaApiComponents, paths as GaiaApiPaths } from './generated';
