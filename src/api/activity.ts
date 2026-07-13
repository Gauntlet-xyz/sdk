import { GauntletSDKError } from '../errors';
import type { ActivityOptions, GauntletApi, TokenRef, UserActivity } from './client';
import { decimalToBigInt, sharesToBigInt } from './decimal';
import { SettlementTimeoutError } from './errors';

export type ActivityFlowKind = 'deposit' | 'withdraw' | 'transfer_in' | 'transfer_out';
export type ActivityFlowStatus = 'settled' | 'pending' | 'refunded';

/** A signed token amount as reported by the API, with base-unit conversion when possible. */
export interface AssetAmount {
  /** Human-unit decimal string exactly as the API emits it, e.g. `"1250.5"`. */
  decimal: string;
  /** Base-unit integer (`decimal × 10^token.decimals`); null when the token's decimals are unknown. */
  raw: bigint | null;
  token: TokenRef | null;
}

/**
 * One user action against a vault, stitched from the activity log's immutable
 * rows. Sync flows (Morpho, secondary-market transfers) come from a single
 * row; Aera async flows pair a `*_pending` request row with its terminal
 * settle/refund row via `request_hash`.
 */
export interface ActivityFlow {
  kind: ActivityFlowKind;
  status: ActivityFlowStatus;
  /** CAIP-10 vault id (`"{chainId}:{address}"`). */
  vaultId: string;
  /** Aera async correlation hash; null for sync flows and transfers. */
  requestHash: string | null;
  /** When the request row landed. Null when the flow's pending row is outside the fetched window. */
  requestedAt: Date | null;
  /** When the terminal (settle/refund) row landed. Null while pending. */
  settledAt: Date | null;
  /** Magnitude of the flow's asset movement (requested amount for refunded flows). */
  assets: AssetAmount;
  /** Magnitude of the flow's share movement in 18-decimal base units. */
  shares: bigint;
  /** Transaction hashes in row order (request first, then settlement, when both are known). */
  txHashes: string[];
}

const PENDING_TYPES = new Set(['deposit_pending', 'withdraw_pending']);
const REFUNDED_TYPES = new Set(['deposit_refunded', 'withdraw_refunded']);

