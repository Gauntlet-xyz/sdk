import type { Address } from 'viem';
import type { GauntletClient } from '../client';
import type { AdapterWithdrawParams } from './adapters/types';
import type { SyncWithdrawQuoteBounds } from './withdrawQuote';
import { getAdapter } from './adapters';
import { encodeTransactionWithAttribution, PreparedTx } from '../attribution';
import {
  AccountMismatchError,
  AccountRequiredError,
  VaultNotFoundError,
  UnsupportedAssetError,
  InvalidSlippageBPSError,
  InvalidWithdrawParamsError,
} from '../errors';
import {
  requireAeraSyncRedeemRuntime,
  resolveAeraRuntimeContracts,
  resolveAeraTokenModeSupport,
  type AeraRuntimeContracts,
} from './aeraContracts';
import { resolveVault } from './vaults';
import { DEFAULT_BPS, MAX_BPS } from '../constants';
import {
  parseOperationMode,
  resolveOperationMode,
  resolveSyncOnlyOperationMode,
  type OperationMode,
} from './operationMode';
import { ContractVersion } from './types';

export type EvmWithdrawParams = {
  vaultId: string;
  // Required for multichain vaults, will default to base
  chainId?: number;
  // Required for multiasset vaults, not utilized yet
  assetSymbol?: string;
  /** Request async (queued) or sync withdraw. Availability is read from live vault configuration. */
  depositMode?: string;
  // So a developer is able to specify a separate receiver than the tx sender
  receiver?: Address;
  /** Slippage tolerance in basis points (e.g. 100 = 1%). Defaults to 100. */
  slippageBps?: number;
  /** Solver tip passed to async Aera provisioner requests. Defaults to 0. */
  solverTip?: bigint;
  /** Maximum price age passed to async Aera provisioner requests. Defaults to 10 days. */
  maxPriceAge?: bigint;
  /**
   * Current sync quote bounds to pin instant withdraw transaction construction.
   * Supplying bounds implies `depositMode: 'sync'`; explicit async requests are rejected.
   */
  syncWithdrawQuote?: SyncWithdrawQuoteBounds;
} & (
  | { shares: bigint; amount?: never; entireAmount?: never }
  | { amount: bigint; shares?: never; entireAmount?: never }
  | { account?: Address; entireAmount: true; shares?: never; amount?: never }
);

