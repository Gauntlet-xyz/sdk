import type { components } from './generated';
import { apiGet, type GauntletApiConfig, type QueryParams } from './http';

type Schemas = components['schemas'];

export type UserActivity = Schemas['UserActivity'];
export type UserActivityResponse = Schemas['UserActivityResponse'];
export type UserPosition = Schemas['UserPosition'];
export type UserAllPositionsResponse = Schemas['UserAllPositionsResponse'];
export type UserPositionLatestResponse = Schemas['UserPositionLatestResponse'];
export type UserPositionsTimeseriesResponse = Schemas['UserPositionsTimeseriesResponse'];
export type PositionTimeseriesPoint = Schemas['PositionTimeseriesPoint'];
export type VaultDetail = Schemas['VaultDetail'];
export type VaultDetailResponse = Schemas['VaultDetailResponse'];
export type VaultTimeseriesResponse = Schemas['VaultTimeseriesResponse'];
export type VaultTimeseriesPoint = Schemas['VaultTimeseriesPoint'];
export type VaultMetrics = Schemas['VaultMetrics'];
export type TvlResponse = Schemas['TvlResponse'];
export type LatestPriceResponse = Schemas['LatestPriceResponse'];
export type PriceTimeseriesResponse = Schemas['TimeseriesResponse'];
export type TokenRef = Schemas['TokenRef'];
export type AmountPair = Schemas['AmountPair'];
export type TimeseriesMeta = Schemas['TimeseriesMeta'];
export type HealthResponse = Schemas['HealthResponse'];
export type ChainSyncStatus = Schemas['ChainSyncStatus'];

export interface PageOptions {
  /** Opaque cursor from a previous response's `meta.next_cursor`. */
  next?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface TimeWindowOptions extends PageOptions {
  /** ISO 8601 date (`2026-01-01`) or RFC 3339 timestamp. */
  start?: string;
  end?: string;
  granularity?: 'hour' | 'day' | 'week' | 'month';
}

export interface ActivityOptions extends PageOptions {
  /** CAIP-10 vault id (`"{chainId}:{address}"`). Omit for wallet-wide activity. */
  vaultId?: string;
}

export interface LatestPriceOptions {
  address: string;
  chainId: number;
  /** Optional ISO 8601 timestamp for a point-in-time price. */
  at?: string;
}

export interface PriceTimeseriesOptions {
  address: string;
  chainId: number;
  start: string;
  end: string;
  granularity?: 'raw' | 'hour' | 'day' | 'week' | 'month';
  limit?: number;
}

/**
 * Typed client for the Gaia REST API (api.gauntlet.xyz).
 *
 * All response types are generated from the service's OpenAPI spec
 * (`src/api/generated.ts`, regenerated via `yarn generate:api-types`) so they
 * cannot drift from the server models. Values are returned exactly as the API
 * emits them — human-unit decimal strings and CAIP-10 vault ids; use
 * `decimalToBigInt` / `sharesToBigInt` and `apiVaultIdFromVaultId` /
 * `vaultIdFromApiVaultId` to convert, or the higher-level `activityFlows` /
 * `positionHistory` helpers for pre-normalized values.
 *
 * Available on a configured client as `client.api`, or standalone:
 * ```ts
 * const api = new GauntletApi({ apiKey: process.env.GAUNTLET_API_KEY });
 * const { data } = await api.vaults();
 * ```
 */
export class GauntletApi {
  private readonly config: GauntletApiConfig;

  constructor(config: GauntletApiConfig = {}) {
    this.config = config;
  }

  private get<T>(path: string, query?: QueryParams): Promise<T> {
    return apiGet<T>(this.config, path, query);
  }

  /** GET /health — service liveness (version + uptime). */
  health(): Promise<HealthResponse> {
    return this.get('/health');
  }

  /** GET /health/chains — per-chain indexer sync freshness. */
  chainSyncStatus(): Promise<ChainSyncStatus[]> {
    return this.get('/health/chains');
  }

