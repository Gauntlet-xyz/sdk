import {
  type Address,
  type Client,
  type GetContractReturnType,
  type PublicClient,
  getContract,
} from 'viem';
import { priceAndFeeCalculatorAbi } from '../abis/priceAndFeeCalculator';
import { provisionerAbi } from '../abis/provisioner';
import {
  Rounding,
  convertTokenToUnitsIfActive,
  convertUnitsToTokenIfActive,
} from './priceAndFeeCalculator';
import { MAX_BPS } from '../../constants';
import type { ContractVersion } from '../types';

export type PriceAndFeeCalculatorContract<T extends Client> = GetContractReturnType<
  typeof priceAndFeeCalculatorAbi,
  T,
  Address
>;

export function getPriceAndFeeCalculator<T extends Client>(
  client: T,
  address: Address
): PriceAndFeeCalculatorContract<T> {
  return getContract({
    address,
    abi: priceAndFeeCalculatorAbi,
    client,
  });
}

function getProvisioner<T extends Client>(client: T, address: Address) {
  return getContract({
    address,
    abi: provisionerAbi,
    client,
  });
}

async function getTokenDetails(client: PublicClient, provisioner: Address, token: Address) {
  return getProvisioner(client, provisioner).read.tokensDetails([token]);
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
  const tokenDetails = await getTokenDetails(client, provisioner, token);
  const depositMultiplier = BigInt(tokenDetails[3]);
  const adjustedTokensIn = (tokensIn * depositMultiplier) / MAX_BPS;

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

export async function getAsyncRedeemTokenOut(
  client: PublicClient,
  provisioner: Address,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  unitsIn: bigint
): Promise<bigint> {
  const tokenDetails = await getTokenDetails(client, provisioner, token);
  const redeemMultiplier = BigInt(tokenDetails[4]);
  const tokensOut = await convertUnitsToTokenIfActive(
    client,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    unitsIn,
    Rounding.Floor
  );

  return (tokensOut * redeemMultiplier) / MAX_BPS;
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
  const tokenDetails = await getTokenDetails(client, provisioner, token);
  const redeemMultiplier = BigInt(tokenDetails[4]);
  const preMultiplierTokensOut = (tokensOut * MAX_BPS + redeemMultiplier - 1n) / redeemMultiplier;

  return convertTokenToUnitsIfActive(
    client,
    feeCalculator,
    feeCalculatorVersion,
    vault,
    token,
    preMultiplierTokensOut,
    Rounding.Ceil
  );
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
  account: Address
) {
  return {
    address: provisioner,
    abi: provisionerAbi,
    functionName: 'requestDeposit' as const,
    args: [token, tokensIn, minUnitsOut, solverTip, deadline, maxPriceAge, isFixedPrice] as const,
    account,
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
  account: Address
) {
  return {
    address: provisioner,
    abi: provisionerAbi,
    functionName: 'requestRedeem' as const,
    args: [token, unitsIn, minTokenOut, solverTip, deadline, maxPriceAge, isFixedPrice] as const,
    account,
  };
}
