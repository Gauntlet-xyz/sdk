import {
  type Address,
  type Client,
  type GetContractReturnType,
  type PublicClient,
  getContract,
} from 'viem';
import { priceAndFeeCalculatorV2Abi } from '../abis/priceAndFeeCalculatorV2';
import { provisionerV2Abi } from '../abis/provisionerV2';
import {
  Rounding,
  convertTokenToUnitsIfActive,
  convertUnitsToTokenIfActive,
} from './priceAndFeeCalculator';
import { MAX_BPS } from '../../constants';
import { StalePriceError } from '../../errors';
import type { ContractVersion } from '../types';

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

function getProvisioner<T extends Client>(client: T, address: Address) {
  return getContract({
    address,
    abi: provisionerV2Abi,
    client,
  });
}

async function getTokenDetails(client: PublicClient, provisioner: Address, token: Address) {
  return getProvisioner(client, provisioner).read.tokensDetails([token]);
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
}: {
  client: PublicClient;
  provisioner: Address;
  feeCalculator: Address;
  feeCalculatorVersion: ContractVersion;
  vault: Address;
  token: Address;
  tokensIn: bigint;
  multiplierIndex: 4 | 6;
}): Promise<bigint> {
  const tokenDetails = await getTokenDetails(client, provisioner, token);
  const multiplier = BigInt(tokenDetails[multiplierIndex]);
  const adjustedTokensIn = (tokensIn * multiplier) / MAX_BPS;

  return convertTokenToUnitsIfActive(
    client,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    adjustedTokensIn,
    Rounding.Floor
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
}: {
  client: PublicClient;
  provisioner: Address;
  feeCalculator: Address;
  feeCalculatorVersion: ContractVersion;
  vault: Address;
  token: Address;
  unitsIn: bigint;
  multiplierIndex: 5 | 7;
}): Promise<bigint> {
  const [tokenDetails, tokensOut] = await Promise.all([
    getTokenDetails(client, provisioner, token),
    convertUnitsToTokenIfActive(
      client,
      feeCalculator,
      feeCalculatorVersion,
      vault,
      token,
      unitsIn,
      Rounding.Floor
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
}: {
  client: PublicClient;
  provisioner: Address;
  feeCalculator: Address;
  feeCalculatorVersion: ContractVersion;
  vault: Address;
  token: Address;
  tokensOut: bigint;
  multiplierIndex: 5 | 7;
}): Promise<bigint> {
  const tokenDetails = await getTokenDetails(client, provisioner, token);
  const multiplier = BigInt(tokenDetails[multiplierIndex]);
  const preMultiplierTokens = (tokensOut * MAX_BPS + multiplier - 1n) / multiplier;

  return convertTokenToUnitsIfActive(
    client,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    preMultiplierTokens,
    Rounding.Ceil
  );
}

async function getSyncRedeemMultiplier(
  client: PublicClient,
  provisioner: Address,
  vault: Address,
  token: Address,
  feeCalculator: Address
): Promise<bigint> {
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
  });
  const block = await client.getBlock();
  const syncRedeemMultiplier = BigInt(tokenDetails[7]);
  const maxPriceAge = BigInt(syncRedeemDetails[0]);
  const maxDynamicPremiumBps = BigInt(syncRedeemDetails[2]);
  const blockTimestamp = BigInt(block.timestamp);
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

  return syncRedeemMultiplier - dynamicPremiumBps;
}

export async function getSyncRedeemTokenOut(
  client: PublicClient,
  provisioner: Address,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  unitsIn: bigint
): Promise<bigint> {
  const [tokenAmount, multiplier] = await Promise.all([
    convertUnitsToTokenIfActive(
      client,
      feeCalculator,
      feeCalculatorVersion,
      vault,
      token,
      unitsIn,
      Rounding.Floor
    ),
    getSyncRedeemMultiplier(client, provisioner, vault, token, feeCalculator),
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
  tokensOut: bigint
): Promise<bigint> {
  const multiplier = await getSyncRedeemMultiplier(
    client,
    provisioner,
    vault,
    token,
    feeCalculator
  );
  const prePremiumTokens = (tokensOut * MAX_BPS + multiplier - 1n) / multiplier;

  return convertTokenToUnitsIfActive(
    client,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    prePremiumTokens,
    Rounding.Ceil
  );
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
