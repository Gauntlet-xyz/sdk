import { GauntletSDKError } from '../errors';
import type { GauntletApi, TokenRef, UserActivity } from './client';
import { bigIntToDecimal, decimalToBigInt, sharesToBigInt } from './decimal';

/**
 * Internal accounting scale for asset amounts. The API emits human-unit
 * decimal strings with at most `token.decimals` fractional digits, so 18
 * digits is exact for every supported asset; a token with more than 18
 * decimals would throw `DecimalPrecisionError` rather than lose precision.
 */
const ASSET_SCALE = 18;

/** The wallet's reconstructed position state immediately after one activity row. */
export interface PositionHistoryPoint {
  timestamp: Date;
  txHash: string;
  type: UserActivity['type'];
  /** Signed share movement of this row, 18-decimal base units. */
  sharesDelta: bigint;
  /** Signed asset movement of this row (deposit-ledger convention), human decimal string. */
  assetsDelta: string;
  /** Shares held by the wallet after this row (escrowed redeem shares excluded). */
  sharesBalance: bigint;
  /** Assets escrowed at the Provisioner awaiting share mint, human decimal string. */
  pendingDepositAssets: string;
  /** Shares escrowed at the Provisioner awaiting asset return, 18-decimal base units. */
  pendingRedeemShares: bigint;
  /** Cumulative settled deposits minus settled withdrawals, human decimal string. */
  netAssetsIn: string;
}

export interface PositionHistory {
  /** CAIP-10 vault id the history belongs to. */
  vaultId: string;
  /** The vault's asset token, when the indexer reports it on any row. */
  token: TokenRef | null;
  /** Chronological (oldest-first) position states, one per activity row. */
  points: PositionHistoryPoint[];
}

/**
 * Pure builder: replays a single vault's activity rows (any order) into a
 * chronological position timeline — running share balance, escrowed pending
 * amounts, and cumulative net asset flows.
 *
 * Async lifecycles are paired via `request_hash` so settled deposits count
 * the requested asset amount and terminal rows release the matching escrow.
 */
export function buildPositionHistory(rows: UserActivity[]): PositionHistory {
  if (rows.length === 0) {
    throw new GauntletSDKError('Cannot build position history from zero activity rows');
  }
  const vaultIds = new Set(rows.map((r) => r.vault_id));
  if (vaultIds.size > 1) {
    throw new GauntletSDKError(
      `Position history requires rows from a single vault; got ${[...vaultIds].join(', ')}`
    );
  }

  const ordered = [...rows].sort((a, b) => a.block_timestamp - b.block_timestamp);
  const token = ordered.find((r) => r.assets_delta.token)?.assets_delta.token ?? null;

  let sharesBalance = 0n;
  let pendingDepositAssets = 0n;
  let pendingRedeemShares = 0n;
  let netAssetsIn = 0n;
  const pendingDepositByHash = new Map<string, bigint>();
  const pendingRedeemByHash = new Map<string, bigint>();

  const points: PositionHistoryPoint[] = [];
  for (const row of ordered) {
    const sharesDelta = sharesToBigInt(row.shares_delta);
    const assetsDelta = decimalToBigInt(row.assets_delta.native, ASSET_SCALE);
    sharesBalance += sharesDelta;

    switch (row.type) {
      case 'deposit':
        if (row.request_hash != null) {
          // Async terminal solve: assets moved at request time; release escrow.
          const requested = pendingDepositByHash.get(row.request_hash);
          if (requested === undefined) {
            throw new GauntletSDKError(
              `Deposit settlement ${row.tx_hash} references request_hash "${row.request_hash}" with no matching deposit_pending row`
            );
          }
          pendingDepositByHash.delete(row.request_hash);
          pendingDepositAssets -= requested;
          netAssetsIn += requested;
        } else {
          netAssetsIn += assetsDelta;
        }
        break;
      case 'deposit_pending':
        pendingDepositAssets += assetsDelta;
        if (row.request_hash != null) pendingDepositByHash.set(row.request_hash, assetsDelta);
        break;
      case 'deposit_refunded':
        // Row carries the unwound request as a negative delta.
        pendingDepositAssets += assetsDelta;
        if (row.request_hash != null) pendingDepositByHash.delete(row.request_hash);
        break;
      case 'withdraw':
        // Sync withdraws and async terminal solves both carry the asset
        // payout as a negative delta on this row.
        netAssetsIn += assetsDelta;
        if (row.request_hash != null) {
          const escrowed = pendingRedeemByHash.get(row.request_hash);
          if (escrowed === undefined) {
            throw new GauntletSDKError(
              `Withdraw settlement ${row.tx_hash} references request_hash "${row.request_hash}" with no matching withdraw_pending row`
            );
          }
          pendingRedeemByHash.delete(row.request_hash);
          pendingRedeemShares -= escrowed;
        }
        break;
      case 'withdraw_pending': {
        const escrowed = -sharesDelta;
        pendingRedeemShares += escrowed;
        if (row.request_hash != null) pendingRedeemByHash.set(row.request_hash, escrowed);
        break;
      }
      case 'withdraw_refunded':
        pendingRedeemShares -= sharesDelta;
        if (row.request_hash != null) pendingRedeemByHash.delete(row.request_hash);
        break;
      case 'transfer_in':
      case 'transfer_out':
        break;
      default:
        throw new GauntletSDKError(`Unknown activity row type "${row.type}"`);
    }

    points.push({
      timestamp: new Date(row.block_timestamp * 1000),
      txHash: row.tx_hash,
      type: row.type,
      sharesDelta,
      assetsDelta: row.assets_delta.native,
      sharesBalance,
      pendingDepositAssets: bigIntToDecimal(pendingDepositAssets, ASSET_SCALE),
      pendingRedeemShares,
      netAssetsIn: bigIntToDecimal(netAssetsIn, ASSET_SCALE),
    });
  }

  return { vaultId: ordered[0].vault_id, token, points };
}

/**
 * Fetches a wallet's complete activity for one vault and replays it into a
 * position timeline. `vaultId` is the CAIP-10 id; use `apiVaultIdFromVaultId`
 * to convert a manifest vault id. A wallet that has never touched the vault
 * gets an empty timeline, not an error.
 */
export async function getPositionHistory(
  api: GauntletApi,
  walletAddress: string,
  vaultId: string
): Promise<PositionHistory> {
  const rows: UserActivity[] = [];
  for await (const row of api.activityRows(walletAddress, { vaultId, order: 'asc', limit: 1000 })) {
    rows.push(row);
  }
  if (rows.length === 0) return { vaultId, token: null, points: [] };
  return buildPositionHistory(rows);
}
