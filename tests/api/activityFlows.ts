import { describe, expect, it } from 'vitest';
import { stitchActivityFlows } from '../../src/api/activity';
import { requireSameToken } from '../../src/api/activityRows';
import type { TokenRef, UserActivity } from '../../src/api/client';
import { GauntletSDKError } from '../../src/errors';

const VAULT = '8453:0x1e7c6bd0e2632d8a45ad858b2bfd2fc3f6a0f5f8';
const USDC: TokenRef = { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 };

let blockCounter = 100;
function row(overrides: Partial<UserActivity> & Pick<UserActivity, 'type'>): UserActivity {
  const block = blockCounter++;
  return {
    block_timestamp: 1_750_000_000 + block * 12,
    vault_id: VAULT,
    tx_hash: `0xtx${block}`,
    block_number: block,
    block_hash: `0xblock${block}`,
    shares_delta: '0',
    assets_delta: { native: '0', token: USDC },
    ...overrides,
  };
}

describe('requireSameToken', () => {
  it('checks the chain even when token metadata matches or is absent', () => {
    for (const token of [USDC, null]) {
      const left = row({ type: 'deposit', assets_delta: { native: '0', token } });
      const right = { ...left, vault_id: VAULT.replace('8453:', '1:') };
      expect(() => requireSameToken(left, right)).toThrow('different chains');
    }
  });

  it('keeps address and decimals checks within the same chain', () => {
    const left = row({ type: 'deposit' });
    const right = { ...left, vault_id: '8453:0x0000000000000000000000000000000000000002' };
    expect(() => requireSameToken(left, right)).not.toThrow();
    for (const token of [{ ...USDC, address: '0xother' }, { ...USDC, decimals: 18 }]) {
      expect(() => requireSameToken(left, {
        ...right,
        assets_delta: { native: '0', token },
      })).toThrow('different asset denominations');
    }
  });
});

