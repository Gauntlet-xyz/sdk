import {
  type Address,
  type Client,
  type GetContractReturnType,
  type PublicClient,
  getContract,
} from 'viem';
import { priceAndFeeCalculatorAbi } from '../abis/priceAndFeeCalculator';
import { provisionerAbi } from '../abis/provisioner';
import { MAX_BPS } from '../../constants';

const ROUNDING_FLOOR = 0;
const ROUNDING_CEIL = 1;

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

async function getPriceAndFeeCalculatorAddress(
  client: PublicClient,
  provisioner: Address
): Promise<Address> {
  return getProvisioner(client, provisioner).read.PRICE_FEE_CALCULATOR();
}

async function getTokenDetails(client: PublicClient, provisioner: Address, token: Address) {
  return getProvisioner(client, provisioner).read.tokensDetails([token]);
}

export async function getAsyncDepositUnitsOut(
  client: PublicClient,
  provisioner: Address,
  vault: Address,
  token: Address,
  tokensIn: bigint
): Promise<bigint> {
  const [calculatorAddress, tokenDetails] = await Promise.all([
    getPriceAndFeeCalculatorAddress(client, provisioner),
    getTokenDetails(client, provisioner, token),
  ]);
  const depositMultiplier = BigInt(tokenDetails[3]);
  const adjustedTokensIn = (tokensIn * depositMultiplier) / MAX_BPS;

  return getPriceAndFeeCalculator(client, calculatorAddress).read.convertTokenToUnitsIfActive([
    vault,
    token,
    adjustedTokensIn,
    ROUNDING_FLOOR,
  ]);
}

export async function getAsyncRedeemTokenOut(
  client: PublicClient,
  provisioner: Address,
  vault: Address,
  token: Address,
  unitsIn: bigint
): Promise<bigint> {
  const [calculatorAddress, tokenDetails] = await Promise.all([
    getPriceAndFeeCalculatorAddress(client, provisioner),
    getTokenDetails(client, provisioner, token),
  ]);
  const redeemMultiplier = BigInt(tokenDetails[4]);
  const tokensOut = await getPriceAndFeeCalculator(
    client,
    calculatorAddress
  ).read.convertUnitsToTokenIfActive([vault, token, unitsIn, ROUNDING_FLOOR]);

  return (tokensOut * redeemMultiplier) / MAX_BPS;
}

export async function getAsyncWithdrawUnitsIn(
  client: PublicClient,
  provisioner: Address,
  vault: Address,
  token: Address,
  tokensOut: bigint
): Promise<bigint> {
  const [calculatorAddress, tokenDetails] = await Promise.all([
    getPriceAndFeeCalculatorAddress(client, provisioner),
    getTokenDetails(client, provisioner, token),
  ]);
  const redeemMultiplier = BigInt(tokenDetails[4]);
  const preMultiplierTokensOut = (tokensOut * MAX_BPS + redeemMultiplier - 1n) / redeemMultiplier;

  return getPriceAndFeeCalculator(client, calculatorAddress).read.convertTokenToUnitsIfActive([
    vault,
    token,
    preMultiplierTokensOut,
    ROUNDING_CEIL,
  ]);
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
