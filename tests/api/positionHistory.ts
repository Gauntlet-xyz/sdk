import { describe, expect, it } from 'vitest';
import { GauntletApi, type TokenRef, type UserActivity } from '../../src/api/client';
import { buildPositionHistory, getPositionHistory } from '../../src/api/positionHistory';
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

describe('buildPositionHistory', () => {
  it('replays a full lifecycle into running balances', () => {
    const rows: UserActivity[] = [
      // 1. Sync deposit: 100 USDC → 95 shares.
      row({ type: 'deposit', shares_delta: '95', assets_delta: { native: '100', token: USDC } }),
      // 2. Async deposit request: 50 USDC escrowed.
      row({ type: 'deposit_pending', request_hash: '0xd1', assets_delta: { native: '50', token: USDC } }),
      // 3. Solver settles it: 47.5 shares minted, escrow released.
      row({ type: 'deposit', request_hash: '0xd1', shares_delta: '47.5' }),
      // 4. Async redeem request: 40 shares escrowed to the Provisioner.
      row({ type: 'withdraw_pending', request_hash: '0xw1', shares_delta: '-40' }),
      // 5. Redeem refunded: the 40 shares bounce back.
      row({ type: 'withdraw_refunded', request_hash: '0xw1', shares_delta: '40' }),
      // 6. Sync withdraw: 20 shares burned for 21 USDC.
      row({ type: 'withdraw', shares_delta: '-20', assets_delta: { native: '-21', token: USDC } }),
      // 7. Secondary-market transfer in of 5 shares.
      row({ type: 'transfer_in', shares_delta: '5' }),
    ];

    const history = buildPositionHistory(rows);
    expect(history.vaultId).toBe(VAULT);
    expect(history.token).toEqual(USDC);
    expect(history.points).toHaveLength(7);

    const shares = history.points.map((p) => p.sharesBalance);
    expect(shares).toEqual([
      95_000000000000000000n,
      95_000000000000000000n, // deposit request moves assets only
      142_500000000000000000n,
      102_500000000000000000n, // escrowed shares leave the wallet
      142_500000000000000000n, // refund returns them
      122_500000000000000000n,
      127_500000000000000000n,
    ]);

    expect(history.points.map((p) => p.pendingDepositAssets)).toEqual([
      '0', '50', '0', '0', '0', '0', '0',
    ]);

    expect(history.points.map((p) => p.pendingRedeemShares)).toEqual([
      0n, 0n, 0n, 40_000000000000000000n, 0n, 0n, 0n,
    ]);

    // Settled flows only: +100 (sync) +50 (async, counted at solve) −21 (withdraw).
    expect(history.points.map((p) => p.netAssetsIn)).toEqual([
      '100', '100', '150', '150', '150', '129', '129',
    ]);
  });

  it('replays a refunded async deposit without touching net flows', () => {
    const rows: UserActivity[] = [
      row({ type: 'deposit_pending', request_hash: '0xd2', assets_delta: { native: '75', token: USDC } }),
      row({ type: 'deposit_refunded', request_hash: '0xd2', assets_delta: { native: '-75', token: USDC } }),
    ];

    const history = buildPositionHistory(rows);
    expect(history.points[0].pendingDepositAssets).toBe('75');
    expect(history.points[1].pendingDepositAssets).toBe('0');
    expect(history.points.every((p) => p.netAssetsIn === '0')).toBe(true);
    expect(history.points.every((p) => p.sharesBalance === 0n)).toBe(true);
  });

  it('replays an async withdraw settlement releasing escrow and paying out', () => {
    const rows: UserActivity[] = [
      row({ type: 'deposit', shares_delta: '100', assets_delta: { native: '100', token: USDC } }),
      row({ type: 'withdraw_pending', request_hash: '0xw2', shares_delta: '-30' }),
      row({ type: 'withdraw', request_hash: '0xw2', assets_delta: { native: '-31.5', token: USDC } }),
    ];

    const last = buildPositionHistory(rows).points.at(-1)!;
    expect(last.sharesBalance).toBe(70_000000000000000000n);
    expect(last.pendingRedeemShares).toBe(0n);
    expect(last.netAssetsIn).toBe('68.5');
  });

  it('sorts out-of-order rows chronologically', () => {
    const first = row({ type: 'deposit', shares_delta: '10', assets_delta: { native: '10', token: USDC } });
    const second = row({ type: 'withdraw', shares_delta: '-4', assets_delta: { native: '-4', token: USDC } });

    const history = buildPositionHistory([second, first]);
    expect(history.points.map((p) => p.txHash)).toEqual([first.tx_hash, second.tx_hash]);
    expect(history.points.at(-1)!.sharesBalance).toBe(6_000000000000000000n);
  });

  it('rejects rows spanning multiple vaults and empty input', () => {
    const a = row({ type: 'deposit', shares_delta: '1' });
    const b = row({ type: 'deposit', shares_delta: '1', vault_id: '1:0x0000000000000000000000000000000000000002' });
    expect(() => buildPositionHistory([a, b])).toThrow(GauntletSDKError);
    expect(() => buildPositionHistory([])).toThrow(GauntletSDKError);
  });

  it('rejects settlements referencing a request_hash with no pending row', () => {
    const orphanDeposit = row({ type: 'deposit', request_hash: '0xorphan', shares_delta: '1' });
    expect(() => buildPositionHistory([orphanDeposit])).toThrow(GauntletSDKError);

    const orphanWithdraw = row({
      type: 'withdraw',
      request_hash: '0xorphan2',
      assets_delta: { native: '-1', token: USDC },
    });
    expect(() => buildPositionHistory([orphanWithdraw])).toThrow(GauntletSDKError);
  });
});

describe('getPositionHistory', () => {
  it('returns an empty timeline for a wallet with no activity in the vault', async () => {
    const api = new GauntletApi({
      fetch: async () =>
        new Response(JSON.stringify({ data: [], meta: { next_cursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const history = await getPositionHistory(api, '0x00000000000000000000000000000000000000aa', VAULT);
    expect(history).toEqual({ vaultId: VAULT, token: null, points: [] });
  });
});