  /** GET /v1/vaults — all indexed vaults with live metrics (TVL, APY, unit price). */
  vaults(options: PageOptions = {}): Promise<{ data: VaultDetail[]; meta: TimeseriesMeta }> {
    return this.get('/v1/vaults', { next: options.next, limit: options.limit });
  }

  /** GET /v1/vaults/{vault_id} — one vault with live metrics. `vaultId` is CAIP-10. */
  vault(vaultId: string): Promise<VaultDetailResponse> {
    return this.get(`/v1/vaults/${encodeURIComponent(vaultId)}`);
  }

  /** GET /v1/vaults/{vault_id}/definition — raw indexed vault definition. */
  vaultDefinition(vaultId: string): Promise<unknown> {
    return this.get(`/v1/vaults/${encodeURIComponent(vaultId)}/definition`);
  }

  /** GET /v1/vaults/{vault_id}/timeseries — TVL / unit-price / APY history. */
  vaultTimeseries(
    vaultId: string,
    options: TimeWindowOptions = {}
  ): Promise<VaultTimeseriesResponse> {
    return this.get(`/v1/vaults/${encodeURIComponent(vaultId)}/timeseries`, { ...options });
  }

  /** GET /v1/users/{wallet}/positions — all of a wallet's indexed positions with PnL. */
  positions(walletAddress: string): Promise<UserAllPositionsResponse> {
    return this.get(`/v1/users/${encodeURIComponent(walletAddress)}/positions`);
  }

  /** GET /v1/users/{wallet}/positions/{vault_id} — one position with PnL breakdown. */
  position(walletAddress: string, vaultId: string): Promise<UserPositionLatestResponse> {
    return this.get(
      `/v1/users/${encodeURIComponent(walletAddress)}/positions/${encodeURIComponent(vaultId)}`
    );
  }

  /** GET /v1/users/{wallet}/positions/{vault_id}/timeseries — value / cost-basis / PnL / ROI history. */
  positionTimeseries(
    walletAddress: string,
    vaultId: string,
    options: TimeWindowOptions = {}
  ): Promise<UserPositionsTimeseriesResponse> {
    return this.get(
      `/v1/users/${encodeURIComponent(walletAddress)}/positions/${encodeURIComponent(vaultId)}/timeseries`,
      { ...options }
    );
  }

  /** GET /v1/users/{wallet}/activity — one page of the wallet's immutable event log. */
  activity(walletAddress: string, options: ActivityOptions = {}): Promise<UserActivityResponse> {
    const { vaultId, ...page } = options;
    return this.get(`/v1/users/${encodeURIComponent(walletAddress)}/activity`, {
      vault_id: vaultId,
      ...page,
    });
  }

  /**
   * Iterates the wallet's full activity log, following `meta.next_cursor`
   * across pages so callers never handle cursors.
   */
  async *activityRows(
    walletAddress: string,
    options: Omit<ActivityOptions, 'next'> = {}
  ): AsyncGenerator<UserActivity> {
    let next: string | undefined;
    do {
      const page = await this.activity(walletAddress, { ...options, next });
      yield* page.data;
      next = page.meta.next_cursor ?? undefined;
    } while (next);
  }

  /** GET /v1/tvl — aggregate Gauntlet TVL, optionally with per-source breakdown. */
  tvl(options: { includeBreakdown?: boolean } = {}): Promise<TvlResponse> {
    return this.get('/v1/tvl', { include_breakdown: options.includeBreakdown });
  }

  /** GET /v1/prices — latest USD price for a token. */
  latestPrice(options: LatestPriceOptions): Promise<LatestPriceResponse> {
    return this.get('/v1/prices', {
      address: options.address,
      chain_id: options.chainId,
      at: options.at,
    });
  }

  /** GET /v1/prices/timeseries — USD price history for a token. */
  priceTimeseries(options: PriceTimeseriesOptions): Promise<PriceTimeseriesResponse> {
    return this.get('/v1/prices/timeseries', {
      address: options.address,
      chain_id: options.chainId,
      start: options.start,
      end: options.end,
      granularity: options.granularity,
      limit: options.limit,
    });
  }
}
