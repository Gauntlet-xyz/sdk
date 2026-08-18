import type { Address } from 'viem';
import type { GauntletClient } from '../client';
import {
  AccountRequiredError,
  InvalidSlippageBPSError,
  InvalidWithdrawParamsError,
  requireNonZeroSyncWithdrawBound,
  UnsupportedAssetError,
  UnsupportedFeatureError,
  VaultNotFoundError,
} from '../errors';
import { DEFAULT_BPS, MAX_BPS } from '../constants';
import { resolveVault } from './vaults';
import {
  applySlippageDown,
  applySlippageUp,
  requireAeraSyncRedeemRuntime,
  resolveAeraRuntimeContracts,
  resolveAeraTokenModeSupport,
} from './aeraContracts';
import { multiDepositorVaultAbi } from './abis/multiDepositorVault';
import {
  convertNumeraireToToken,
  convertTokenToNumeraire,
} from './aeraContracts/priceAndFeeCalculator';
import {
  getKnownSyncRedeemLiquidityTokens,
  getSyncRedeemEpochState,
  getSyncRedeemRate,
  getSyncRedeemRateContext,
  getSyncRedeemTokenOut,
  getSyncWithdrawUnitsIn,
  getUserUnitsRefundableUntil,
  type SyncRedeemRate,
} from './aeraContracts/v2';
import { resolveOperationMode } from './operationMode';

/** Epoch-cap accounting plus any liquid-token balance known to the caller. */
export interface SyncWithdrawCapacity {
  /** Effective epoch cap (min of relative and absolute), in numeraire. */
  epochCapNumeraire: bigint;
  /** Numeraire already redeemed globally in the current epoch. */
  epochRedeemedNumeraire: bigint;
  /** Remaining global sync redeem capacity this epoch, in numeraire. */
  remainingNumeraire: bigint;
  /** Remaining capacity expressed in the withdraw token. */
  remainingTokens: bigint;
  /** Vault token balance when no pull-funds calldata is configured; otherwise unknown. */
  knownLiquidityTokens?: bigint;
  /** This redemption's size in numeraire (matches the on-chain epoch accounting). */
  requestNumeraire: bigint;
  /** True when this redemption alone exceeds remaining epoch capacity (the tx would revert). */
  exceedsCapacity: boolean;
}

export type SyncWithdrawQuoteRequest =
  | { mode: 'amount'; amount: bigint }
  | { mode: 'shares'; shares: bigint }
  | { mode: 'entireAmount'; account: Address };

export interface SyncWithdrawQuoteContext {
  vaultId: string;
  chainId: number;
  tokenAddress: Address;
  /** Account used for balance and lock reads when the quote is account-scoped. */
  account?: Address;
  /** Slippage tolerance used to derive `minTokensOut` or `maxUnitsIn`. */
  slippageBps: number;
  /** Block snapshot used for all quote reads. */
  blockNumber: bigint;
  /** Exact sizing request that produced this quote. */
  request: SyncWithdrawQuoteRequest;
}

interface SyncWithdrawQuoteDetails {
  /** Vault units (shares) burned: exact for `'redeem'`, estimated for `'withdraw'`. */
  shares: bigint;
  /** Upper bound on shares burned after slippage (equals `shares` for `'redeem'`). */
  maxUnitsIn: bigint;
  /** Tokens received: exact (requested) for `'withdraw'`, estimated for `'redeem'`. */
  tokensOut: bigint;
  /** Lower bound on tokens received after slippage (equals `tokensOut` for `'withdraw'`). */
  minTokensOut: bigint;
  /** Largest exact-token withdrawal that fits `shares`; only set for `'redeem'` quotes. */
  shareSafeTokensOut?: bigint;
  /** Live multiplier breakdown (base, dynamic premium, effective), in bps. */
  rate: SyncRedeemRate;
  capacity: SyncWithdrawCapacity;
  /** Timestamp until which the account's units are locked; undefined when no account was quoted. */
  unitsLockedUntil?: bigint;
  /** Context that must match any transaction build using these quote bounds. */
  context: SyncWithdrawQuoteContext;
}

