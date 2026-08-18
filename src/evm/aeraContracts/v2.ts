import {
  type Address,
  type Client,
  type GetContractReturnType,
  type PublicClient,
  getContract,
  zeroAddress,
} from 'viem';
import { erc20Abi } from '../abis/erc20';
import { priceAndFeeCalculatorV2Abi } from '../abis/priceAndFeeCalculatorV2';
import { provisionerV2Abi } from '../abis/provisionerV2';
import {
  Rounding,
  convertTokenToUnitsIfActive,
  convertUnitsToTokenIfActive,
} from './priceAndFeeCalculator';
import { MAX_BPS } from '../../constants';
import { StalePriceError, UnsupportedFeatureError } from '../../errors';
import type { ContractVersion } from '../types';
import { readAtBlock } from './readOptions';

export type PriceAndFeeCalculatorContract<T extends Client> = GetContractReturnType<
  typeof priceAndFeeCalculatorV2Abi,
  T,
  Address
>;

export function getPriceAndFeeCalculator<T extends Client>(
  client: T,
  address: Address
): PriceAndFeeCalculatorContract<T> {
  return getContract({
    address,
    abi: priceAndFeeCalculatorV2Abi,
    client,
  });
}

type SyncRedeemReadOptions = {
  blockNumber?: bigint;
  blockTimestamp?: bigint;
};

async function resolveReadContext(
  client: PublicClient,
  options: SyncRedeemReadOptions = {}
): Promise<Required<SyncRedeemReadOptions>> {
  if (options.blockNumber !== undefined && options.blockTimestamp !== undefined) {
    return { blockNumber: options.blockNumber, blockTimestamp: options.blockTimestamp };
  }

  const block =
    options.blockNumber === undefined ? await client.getBlock() : await client.getBlock(options);
  if (block.number === null) {
    throw new UnsupportedFeatureError('Aera: sync redeem reads require a numbered block');
  }

  return {
    blockNumber: options.blockNumber ?? block.number,
    blockTimestamp: options.blockTimestamp ?? BigInt(block.timestamp),
  };
}

async function getTokenDetails(
  client: PublicClient,
  provisioner: Address,
  token: Address,
  options: SyncRedeemReadOptions = {}
) {
  return client.readContract({
    address: provisioner,
    abi: provisionerV2Abi,
    functionName: 'tokensDetails',
    args: [token],
    ...readAtBlock(options),
  });
}

/**
 * Returns the vault's currently known sync-redeem liquidity in tokens.
 *
 * When a pull-funds pointer is configured, the provisioner may source more tokens during the
 * redemption, so the vault's current token balance is not a reliable liquidity limit.
 */
export async function getKnownSyncRedeemLiquidityTokens(
  client: PublicClient,
  vault: Address,
  token: Address,
  hasPullFundsSubmitData: boolean,
  options: SyncRedeemReadOptions = {}
): Promise<bigint | undefined> {
  if (hasPullFundsSubmitData) return undefined;

  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [vault],
    ...readAtBlock(options),
  });
}

async function getDepositUnitsOut({
  client,
  provisioner,
  feeCalculator,
  feeCalculatorVersion,
  vault,
  token,
  tokensIn,
  multiplierIndex,
  options,
}: {
  client: PublicClient;
  provisioner: Address;
  feeCalculator: Address;
  feeCalculatorVersion: ContractVersion;
  vault: Address;
  token: Address;
  tokensIn: bigint;
  multiplierIndex: 4 | 6;
  options?: SyncRedeemReadOptions;
}): Promise<bigint> {
  const tokenDetails = await getTokenDetails(client, provisioner, token, options);
  const multiplier = BigInt(tokenDetails[multiplierIndex]);
  const adjustedTokensIn = (tokensIn * multiplier) / MAX_BPS;

  return convertTokenToUnitsIfActive(
    client,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    adjustedTokensIn,
    Rounding.Floor,
    options
  );
}

