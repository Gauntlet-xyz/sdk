import { type PublicClient, type WalletClient } from 'viem';
import bundledManifest from '../manifest/vaults.json';
import { RpcNotConfiguredError, UnimplementedFeatureError } from './errors';
import type { VaultManifest } from './evm/types';
import { base } from 'viem/chains';

/**
 * Controls how builder attribution is appended to transactions.
 *
 * - `PUBLIC` – attribution is sent as plain calldata (default).
 * - `ENCODED` – attribution is encoded using ERC-8021 with a builder code fetched from the API.
 * - `PRIVATE` – no attribution data is appended.
 */
export enum AttributionMode {
  PUBLIC = 'public',
  ENCODED = 'encoded',
  PRIVATE = 'private',
}

export type ChainId = string | number;

export interface GauntletClientConfig {
  apiKey?: string;
  /** Map of chainId → PublicClient, e.g. { [base.id]: createPublicClient(...) } */
  evmClients?: Record<ChainId, PublicClient>;
  attributionMode?: AttributionMode;
  builderCode?: string;
  /** Viem WalletClient for signing transactions. */
  wallet?: WalletClient;
}

/**
 * Main entry point for the Gauntlet SDK.
 *
 * Holds configuration (RPC clients, wallet, attribution mode) and exposes helpers
 * for reading the vault manifest. Pass an instance of this class to every SDK
 * function (e.g. `getDepositTx`, `getWithdrawTx`, `getVaults`).
 *
 * @example
 * ```ts
 * import { createPublicClient, createWalletClient, http } from 'viem';
 * import { base } from 'viem/chains';
 * import { GauntletClient, AttributionMode } from '@gauntlet-xyz/sdk';
 *
 * const wallet = createWalletClient({
 *  account: privateKeyToAccount('0x...'), // or other account source
 *  chain: base,
 *  transport: http()
 * })
 *
 * const client = new GauntletClient({
 *   evmClients: { [base.id]: createPublicClient({ chain: base, transport: http() }) },
 *   wallet,
 *   attributionMode: AttributionMode.PUBLIC,
 * });
 * ```
 */
export class GauntletClient {
  // used for future core api and encoding attribution
  readonly apiKey?: string;
  readonly builderCode?: string;
  readonly attributionMode: AttributionMode;
  readonly evmClients: Record<ChainId, PublicClient>;
  readonly wallet?: WalletClient;

  private _manifest: VaultManifest = bundledManifest as VaultManifest;

  constructor(config: GauntletClientConfig) {
    this.apiKey = config.apiKey;
    this.evmClients = config.evmClients ?? {};
    this.attributionMode = config.attributionMode ?? AttributionMode.PUBLIC;
    this.builderCode = config.builderCode;
    this.wallet = config.wallet;
  }

  get manifest(): Promise<VaultManifest> {
    return Promise.resolve(this._manifest);
  }

  setManifest(manifest: VaultManifest): void {
    this._manifest = manifest;
  }

  getPublicClient(chainId: ChainId = base.id): PublicClient {
    const client = this.evmClients[chainId];
    if (!client) throw new RpcNotConfiguredError(chainId);
    return client;
  }

  // Will be used for encoded attribution
  // Will use apiKey to get a builder ID from core api
  async getSourceId(): Promise<string> {
    throw new UnimplementedFeatureError('getSourceId');
  }
}
