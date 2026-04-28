import type { Address } from 'viem';
import type { GauntletClient } from '../client';
import type { AdapterWithdrawParams } from './adapters/types';
import { getAdapter } from './adapters';
import { encodeTransactionWithAttribution, PreparedTx } from '../attribution';
import {
  AccountRequiredError,
  VaultNotFoundError,
  UnsupportedAssetError,
  UnsupportedDepositModeError,
  InvalidSlippageBPSError,
} from '../errors';
import { resolveVault } from './vaults';

export type EvmWithdrawParams = {
  vaultId: string;
  // Required for multichain vaults, will default to base
  chainId?: number;
  // Required for multiasset vaults, not utilized yet
  assetSymbol?: string;
  /** Request async (queued) withdraw. Only valid for vaults with depositMode 'async' or 'both'. */
  depositMode?: string;
  // So a developer is able to specify a separate receiver than the tx sender
  receiver?: Address;
  /** Slippage tolerance in basis points (e.g. 100 = 1%). Defaults to 100. */
  slippageBps?: number;
} & (
  | { shares: bigint; amount?: never; entireAmount?: never }
  | { amount: bigint; shares?: never; entireAmount?: never }
  | { entireAmount: true; shares?: never; amount?: never }
);

/**
 * Builds the ordered list of EVM transactions required to withdraw from a Gauntlet vault.
 *
 * Specify the withdrawal amount as one of: `shares` (vault units), `amount` (underlying
 * token amount), or `entireAmount: true` (full balance). Returns an ERC-20 approval
 * (only when needed for async redeem) followed by the withdraw or async redeem request,
 * each returned as a `PreparedTx` ready to be signed and sent.
 *
 * @param client - A configured `GauntletClient` instance with an EVM public client and wallet.
 * @param params - Withdrawal parameters including the vault identifier and exactly one of
 *   `shares`, `amount`, or `entireAmount`, plus optional chain, asset symbol, deposit mode,
 *   and receiver address.
 * @returns Ordered array of prepared transactions to execute in sequence.
 *
 * @throws {VaultNotFoundError} If the vault ID is not found in the manifest.
 * @throws {AccountRequiredError} If no wallet account is set on the client.
 * @throws {UnsupportedDepositModeError} If the requested withdrawal mode is not supported.
 * @throws {UnsupportedAssetError} If the specified asset symbol is not accepted by the vault.
 *
 * @example
 * ```ts
 * // Withdraw by token amount
 * const txs = await getWithdrawTx(client, {
 *   vaultId: 'baseUsdcPrime',
 *   amount: 50_000_000n, // 50 USDC (6 decimals)
 * });
 *
 * // Withdraw entire balance
 * const txs = await getWithdrawTx(client, {
 *   vaultId: 'baseUsdcPrime',
 *   entireAmount: true,
 * });
 * ```
 */
export async function getWithdrawTx(
  client: GauntletClient,
  params: EvmWithdrawParams
): Promise<PreparedTx[]> {
  if (
    params.slippageBps !== undefined &&
    (!Number.isInteger(params.slippageBps) || params.slippageBps < 0 || params.slippageBps > 10000)
  ) {
    throw new InvalidSlippageBPSError(params.slippageBps);
  }

  const resolved = await resolveVault(client, params.vaultId, params.chainId);
  if (!resolved) throw new VaultNotFoundError(params.vaultId);

  const chainId = params.chainId ?? resolved.vault.chainId;

  const account = client.wallet?.account?.address;
  if (!account) throw new AccountRequiredError();

  const { vault, protocol } = resolved;

  if (params.depositMode === 'sync' && vault.depositMode === 'async') {
    throw new UnsupportedDepositModeError(params.vaultId, 'sync', vault.depositMode);
  }
  if (params.depositMode === 'async' && vault.depositMode === 'sync') {
    throw new UnsupportedDepositModeError(params.vaultId, 'async', vault.depositMode);
  }
  let modifiedDepositMode = params.depositMode;
  if (params.depositMode === undefined) {
    modifiedDepositMode = vault.depositMode === 'both' ? 'async' : vault.depositMode;
  }

  const token =
    vault.supplyToken.length > 1
      ? vault.supplyToken.find((tInfo) => tInfo.symbol === params.assetSymbol)
      : vault.supplyToken[0];

  if (token === undefined) {
    throw new UnsupportedAssetError(params.assetSymbol ?? 'unknown', params.vaultId);
  }

  const adapter = getAdapter(protocol);
  const publicClient = client.getPublicClient(chainId);

  const withdrawParams = {
    vault,
    receiver: params.receiver ?? account,
    account,
    async: modifiedDepositMode === 'async',
    asset: token,
    publicClient,
    slippageBps: params.slippageBps,
    ...('shares' in params && params.shares != null ? { shares: params.shares } : {}),
    ...('amount' in params && params.amount != null ? { amount: params.amount } : {}),
    ...('entireAmount' in params && params.entireAmount ? { entireAmount: true as const } : {}),
  };

  const steps = await adapter.buildWithdraw(withdrawParams as AdapterWithdrawParams);

  return await Promise.all(steps.map((step) => encodeTransactionWithAttribution(client, step)));
}