async function getRedeemTokenOut({
  client,
  provisioner,
  feeCalculator,
  feeCalculatorVersion,
  vault,
  token,
  unitsIn,
  multiplierIndex,
  options,
}: {
  client: PublicClient;
  provisioner: Address;
  feeCalculator: Address;
  feeCalculatorVersion: ContractVersion;
  vault: Address;
  token: Address;
  unitsIn: bigint;
  multiplierIndex: 5 | 7;
  options?: SyncRedeemReadOptions;
}): Promise<bigint> {
  const [tokenDetails, tokensOut] = await Promise.all([
    getTokenDetails(client, provisioner, token, options),
    convertUnitsToTokenIfActive(
      client,
      feeCalculator,
      feeCalculatorVersion,
      vault,
      token,
      unitsIn,
      Rounding.Floor,
      options
    ),
  ]);
  const multiplier = BigInt(tokenDetails[multiplierIndex]);

  return (tokensOut * multiplier) / MAX_BPS;
}

async function getWithdrawUnitsIn({
  client,
  provisioner,
  feeCalculator,
  feeCalculatorVersion,
  vault,
  token,
  tokensOut,
  multiplierIndex,
  options,
}: {
  client: PublicClient;
  provisioner: Address;
  feeCalculator: Address;
  feeCalculatorVersion: ContractVersion;
  vault: Address;
  token: Address;
  tokensOut: bigint;
  multiplierIndex: 5 | 7;
  options?: SyncRedeemReadOptions;
}): Promise<bigint> {
  const tokenDetails = await getTokenDetails(client, provisioner, token, options);
  const multiplier = BigInt(tokenDetails[multiplierIndex]);
  const preMultiplierTokens = (tokensOut * MAX_BPS + multiplier - 1n) / multiplier;

  return convertTokenToUnitsIfActive(
    client,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    preMultiplierTokens,
    Rounding.Ceil,
    options
  );
}

/** Breakdown of the effective sync redeem multiplier, in basis points. */
export interface SyncRedeemRate {
  /** Base sync redeem multiplier (tokensDetails.syncRedeemMultiplier). */
  baseMultiplierBps: bigint;
  /** Dynamic premium charged for the current oracle price age. */
  dynamicPremiumBps: bigint;
  /** Multiplier actually applied to size the redemption (base - dynamic premium). */
  effectiveMultiplierBps: bigint;
}

/**
 * Reads the live sync redeem rate and whether pull-funds calldata is configured.
 *
 * Both values come from the same token-details read, avoiding another RPC request when a quote
 * needs to determine whether the vault balance is a reliable liquidity limit.
 *
 * @throws {StalePriceError} If the oracle price is older than the configured max age,
 *   in which case the on-chain sync redeem would revert.
 */
export async function getSyncRedeemRateContext(
  client: PublicClient,
  provisioner: Address,
  vault: Address,
  token: Address,
  feeCalculator: Address,
  options: SyncRedeemReadOptions = {}
): Promise<{ rate: SyncRedeemRate; hasPullFundsSubmitData: boolean }> {
  const readContext = await resolveReadContext(client, options);
  const [tokenDetails, syncRedeemDetails, anchorTimestamp] = await client.multicall({
    contracts: [
      {
        address: provisioner,
        abi: provisionerV2Abi,
        functionName: 'tokensDetails',
        args: [token],
      },
      {
        address: provisioner,
        abi: provisionerV2Abi,
        functionName: 'getSyncRedeemDetails',
      },
      {
        address: feeCalculator,
        abi: priceAndFeeCalculatorV2Abi,
        functionName: 'getAnchorTimestamp',
        args: [vault],
      },
    ],
    allowFailure: false,
    blockNumber: readContext.blockNumber,
  });
  const baseMultiplierBps = BigInt(tokenDetails[7]);
  const maxPriceAge = BigInt(syncRedeemDetails[0]);
  const maxDynamicPremiumBps = BigInt(syncRedeemDetails[2]);
  const blockTimestamp = readContext.blockTimestamp;
  const priceTimestamp = BigInt(anchorTimestamp);

  if (priceTimestamp + maxPriceAge < blockTimestamp) {
    throw new StalePriceError({
      blockTimestamp,
      maxPriceAge,
      priceTimestamp,
    });
  }

  const dynamicPremiumBps =
    maxDynamicPremiumBps === 0n || maxPriceAge === 0n
      ? 0n
      : ((blockTimestamp - priceTimestamp) * maxDynamicPremiumBps + maxPriceAge - 1n) / maxPriceAge;

  return {
    rate: {
      baseMultiplierBps,
      dynamicPremiumBps,
      effectiveMultiplierBps: baseMultiplierBps - dynamicPremiumBps,
    },
    hasPullFundsSubmitData: tokenDetails[9] !== zeroAddress,
  };
}