describe('stitchActivityFlows', () => {
  it('treats a sync deposit as a single settled flow', () => {
    const deposit = row({ type: 'deposit', shares_delta: '95.25', assets_delta: { native: '100.5', token: USDC } });
    const [flow] = stitchActivityFlows([deposit]);

    expect(flow.kind).toBe('deposit');
    expect(flow.status).toBe('settled');
    expect(flow.vaultId).toBe(VAULT);
    expect(flow.requestHash).toBeNull();
    expect(flow.assets).toEqual({ decimal: '100.5', raw: 100500000n, token: USDC });
    expect(flow.shares).toBe(95_250000000000000000n);
    expect(flow.txHashes).toEqual([deposit.tx_hash]);
    expect(flow.settledAt).toEqual(new Date(deposit.block_timestamp * 1000));
  });

  it('stitches an async deposit lifecycle into one settled flow', () => {
    const pending = row({
      type: 'deposit_pending',
      request_hash: '0xreq1',
      assets_delta: { native: '100.5', token: USDC },
    });
    const solve = row({
      type: 'deposit',
      request_hash: '0xreq1',
      shares_delta: '95.25',
      assets_delta: { native: '0', token: USDC },
    });

    const flows = stitchActivityFlows([solve, pending]); // API order: newest first
    expect(flows).toHaveLength(1);
    const [flow] = flows;
    expect(flow.kind).toBe('deposit');
    expect(flow.status).toBe('settled');
    expect(flow.requestHash).toBe('0xreq1');
    expect(flow.requestedAt).toEqual(new Date(pending.block_timestamp * 1000));
    expect(flow.settledAt).toEqual(new Date(solve.block_timestamp * 1000));
    expect(flow.assets.decimal).toBe('100.5');
    expect(flow.assets.raw).toBe(100500000n);
    expect(flow.shares).toBe(95_250000000000000000n);
    expect(flow.txHashes).toEqual([pending.tx_hash, solve.tx_hash]);
  });

  it('marks a lone pending request as pending', () => {
    const pending = row({
      type: 'withdraw_pending',
      request_hash: '0xreq2',
      shares_delta: '-50',
    });
    const [flow] = stitchActivityFlows([pending]);

    expect(flow.kind).toBe('withdraw');
    expect(flow.status).toBe('pending');
    expect(flow.settledAt).toBeNull();
    expect(flow.shares).toBe(50_000000000000000000n);
  });

  it('surfaces the requested amount on refunded deposits instead of the zero net', () => {
    const pending = row({
      type: 'deposit_pending',
      request_hash: '0xreq3',
      assets_delta: { native: '250', token: USDC },
    });
    const refund = row({
      type: 'deposit_refunded',
      request_hash: '0xreq3',
      assets_delta: { native: '-250', token: USDC },
    });

    const [flow] = stitchActivityFlows([refund, pending]);
    expect(flow.status).toBe('refunded');
    expect(flow.kind).toBe('deposit');
    expect(flow.assets).toEqual({ decimal: '250', raw: 250000000n, token: USDC });
  });

  it('stitches an async withdraw where shares move at request time and assets at solve time', () => {
    const pending = row({
      type: 'withdraw_pending',
      request_hash: '0xreq4',
      shares_delta: '-50',
    });
    const solve = row({
      type: 'withdraw',
      request_hash: '0xreq4',
      assets_delta: { native: '-49.9', token: USDC },
    });

    const [flow] = stitchActivityFlows([solve, pending]);
    expect(flow.kind).toBe('withdraw');
    expect(flow.status).toBe('settled');
    expect(flow.shares).toBe(50_000000000000000000n);
    expect(flow.assets.decimal).toBe('49.9');
  });

  it('keeps secondary-market transfers as standalone settled flows', () => {
    const inbound = row({ type: 'transfer_in', shares_delta: '10' });
    const outbound = row({ type: 'transfer_out', shares_delta: '-4' });

    const flows = stitchActivityFlows([outbound, inbound]);
    expect(flows.map((f) => f.kind)).toEqual(['transfer_out', 'transfer_in']);
    expect(flows.every((f) => f.status === 'settled')).toBe(true);
  });

  it('orders mixed flows newest-first by their latest row', () => {
    const oldDeposit = row({ type: 'deposit', shares_delta: '1', assets_delta: { native: '1', token: USDC } });
    const pending = row({ type: 'deposit_pending', request_hash: '0xreq5', assets_delta: { native: '5', token: USDC } });
    const newDeposit = row({ type: 'deposit', shares_delta: '2', assets_delta: { native: '2', token: USDC } });

    const flows = stitchActivityFlows([newDeposit, pending, oldDeposit]);
    expect(flows.map((f) => f.status)).toEqual(['settled', 'pending', 'settled']);
    expect(flows[0].txHashes).toEqual([newDeposit.tx_hash]);
    expect(flows[2].txHashes).toEqual([oldDeposit.tx_hash]);
  });

  it('keeps two same-type sync deposits in one transaction as separate flows', () => {
    const first = row({ type: 'deposit', shares_delta: '95', assets_delta: { native: '100', token: USDC } });
    const second: UserActivity = {
      ...row({ type: 'deposit', shares_delta: '38', assets_delta: { native: '40', token: USDC } }),
      tx_hash: first.tx_hash,
      block_number: first.block_number,
      block_timestamp: first.block_timestamp,
    };

    const flows = stitchActivityFlows([first, second]);
    expect(flows).toHaveLength(2);
    expect(flows.map((f) => f.assets.decimal).sort()).toEqual(['100', '40']);
    expect(flows.map((f) => f.shares).sort()).toEqual([38_000000000000000000n, 95_000000000000000000n]);
  });

  it('throws on unknown activity row types instead of emitting an invalid kind', () => {
    expect(() => stitchActivityFlows([row({ type: 'fee' })])).toThrow(GauntletSDKError);
  });

  it('reports null raw amounts when the indexer omits token decimals', () => {
    const deposit = row({
      type: 'deposit',
      shares_delta: '1',
      assets_delta: { native: '3.5', token: { address: '0xunknown', decimals: null, symbol: null } },
    });
    const [flow] = stitchActivityFlows([deposit]);
    expect(flow.assets.decimal).toBe('3.5');
    expect(flow.assets.raw).toBeNull();
  });
  it('separates reused request hashes by vault and request occurrence', () => {
    const pending = row({ type: 'deposit_pending', request_hash: 'same', assets_delta: { native: '10', token: USDC } });
    const settled = row({ type: 'deposit', request_hash: 'same', shares_delta: '9' });
    const retry = row({ type: 'deposit_pending', request_hash: 'same', assets_delta: { native: '10', token: USDC } });
    const otherVault = { ...retry, vault_id: '1:0x0000000000000000000000000000000000000002' };
    const flows = stitchActivityFlows([otherVault, retry, settled, pending]);
    expect(flows).toHaveLength(3);
    expect(flows.filter((flow) => flow.status === 'pending')).toHaveLength(2);
    expect(flows.find((flow) => flow.status === 'settled')?.txHashes).toEqual([pending.tx_hash, settled.tx_hash]);
    expect(flows.find((flow) => flow.txHashes.includes(retry.tx_hash) && flow.vaultId === VAULT)?.status).toBe('pending');
  });

  it('rejects duplicate requests, conflicting terminals, and incorrect refunds', () => {
    const pending = row({ type: 'deposit_pending', request_hash: 'same', assets_delta: { native: '10', token: USDC } });
    const settled = row({ type: 'deposit', request_hash: 'same', shares_delta: '9' });
    const wrongRefund = row({ type: 'deposit_refunded', request_hash: 'same', assets_delta: { native: '-20', token: USDC } });
    for (const rows of [[pending, pending], [pending, settled, wrongRefund], [pending, wrongRefund]]) {
      expect(() => stitchActivityFlows(rows)).toThrow(GauntletSDKError);
    }
  });

});