/** Bounds consumed by one of the two on-chain sync withdraw entry points. */
export type SyncWithdrawQuoteBounds =
  | {
      kind: 'redeem';
      shares: bigint;
      minTokensOut: bigint;
      context: SyncWithdrawQuoteContext;
    }
  | {
      kind: 'withdraw';
      tokensOut: bigint;
      maxUnitsIn: bigint;
      context: SyncWithdrawQuoteContext;
    };

/**
 * A live quote for an instant (sync) withdraw.
 *
 * `kind` distinguishes the two on-chain entry points:
 * - `'redeem'`: exact shares burned, estimated tokens out (used for by-shares / entire-balance exits)
 * - `'withdraw'`: exact tokens out, estimated shares burned (used for by-token-amount exits)
 */
export type SyncWithdrawQuote =
  | (SyncWithdrawQuoteDetails & { kind: 'redeem' })
  | (SyncWithdrawQuoteDetails & { kind: 'withdraw' });

export type SyncWithdrawRateParams = {
  vaultId: string;
  /** EVM chain ID. Defaults to the vault's primary chain (Base for current multichain vaults). */
  chainId?: number;
  /** Required for multiasset vaults. */
  assetSymbol?: string;
};

type SyncWithdrawQuoteBaseParams = SyncWithdrawRateParams & {
  /** Optional for explicit amount/shares quotes; required for full-position quotes. */
  account?: Address;
  /**
   * Slippage tolerance in basis points (e.g. 100 = 1%). Defaults to 100.
   * A value of 10000 is invalid for share-sized quotes because it makes `minTokensOut` zero.
   */
  slippageBps?: number;
};

export type SyncWithdrawQuoteParams =
  | (SyncWithdrawQuoteBaseParams & { shares: bigint; amount?: never; entireAmount?: never })
  | (SyncWithdrawQuoteBaseParams & { amount: bigint; shares?: never; entireAmount?: never })
  | (SyncWithdrawQuoteBaseParams & {
      account: Address;
      entireAmount: true;
      shares?: never;
      amount?: never;
    });

function validateSyncWithdrawQuoteParams(params: SyncWithdrawQuoteParams) {
  const modes = [
    'amount' in params && params.amount != null,
    'shares' in params && params.shares != null,
    'entireAmount' in params && params.entireAmount === true,
  ].filter(Boolean).length;

  if (modes !== 1) throw new InvalidWithdrawParamsError();
  if ('entireAmount' in params && params.entireAmount === true && !params.account) {
    throw new AccountRequiredError();
  }
}

async function resolveSyncWithdrawContext(
  client: GauntletClient,
  params: SyncWithdrawRateParams,
  readKind: 'quote' | 'rate'
) {
  const resolved = await resolveVault(client, params.vaultId, params.chainId);
  if (!resolved) throw new VaultNotFoundError(params.vaultId);

  const { vault, protocol } = resolved;
  if (protocol !== 'aera') {
    throw new UnsupportedFeatureError(
      readKind === 'quote'
        ? 'Sync withdraw quote is only available for Aera vaults'
        : 'Sync withdraw rate is only available for Aera vaults'
    );
  }

  const chainId = params.chainId ?? vault.chainId;
  const publicClient = client.getPublicClient(chainId);
  const token =
    vault.supplyToken.length > 1
      ? vault.supplyToken.find((tInfo) => tInfo.symbol === params.assetSymbol)
      : vault.supplyToken[0];
  if (token === undefined) {
    throw new UnsupportedAssetError(params.assetSymbol ?? 'unknown', params.vaultId);
  }

  const quoteBlock = await publicClient.getBlock();
  if (quoteBlock.number === null) {
    throw new UnsupportedFeatureError(
      readKind === 'quote'
        ? 'Aera: sync withdraw quote requires a numbered block'
        : 'Aera: sync withdraw rate requires a numbered block'
    );
  }
  const readContext = {
    blockNumber: quoteBlock.number,
    blockTimestamp: BigInt(quoteBlock.timestamp),
  };

  const runtime = await resolveAeraRuntimeContracts(publicClient, vault, readContext);
  requireAeraSyncRedeemRuntime(runtime);

  const support = await resolveAeraTokenModeSupport(
    publicClient,
    runtime,
    token.address,
    readContext
  );
  resolveOperationMode(params.vaultId, 'sync', {
    async: support.asyncRedeem,
    sync: support.syncRedeem,
  });

  return { publicClient, vault, token, runtime, chainId, readContext };
}

