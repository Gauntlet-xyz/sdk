/**
 *  CODE PULLED FROM AERA-V3-TS-SDK in gauntlet/apps/packages/aera-v3-ts-sdk
 *  pulled in here with the goal to have this SDK replace the previous
 */
import { type Address, type Client, type GetContractReturnType, getContract } from 'viem';
import { multiDepositorVaultAbi } from './abis/multiDepositorVault';
import { priceAndFeeCalculatorAbi } from './abis/priceAndFeeCalculator';
import { provisionerAbi } from './abis/provisioner';

export type MultiDepositorVaultContract<T extends Client> = GetContractReturnType<
  typeof multiDepositorVaultAbi,
  T,
  Address
>;

export function getMultiDepositorVault<T extends Client>(
  client: T,
  vaultAddress: Address
): MultiDepositorVaultContract<T> {
  return getContract({
    address: vaultAddress,
    abi: multiDepositorVaultAbi,
    client,
  });
}

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
