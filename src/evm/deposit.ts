import type { Address } from 'viem';
import type { GauntletClient } from '../client';
import type { EvmTxStep } from './adapters/types';
import { getAdapter } from './adapters';
import { encodeTransactionWithAttribution, PreparedTx } from '../attribution';
import {
  AccountRequiredError,
  VaultNotFoundError,
  UnsupportedDepositModeError,
  UnsupportedAssetError,
  InvalidSlippageBPSError,
} from '../errors';
import { resolveVault } from './vaults';

export interface EvmDepositParams {
  vaultId: string;
  amount: bigint;
  // Required for multichain vaults, will default to base
  chainId?: number;
  // Required for multiasset vaults, not utilized yet
  assetSymbol?: string;
  /** Request async (queued) deposit. Only valid for vaults with depositMode 'async' or 'both'. */
  depositMode?: string;
  // So a developer is able to specify a separate receiver than the tx sender
  receiver?: Address;
  /** Slippage tolerance in basis points (e.g. 100 = 1%). Defaults to 100. */
  slippageBps?: number;
}

/**
 * Builds the ordered list of EVM transactions required to deposit into a Gauntlet vault.
 *
 * Returns one or two transactions: an ERC-20 approval (only if the current allowance is
 * insufficient) followed by the deposit or async deposit request. Each transaction is
 * returned as a `PreparedTx` object ready to be signed and sent.
 *
 * @param client - A configured `GauntletClient` instance with an EVM public client and wallet.
 * @param params - Deposit parameters including the vault identifier, token amount, and optional
 *   chain, asset symbol, deposit mode (`'sync'` | `'async'`), and receiver address.
 * @returns Ordered array of prepared transactions to execute in sequence.
 *
 * @throws {VaultNotFoundError} If the vault ID is not found in the manifest.
 * @throws {AccountRequiredError} If no wallet account is set on the client.
 * @throws {UnsupportedDepositModeError} If the requested deposit mode is not supported by the vault.
 * @throws {UnsupportedAssetError} If the specified asset symbol is not accepted by the vault.
 *
 * @example
 * ```ts
 * const txs = await getDepositTx(client, {
 *   vaultId: 'baseUsdcPrime',
 *   amount: 100_000_000n, // 100 USDC (6 decimals)
 * });
 * for (const tx of txs) {
 *   await walletClient.sendTransaction(tx.tx);
 * }
 * ```
 */
export async function getDepositTx(
  client: GauntletClient,
  params: EvmDepositParams
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

  const spender = vault.provisionerAddress ?? vault.vaultAddress;
  const adapter = getAdapter(protocol);
  const publicClient = client.getPublicClient(chainId);
  const token =
    vault.supplyToken.length > 1
      ? vault.supplyToken.find((tInfo) => tInfo.symbol === params.assetSymbol)
      : vault.supplyToken[0];

  if (token === undefined) {
    throw new UnsupportedAssetError(params.assetSymbol ?? 'unknown', params.vaultId);
  }

  // NOTE: this could be moved to the buildDeposit level
  const { sufficient } = await adapter.checkAllowance({
    publicClient,
    token: token.address,
    owner: account,
    spender,
    amount: params.amount,
  });

  const steps: EvmTxStep[] = [];

  if (!sufficient) {
    steps.push(
      adapter.buildApproval({
        token: token.address,
        spender,
        amount: params.amount,
        account,
      })
    );
  }

  const depositSteps = await adapter.buildDeposit({
    vault,
    amount: params.amount,
    receiver: params.receiver ?? account,
    account,
    async: modifiedDepositMode === 'async',
    asset: token,
    publicClient,
    slippageBps: params.slippageBps,
  });
  steps.push(...depositSteps);

  return await Promise.all(steps.map((step) => encodeTransactionWithAttribution(client, step)));
}
