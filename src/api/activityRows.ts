import { GauntletSDKError } from '../errors';
import type { UserActivity } from './client';
import { decimalToBigInt, sharesToBigInt } from './decimal';

export function isPending(row: UserActivity): boolean {
  return row.type === 'deposit_pending' || row.type === 'withdraw_pending';
}

export function requireSameToken(leftRow: UserActivity, rightRow: UserActivity): void {
  // The vault ID includes the chain ID; TokenRef has no chain field.
  if (leftRow.vault_id.split(':')[0] !== rightRow.vault_id.split(':')[0]) {
    throw new GauntletSDKError('Activity rows contain assets on different chains');
  }
  const left = leftRow.assets_delta.token;
  const right = rightRow.assets_delta.token;
  if (
    left != null &&
    right != null &&
    (left.address.toLowerCase() !== right.address.toLowerCase() ||
      (left.decimals ?? null) !== (right.decimals ?? null))
  ) {
    throw new GauntletSDKError('Activity rows contain different asset denominations');
  }
}

export function validateActivityRow(row: UserActivity): void {
  const shares = sharesToBigInt(row.shares_delta);
  const assets = decimalToBigInt(row.assets_delta.native, 18);
  if (
    !Number.isSafeInteger(row.block_number) ||
    row.block_number < 0 ||
    !Number.isSafeInteger(row.block_timestamp) ||
    row.block_timestamp < 0 ||
    typeof row.vault_id !== 'string' ||
    row.vault_id.length === 0 ||
    typeof row.tx_hash !== 'string' ||
    row.tx_hash.length === 0 ||
    (row.request_hash != null &&
      (typeof row.request_hash !== 'string' || row.request_hash.length === 0))
  ) {
    throw new GauntletSDKError('The activity row has invalid event identifiers');
  }
  const token = row.assets_delta.token;
  if (token != null && token.decimals != null) {
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) {
      throw new GauntletSDKError('The activity token has invalid decimals');
    }
    decimalToBigInt(row.assets_delta.native, token.decimals);
  }
  let valid: boolean;
  switch (row.type) {
    case 'deposit':
      valid = shares >= 0n && assets >= 0n && (row.request_hash == null || assets === 0n);
      break;
    case 'deposit_pending':
      valid = shares === 0n && assets > 0n && row.request_hash != null;
      break;
    case 'deposit_refunded':
      valid = shares === 0n && assets < 0n && row.request_hash != null;
      break;
    case 'withdraw':
      valid = shares <= 0n && assets <= 0n && (row.request_hash == null || shares === 0n);
      break;
    case 'withdraw_pending':
      valid = shares < 0n && assets === 0n && row.request_hash != null;
      break;
    case 'withdraw_refunded':
      valid = shares > 0n && assets === 0n && row.request_hash != null;
      break;
    case 'transfer_in':
      valid = shares >= 0n && assets >= 0n && row.request_hash == null;
      break;
    case 'transfer_out':
      valid = shares <= 0n && assets <= 0n && row.request_hash == null;
      break;
    default:
      valid = false;
  }
  if (!valid) throw new GauntletSDKError(`Invalid activity deltas for ${row.type}`);
}

export function orderActivityRows(rows: UserActivity[]): UserActivity[] {
  rows.forEach(validateActivityRow);
  return [...rows].sort(
    (a, b) =>
      a.block_number - b.block_number ||
      a.block_timestamp - b.block_timestamp ||
      Number(isPending(b)) - Number(isPending(a))
  );
}

/**
 * Split request hashes by vault and by each request occurrence.
 * Takes the output of `orderActivityRows`.
 */
export function activityLifecycles(ordered: UserActivity[]): UserActivity[][] {
  const groups: UserActivity[][] = [];
  const latest = new Map<string, UserActivity[]>();
  for (const row of ordered) {
    if (row.request_hash == null) {
      groups.push([row]);
      continue;
    }
    const key = `${row.vault_id}:${row.request_hash}`;
    const previous = latest.get(key);
    if (previous === undefined || isPending(row)) {
      if (previous !== undefined && previous.every(isPending)) {
        throw new GauntletSDKError('An activity request has duplicate pending rows');
      }
      const group = [row];
      latest.set(key, group);
      groups.push(group);
      continue;
    }
    if (previous.some((entry) => !isPending(entry))) {
      throw new GauntletSDKError('An activity request has conflicting terminal rows');
    }
    const pending = previous[0];
    requireSameToken(pending, row);
    const expected =
      pending.type === 'deposit_pending'
        ? ['deposit', 'deposit_refunded']
        : ['withdraw', 'withdraw_refunded'];
    if (!expected.includes(row.type)) {
      throw new GauntletSDKError('The activity terminal does not match its request');
    }
    if (
      row.type === 'deposit_refunded' &&
      decimalToBigInt(pending.assets_delta.native, 18) !==
        -decimalToBigInt(row.assets_delta.native, 18)
    ) {
      throw new GauntletSDKError('The deposit refund does not match its request');
    }
    if (
      row.type === 'withdraw_refunded' &&
      sharesToBigInt(pending.shares_delta) !== -sharesToBigInt(row.shares_delta)
    ) {
      throw new GauntletSDKError('The withdrawal refund does not match its request');
    }
    previous.push(row);
  }
  return groups;
}