/** Preserves the existing rate-only API for callers that do not need pull-funds state. */
export async function getSyncRedeemRate(
  client: PublicClient,
  provisioner: Address,
  vault: Address,
  token: Address,
  feeCalculator: Address,
  options: SyncRedeemReadOptions = {}
): Promise<SyncRedeemRate> {
  return (await getSyncRedeemRateContext(client, provisioner, vault, token, feeCalculator, options))
    .rate;
}

async function getSyncRedeemMultiplier(
  client: PublicClient,
  provisioner: Address,
  vault: Address,
  token: Address,
  feeCalculator: Address,
  options: SyncRedeemReadOptions = {}
): Promise<bigint> {
  return (await getSyncRedeemRate(client, provisioner, vault, token, feeCalculator, options))
    .effectiveMultiplierBps;
}

export async function getSyncRedeemTokenOut(
  client: PublicClient,
  provisioner: Address,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  unitsIn: bigint,
  effectiveMultiplierBps?: bigint,
  options: SyncRedeemReadOptions = {}
): Promise<bigint> {
  const readContext =
    effectiveMultiplierBps === undefined ? await resolveReadContext(client, options) : options;
  const [tokenAmount, multiplier] = await Promise.all([
    convertUnitsToTokenIfActive(
      client,
      feeCalculator,
      feeCalculatorVersion,
      vault,
      token,
      unitsIn,
      Rounding.Floor,
      readContext
    ),
    effectiveMultiplierBps !== undefined
      ? Promise.resolve(effectiveMultiplierBps)
      : getSyncRedeemMultiplier(client, provisioner, vault, token, feeCalculator, readContext),
  ]);

  return (tokenAmount * multiplier) / MAX_BPS;
}

export async function getAsyncDepositUnitsOut(
  client: PublicClient,
  provisioner: Address,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  tokensIn: bigint
): Promise<bigint> {
  return getDepositUnitsOut({
    client,
    provisioner,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    tokensIn,
    multiplierIndex: 4,
  });
}

export async function getSyncDepositUnitsOut(
  client: PublicClient,
  provisioner: Address,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  tokensIn: bigint
): Promise<bigint> {
  return getDepositUnitsOut({
    client,
    provisioner,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    tokensIn,
    multiplierIndex: 6,
  });
}

export async function getAsyncRedeemTokenOut(
  client: PublicClient,
  provisioner: Address,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  unitsIn: bigint
): Promise<bigint> {
  return getRedeemTokenOut({
    client,
    provisioner,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    unitsIn,
    multiplierIndex: 5,
  });
}

export async function getAsyncWithdrawUnitsIn(
  client: PublicClient,
  provisioner: Address,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  tokensOut: bigint
): Promise<bigint> {
  return getWithdrawUnitsIn({
    client,
    provisioner,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    tokensOut,
    multiplierIndex: 5,
  });
}

export async function getSyncWithdrawUnitsIn(
  client: PublicClient,
  provisioner: Address,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  tokensOut: bigint,
  effectiveMultiplierBps?: bigint,
  options: SyncRedeemReadOptions = {}
): Promise<bigint> {
  const readContext =
    effectiveMultiplierBps === undefined ? await resolveReadContext(client, options) : options;
  const multiplier =
    effectiveMultiplierBps ??
    (await getSyncRedeemMultiplier(client, provisioner, vault, token, feeCalculator, readContext));
  const prePremiumTokens = (tokensOut * MAX_BPS + multiplier - 1n) / multiplier;

  return convertTokenToUnitsIfActive(
    client,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    prePremiumTokens,
    Rounding.Ceil,
    readContext
  );
}