function validateWithdrawParams(params: EvmWithdrawParams) {
  const modes = [
    'amount' in params && params.amount != null,
    'shares' in params && params.shares != null,
    'entireAmount' in params && params.entireAmount === true,
  ].filter(Boolean).length;

  if (modes !== 1) throw new InvalidWithdrawParamsError();
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validateSyncWithdrawQuote({
  params,
  account,
  chainId,
  slippageBps,
  tokenAddress,
}: {
  params: EvmWithdrawParams;
  account: Address;
  chainId: number;
  slippageBps: number;
  tokenAddress: Address;
}) {
  const quote = params.syncWithdrawQuote;
  if (quote === undefined) return;

  const { context } = quote;
  if (
    context.vaultId !== params.vaultId ||
    context.chainId !== chainId ||
    !sameAddress(context.tokenAddress, tokenAddress) ||
    context.slippageBps !== slippageBps
  ) {
    throw new InvalidWithdrawParamsError();
  }

  if (context.account !== undefined && !sameAddress(context.account, account)) {
    throw new InvalidWithdrawParamsError();
  }

  switch (context.request.mode) {
    case 'amount':
      if (
        quote.kind !== 'withdraw' ||
        !('amount' in params && params.amount != null) ||
        context.request.amount !== params.amount ||
        quote.tokensOut !== params.amount
      ) {
        throw new InvalidWithdrawParamsError();
      }
      return;
    case 'shares':
      if (
        quote.kind !== 'redeem' ||
        !('shares' in params && params.shares != null) ||
        context.request.shares !== params.shares ||
        quote.shares !== params.shares
      ) {
        throw new InvalidWithdrawParamsError();
      }
      return;
    case 'entireAmount':
      if (
        quote.kind !== 'redeem' ||
        !('entireAmount' in params && params.entireAmount) ||
        !sameAddress(context.request.account, account)
      ) {
        throw new InvalidWithdrawParamsError();
      }
      return;
  }
}

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
 *   account: walletAddress,
 * });
 * ```
 */
export async function getWithdrawTx(
  client: GauntletClient,
  params: EvmWithdrawParams
): Promise<PreparedTx[]> {
  validateWithdrawParams(params);

  if (
    params.slippageBps !== undefined &&
    (!Number.isInteger(params.slippageBps) ||
      params.slippageBps < 0 ||
      params.slippageBps > Number(MAX_BPS))
  ) {
    throw new InvalidSlippageBPSError(params.slippageBps);
  }

  const resolved = await resolveVault(client, params.vaultId, params.chainId);
  if (!resolved) throw new VaultNotFoundError(params.vaultId);

  const chainId = params.chainId ?? resolved.vault.chainId;

  const account = client.wallet?.account?.address;
  if (!account) throw new AccountRequiredError();
  if ('entireAmount' in params && params.entireAmount && params.account !== undefined) {
    if (!sameAddress(params.account, account)) {
      throw new AccountMismatchError(account, params.account);
    }
  }

  const { vault, protocol } = resolved;

  const token =
    vault.supplyToken.length > 1
      ? vault.supplyToken.find((tInfo) => tInfo.symbol === params.assetSymbol)
      : vault.supplyToken[0];

  if (token === undefined) {
    throw new UnsupportedAssetError(params.assetSymbol ?? 'unknown', params.vaultId);
  }

  const adapter = getAdapter(protocol);
  const publicClient = client.getPublicClient(chainId);
  const requestedWithdrawMode = parseOperationMode(params.vaultId, params.depositMode);
  const slippageBps =
    params.slippageBps ?? params.syncWithdrawQuote?.context.slippageBps ?? DEFAULT_BPS;
  let modifiedDepositMode: OperationMode;
  let aeraRuntime: AeraRuntimeContracts | undefined;

  if (params.syncWithdrawQuote !== undefined) {
    if (protocol !== 'aera' || requestedWithdrawMode === 'async') {
      throw new InvalidWithdrawParamsError();
    }

    validateSyncWithdrawQuote({
      params,
      account,
      chainId,
      slippageBps,
      tokenAddress: token.address,
    });
  }

  if (protocol === 'aera') {
    aeraRuntime = await resolveAeraRuntimeContracts(publicClient, vault);
    if (
      aeraRuntime.provisioner.version === ContractVersion.V2 &&
      (requestedWithdrawMode === 'sync' || params.syncWithdrawQuote !== undefined)
    ) {
      requireAeraSyncRedeemRuntime(aeraRuntime);
    }
    const tokenModeSupport = await resolveAeraTokenModeSupport(
      publicClient,
      aeraRuntime,
      token.address,
      { includeSyncModes: requestedWithdrawMode !== 'async' }
    );
    modifiedDepositMode = resolveOperationMode(
      params.vaultId,
      params.syncWithdrawQuote !== undefined ? 'sync' : requestedWithdrawMode,
      {
        async: tokenModeSupport.asyncRedeem,
        sync: tokenModeSupport.syncRedeem,
      }
    );
    if (modifiedDepositMode === 'sync') requireAeraSyncRedeemRuntime(aeraRuntime);
  } else {
    modifiedDepositMode = resolveSyncOnlyOperationMode(params.vaultId, requestedWithdrawMode);
  }

  const withdrawParams = {
    vault,
    receiver: params.receiver ?? account,
    account,
    async: modifiedDepositMode === 'async',
    asset: token,
    publicClient,
    slippageBps,
    solverTip: params.solverTip,
    maxPriceAge: params.maxPriceAge,
    aeraRuntime,
    syncWithdrawQuote: params.syncWithdrawQuote,
    ...('shares' in params && params.shares != null ? { shares: params.shares } : {}),
    ...('amount' in params && params.amount != null ? { amount: params.amount } : {}),
    ...('entireAmount' in params && params.entireAmount ? { entireAmount: true as const } : {}),
  };

  const steps = await adapter.buildWithdraw(withdrawParams as AdapterWithdrawParams);

  return await Promise.all(steps.map((step) => encodeTransactionWithAttribution(client, step)));
}