/** Reads the live instant-withdraw fee rate without requiring a withdrawal amount or account. */
export async function getSyncWithdrawRate(
  client: GauntletClient,
  params: SyncWithdrawRateParams
): Promise<SyncRedeemRate> {
  const { publicClient, vault, token, runtime, readContext } = await resolveSyncWithdrawContext(
    client,
    params,
    'rate'
  );

  return getSyncRedeemRate(
    publicClient,
    runtime.provisioner.address,
    vault.vaultAddress,
    token.address,
    runtime.feeCalculator.address,
    readContext
  );
}

/**
 * Builds a live quote for an instant (sync) withdraw without sending a transaction.
 *
 * Surfaces everything the on-chain `redeem`/`withdraw` would apply or check but that a plain
 * transaction build does not pre-validate: the effective rate (including the price-age dynamic
 * premium), slippage bounds, the global per-epoch redeem capacity, any known vault-balance limit,
 * and whether the caller's units are still locked from a recent sync deposit.
 *
 * @throws {VaultNotFoundError} If the vault ID is not found.
 * @throws {UnsupportedAssetError} If the asset symbol is not accepted by the vault.
 * @throws {UnsupportedFeatureError} If the vault is not an Aera V2 deployment.
 * @throws {UnsupportedDepositModeError} If sync redeem is not enabled for the token.
 * @throws {StalePriceError} If the oracle price is too stale for an instant redeem.
 */