/** Current sync redeem epoch accounting, in numeraire (all values uint256). */
export interface SyncRedeemEpochState {
  epochTimestamp: bigint;
  epochStartTvlNumeraire: bigint;
  epochRedeemedNumeraire: bigint;
  epochCapNumeraire: bigint;
}

export async function getSyncRedeemEpochState(
  client: PublicClient,
  provisioner: Address,
  options: SyncRedeemReadOptions = {}
): Promise<SyncRedeemEpochState> {
  const [epochTimestamp, epochStartTvlNumeraire, epochRedeemedNumeraire, epochCapNumeraire] =
    await client.readContract({
      address: provisioner,
      abi: provisionerV2Abi,
      functionName: 'getSyncRedeemEpochState',
      ...readAtBlock(options),
    });

  return { epochTimestamp, epochStartTvlNumeraire, epochRedeemedNumeraire, epochCapNumeraire };
}

/**
 * Raw expiry timestamp for the user's latest sync-deposit lock (0 if none was recorded).
 * The user is locked while this value is greater than or equal to the relevant block timestamp.
 */
export async function getUserUnitsRefundableUntil(
  client: PublicClient,
  provisioner: Address,
  user: Address,
  options: SyncRedeemReadOptions = {}
): Promise<bigint> {
  return client.readContract({
    address: provisioner,
    abi: provisionerV2Abi,
    functionName: 'userUnitsRefundableUntil',
    args: [user],
    ...readAtBlock(options),
  });
}

export function depositTxRequest(
  provisioner: Address,
  token: Address,
  tokensIn: bigint,
  minUnitsOut: bigint,
  receiver: Address,
  account: Address
) {
  return {
    address: provisioner,
    abi: provisionerV2Abi,
    functionName: 'deposit' as const,
    args: [token, tokensIn, minUnitsOut, receiver] as const,
    account,
  };
}

export function requestDepositTxRequest(
  provisioner: Address,
  token: Address,
  tokensIn: bigint,
  minUnitsOut: bigint,
  solverTip: bigint,
  deadline: bigint,
  maxPriceAge: bigint,
  isFixedPrice: boolean,
  receiver: Address,
  account: Address
) {
  return {
    address: provisioner,
    abi: provisionerV2Abi,
    functionName: 'requestDeposit' as const,
    args: [
      token,
      tokensIn,
      minUnitsOut,
      solverTip,
      deadline,
      maxPriceAge,
      isFixedPrice,
      receiver,
    ] as const,
    account,
  };
}

export function setDepositReceiverApprovalTxRequest(
  provisioner: Address,
  depositor: Address,
  approved: boolean,
  receiver: Address
) {
  return {
    address: provisioner,
    abi: provisionerV2Abi,
    functionName: 'setDepositReceiverApproval' as const,
    args: [depositor, approved] as const,
    account: receiver,
  };
}

export function requestRedeemTxRequest(
  provisioner: Address,
  token: Address,
  unitsIn: bigint,
  minTokenOut: bigint,
  solverTip: bigint,
  deadline: bigint,
  maxPriceAge: bigint,
  isFixedPrice: boolean,
  receiver: Address,
  account: Address
) {
  return {
    address: provisioner,
    abi: provisionerV2Abi,
    functionName: 'requestRedeem' as const,
    args: [
      token,
      unitsIn,
      minTokenOut,
      solverTip,
      deadline,
      maxPriceAge,
      isFixedPrice,
      receiver,
    ] as const,
    account,
  };
}

export function redeemTxRequest(
  provisioner: Address,
  token: Address,
  unitsIn: bigint,
  minTokenOut: bigint,
  receiver: Address,
  account: Address
) {
  return {
    address: provisioner,
    abi: provisionerV2Abi,
    functionName: 'redeem' as const,
    args: [token, unitsIn, minTokenOut, receiver] as const,
    account,
  };
}

export function withdrawTxRequest(
  provisioner: Address,
  token: Address,
  tokensOut: bigint,
  maxUnitsIn: bigint,
  receiver: Address,
  account: Address
) {
  return {
    address: provisioner,
    abi: provisionerV2Abi,
    functionName: 'withdraw' as const,
    args: [token, tokensOut, maxUnitsIn, receiver] as const,
    account,
  };
}