function flowKind(rowType: string): ActivityFlowKind {
  if (rowType.startsWith('deposit')) return 'deposit';
  if (rowType.startsWith('withdraw')) return 'withdraw';
  if (rowType === 'transfer_in' || rowType === 'transfer_out') return rowType;
  throw new GauntletSDKError(`Unknown activity row type "${rowType}"`);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Comparison scale for asset amounts. The API emits human-unit decimal strings
 * with at most `token.decimals` fractional digits, so 18 digits is exact for
 * every supported asset.
 */
const ASSET_SCALE = 18;

function toAssetAmount(rows: UserActivity[]): AssetAmount {
  // Per the API contract, at most one row of an async lifecycle carries the
  // asset movement (the other legs are "0"), so the max magnitude is the
  // flow's amount. For refunded flows this surfaces the requested amount
  // instead of the useless net of zero.
  let best = rows[0];
  let bestMagnitude = abs(decimalToBigInt(best.assets_delta.native, ASSET_SCALE));
  for (const row of rows.slice(1)) {
    const magnitude = abs(decimalToBigInt(row.assets_delta.native, ASSET_SCALE));
    if (magnitude > bestMagnitude) {
      best = row;
      bestMagnitude = magnitude;
    }
  }
  const token =
    best.assets_delta.token ?? rows.find((r) => r.assets_delta.token)?.assets_delta.token ?? null;
  const decimal = best.assets_delta.native.replace(/^-/, '');
  const raw = token?.decimals != null ? decimalToBigInt(decimal, token.decimals) : null;
  return { decimal, raw, token };
}

/**
 * Pure stitcher: folds raw activity rows into `ActivityFlow`s. Rows may be in
 * any order and may span multiple vaults; async lifecycles are paired by
 * `request_hash`. Flows are returned newest-first (by the flow's latest row).
 */
export function stitchActivityFlows(rows: UserActivity[]): ActivityFlow[] {
  const groups = new Map<string, UserActivity[]>();
  for (const [index, row] of rows.entries()) {
    // Rows without a request_hash are standalone sync flows: each one is its
    // own group, so two same-type events in one transaction (e.g. a multicall
    // doing two deposits) stay two flows.
    const key = row.request_hash ?? `row:${index}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const flows: ActivityFlow[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.block_timestamp - b.block_timestamp);
    const pendingRow = group.find((r) => PENDING_TYPES.has(r.type)) ?? null;
    const terminalRow = group.find((r) => !PENDING_TYPES.has(r.type)) ?? null;
    const isAsync = group.some((r) => r.request_hash != null);

    let status: ActivityFlowStatus;
    if (!terminalRow) status = 'pending';
    else if (REFUNDED_TYPES.has(terminalRow.type)) status = 'refunded';
    else status = 'settled';

    let sharesMagnitude = 0n;
    for (const row of group) {
      const shares = abs(sharesToBigInt(row.shares_delta));
      if (shares > sharesMagnitude) sharesMagnitude = shares;
    }

    flows.push({
      kind: flowKind((terminalRow ?? pendingRow ?? group[0]).type),
      status,
      vaultId: group[0].vault_id,
      requestHash: group[0].request_hash ?? null,
      requestedAt: pendingRow
        ? new Date(pendingRow.block_timestamp * 1000)
        : isAsync
          ? null
          : new Date(group[0].block_timestamp * 1000),
      settledAt: terminalRow ? new Date(terminalRow.block_timestamp * 1000) : null,
      assets: toAssetAmount(group),
      shares: sharesMagnitude,
      txHashes: [...new Set(group.map((r) => r.tx_hash))],
    });
  }

  return flows.sort((a, b) => {
    const aAt = (a.settledAt ?? a.requestedAt)?.getTime() ?? 0;
    const bAt = (b.settledAt ?? b.requestedAt)?.getTime() ?? 0;
    return bAt - aAt;
  });
}

export interface ActivityFlowsOptions extends Pick<ActivityOptions, 'vaultId' | 'limit'> {
  /** Stop paginating once this many rows have been fetched. Defaults to 1000. */
  maxRows?: number;
}

/**
 * Fetches the wallet's activity log and stitches it into lifecycle-aware
 * flows — the replacement for scanning vault event logs over RPC.
 *
 * ```ts
 * const flows = await getActivityFlows(client.api, wallet);
 * const open = flows.filter((f) => f.status === 'pending');
 * ```
 */
export async function getActivityFlows(
  api: GauntletApi,
  walletAddress: string,
  options: ActivityFlowsOptions = {}
): Promise<ActivityFlow[]> {
  const maxRows = options.maxRows ?? 1000;
  const rows: UserActivity[] = [];
  for await (const row of api.activityRows(walletAddress, {
    vaultId: options.vaultId,
    // The API caps page size at 1000; request maxRows per page so the common
    // case is a single round trip instead of ten default-100 pages.
    limit: options.limit ?? Math.min(maxRows, 1000),
    order: 'desc',
  })) {
    rows.push(row);
    if (rows.length >= maxRows) break;
  }
  const flows = stitchActivityFlows(rows);
  if (rows.length >= maxRows) {
    // The window cut may have split an async lifecycle, keeping a terminal
    // row whose request leg (the one carrying the amount) fell outside the
    // window. Drop those flows rather than reporting zeroed amounts.
    return flows.filter((f) => f.requestHash === null || f.requestedAt !== null);
  }
  return flows;
}

export interface WaitForSettlementOptions {
  /** CAIP-10 vault id — narrows polling to one vault's activity. */
  vaultId?: string;
  /** Polling interval. Defaults to 5s. */
  pollIntervalMs?: number;
  /** Overall deadline. Defaults to 10 minutes. Throws `SettlementTimeoutError` on expiry. */
  timeoutMs?: number;
}

/**
 * Polls the activity log until the Aera async request identified by
 * `requestHash` reaches a terminal state, and returns the settled or refunded
 * flow. Use after submitting a `requestDeposit` / `requestRedeem` transaction.
 */
export async function waitForRequestSettlement(
  api: GauntletApi,
  walletAddress: string,
  requestHash: string,
  options: WaitForSettlementOptions = {}
): Promise<ActivityFlow> {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const flows = await getActivityFlows(api, walletAddress, { vaultId: options.vaultId });
    const flow = flows.find((f) => f.requestHash === requestHash);
    if (flow && flow.status !== 'pending') return flow;

    if (Date.now() + pollIntervalMs > deadline) {
      throw new SettlementTimeoutError(requestHash, timeoutMs);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