export async function getSyncWithdrawQuote(
  client: GauntletClient,
  params: SyncWithdrawQuoteParams
): Promise<SyncWithdrawQuote> {
  validateSyncWithdrawQuoteParams(params);

  if (
    params.slippageBps !== undefined &&
    (!Number.isInteger(params.slippageBps) ||
      params.slippageBps < 0 ||
      params.slippageBps > Number(MAX_BPS))
  ) {
    throw new InvalidSlippageBPSError(params.slippageBps);
  }
  const slippageBps = params.slippageBps ?? DEFAULT_BPS;

  const {
    publicClient,
    vault,
    token,
    runtime,
    chainId,
    readContext: quoteReadContext,
  } = await resolveSyncWithdrawContext(client, params, 'quote');

  const provisioner = runtime.provisioner.address;
  const feeCalculator = runtime.feeCalculator.address;
  const feeVersion = runtime.feeCalculator.version;
  const vaultAddress = vault.vaultAddress;

  const { rate, hasPullFundsSubmitData } = await getSyncRedeemRateContext(
    publicClient,
    provisioner,
    vaultAddress,
    token.address,
    feeCalculator,
    quoteReadContext
  );

  let kind: SyncWithdrawQuote['kind'];
  let shares: bigint;
  let tokensOut: bigint;
  let minTokensOut: bigint;
  let maxUnitsIn: bigint;
  let request: SyncWithdrawQuoteRequest;
  let shareSafeTokensOut: bigint | undefined;

  if ('amount' in params && params.amount != null) {
    // Exact token out: shares burned is the estimate, bounded above by slippage.
    kind = 'withdraw';
    request = { mode: 'amount', amount: params.amount };
    tokensOut = params.amount;
    requireNonZeroSyncWithdrawBound(tokensOut, 'tokensOut');
    minTokensOut = params.amount;
    shares = await getSyncWithdrawUnitsIn(
      publicClient,
      provisioner,
      feeCalculator,
      feeVersion,
      vaultAddress,
      token.address,
      params.amount,
      rate.effectiveMultiplierBps,
      quoteReadContext
    );
    maxUnitsIn = applySlippageUp(shares, slippageBps);
    requireNonZeroSyncWithdrawBound(maxUnitsIn, 'maxUnitsIn');
  } else {
    // Exact shares in: tokens out is the estimate, bounded below by slippage.
    kind = 'redeem';
    if ('entireAmount' in params && params.entireAmount) {
      if (!params.account) throw new AccountRequiredError();
      request = { mode: 'entireAmount', account: params.account };
      shares = await publicClient.readContract({
        address: vaultAddress,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [params.account],
        blockNumber: quoteReadContext.blockNumber,
      });
    } else if ('shares' in params && params.shares != null) {
      request = { mode: 'shares', shares: params.shares };
      shares = params.shares;
    } else {
      throw new InvalidWithdrawParamsError();
    }
    requireNonZeroSyncWithdrawBound(shares, 'unitsIn');
    const getTokensOut = (unitsIn: bigint) =>
      getSyncRedeemTokenOut(
        publicClient,
        provisioner,
        feeCalculator,
        feeVersion,
        vaultAddress,
        token.address,
        unitsIn,
        rate.effectiveMultiplierBps,
        quoteReadContext
      );
    // A capacity-limited Max is submitted as an exact-token withdraw. Reserve slippage headroom so
    // its maximum share cost cannot exceed the user's share balance.
    const shareSafeUnitsIn = (shares * MAX_BPS) / (MAX_BPS + BigInt(slippageBps));
    const tokensOutPromise = getTokensOut(shares);
    const shareSafeTokensOutPromise =
      shareSafeUnitsIn === shares ? tokensOutPromise : getTokensOut(shareSafeUnitsIn);
    [tokensOut, shareSafeTokensOut] = await Promise.all([
      tokensOutPromise,
      shareSafeTokensOutPromise,
    ]);
    minTokensOut = applySlippageDown(tokensOut, slippageBps);
    requireNonZeroSyncWithdrawBound(minTokensOut, 'minTokensOut');
    maxUnitsIn = shares;
  }

  const [epoch, requestNumeraire, unitsLockedUntil, knownLiquidityTokens] = await Promise.all([
    getSyncRedeemEpochState(publicClient, provisioner, quoteReadContext),
    convertTokenToNumeraire(
      publicClient,
      feeCalculator,
      feeVersion,
      vaultAddress,
      token.address,
      tokensOut,
      quoteReadContext
    ),
    params.account
      ? getUserUnitsRefundableUntil(publicClient, provisioner, params.account, quoteReadContext)
      : Promise.resolve(undefined),
    getKnownSyncRedeemLiquidityTokens(
      publicClient,
      vaultAddress,
      token.address,
      hasPullFundsSubmitData,
      quoteReadContext
    ),
  ]);

  const remainingNumeraire =
    epoch.epochCapNumeraire > epoch.epochRedeemedNumeraire
      ? epoch.epochCapNumeraire - epoch.epochRedeemedNumeraire
      : 0n;
  const remainingTokens = await convertNumeraireToToken(
    publicClient,
    feeCalculator,
    feeVersion,
    vaultAddress,
    token.address,
    remainingNumeraire,
    quoteReadContext
  );
  const quoteDetails: SyncWithdrawQuoteDetails = {
    shares,
    maxUnitsIn,
    tokensOut,
    minTokensOut,
    shareSafeTokensOut,
    rate,
    capacity: {
      epochCapNumeraire: epoch.epochCapNumeraire,
      epochRedeemedNumeraire: epoch.epochRedeemedNumeraire,
      remainingNumeraire,
      remainingTokens,
      knownLiquidityTokens,
      requestNumeraire,
      exceedsCapacity: requestNumeraire > remainingNumeraire,
    },
    unitsLockedUntil,
    context: {
      vaultId: params.vaultId,
      chainId,
      tokenAddress: token.address,
      ...(params.account ? { account: params.account } : {}),
      slippageBps,
      blockNumber: quoteReadContext.blockNumber,
      request,
    },
  };

  if (kind === 'redeem') return { kind, ...quoteDetails };
  return { kind, ...quoteDetails };
}
