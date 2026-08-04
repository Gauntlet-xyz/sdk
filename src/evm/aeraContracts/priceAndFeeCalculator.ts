import type { Address, PublicClient } from 'viem';
import { UnsupportedFeatureError } from '../../errors';
import { priceAndFeeCalculatorAbi } from '../abis/priceAndFeeCalculator';
import { priceAndFeeCalculatorV2Abi } from '../abis/priceAndFeeCalculatorV2';
import { ContractVersion } from '../types';
import { readAtBlock } from './readOptions';

const ROUNDING_FLOOR = 0;
const ROUNDING_CEIL = 1;

export interface NormalizedVaultPriceState {
  paused: boolean;
  unitPrice: bigint;
  timestamp: number;
}

type AeraPriceReadOptions = {
  blockNumber?: bigint;
};

function toNumber(value: bigint | number): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

function normalizeVaultPriceState<
  TState extends { paused: boolean } & (
    | { unitPrice: bigint; timestamp: bigint | number }
    | {
        anchorPrice: bigint;
        driftPrice: bigint;
        anchorTimestamp: bigint | number;
        driftTimestamp: bigint | number;
      }
  ),
>(priceState: TState): TState & NormalizedVaultPriceState {
  if ('unitPrice' in priceState) {
    return {
      ...priceState,
      unitPrice: priceState.unitPrice,
      timestamp: toNumber(priceState.timestamp),
    } as TState & NormalizedVaultPriceState;
  }

  const anchorTimestamp = toNumber(priceState.anchorTimestamp);
  const driftTimestamp = toNumber(priceState.driftTimestamp);
  const useDriftPrice = driftTimestamp >= anchorTimestamp;

  return {
    ...priceState,
    unitPrice: useDriftPrice ? priceState.driftPrice : priceState.anchorPrice,
    timestamp: useDriftPrice ? driftTimestamp : anchorTimestamp,
  } as TState & NormalizedVaultPriceState;
}

export async function convertTokenToUnitsIfActive(
  client: PublicClient,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  tokenAmount: bigint,
  rounding: typeof ROUNDING_FLOOR | typeof ROUNDING_CEIL,
  options: AeraPriceReadOptions = {}
): Promise<bigint> {
  if (feeCalculatorVersion === ContractVersion.V2) {
    return client.readContract({
      address: feeCalculator,
      abi: priceAndFeeCalculatorV2Abi,
      functionName: 'convertTokenToUnitsIfActive',
      args: [vault, token, tokenAmount, rounding],
      ...readAtBlock(options),
    });
  }

  return client.readContract({
    address: feeCalculator,
    abi: priceAndFeeCalculatorAbi,
    functionName: 'convertTokenToUnitsIfActive',
    args: [vault, token, tokenAmount, rounding],
    ...readAtBlock(options),
  });
}

export async function convertUnitsToTokenIfActive(
  client: PublicClient,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  unitsAmount: bigint,
  rounding: typeof ROUNDING_FLOOR | typeof ROUNDING_CEIL,
  options: AeraPriceReadOptions = {}
): Promise<bigint> {
  if (feeCalculatorVersion === ContractVersion.V2) {
    return client.readContract({
      address: feeCalculator,
      abi: priceAndFeeCalculatorV2Abi,
      functionName: 'convertUnitsToTokenIfActive',
      args: [vault, token, unitsAmount, rounding],
      ...readAtBlock(options),
    });
  }

  return client.readContract({
    address: feeCalculator,
    abi: priceAndFeeCalculatorAbi,
    functionName: 'convertUnitsToTokenIfActive',
    args: [vault, token, unitsAmount, rounding],
    ...readAtBlock(options),
  });
}

export async function convertTokenToUnits(
  client: PublicClient,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  tokenAmount: bigint,
  options: AeraPriceReadOptions = {}
): Promise<bigint> {
  if (feeCalculatorVersion === ContractVersion.V2) {
    return client.readContract({
      address: feeCalculator,
      abi: priceAndFeeCalculatorV2Abi,
      functionName: 'convertTokenToUnits',
      args: [vault, token, tokenAmount],
      ...readAtBlock(options),
    });
  }

  return client.readContract({
    address: feeCalculator,
    abi: priceAndFeeCalculatorAbi,
    functionName: 'convertTokenToUnits',
    args: [vault, token, tokenAmount],
    ...readAtBlock(options),
  });
}

export async function convertUnitsToToken(
  client: PublicClient,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  unitsAmount: bigint,
  options: AeraPriceReadOptions = {}
): Promise<bigint> {
  if (feeCalculatorVersion === ContractVersion.V2) {
    return client.readContract({
      address: feeCalculator,
      abi: priceAndFeeCalculatorV2Abi,
      functionName: 'convertUnitsToToken',
      args: [vault, token, unitsAmount],
      ...readAtBlock(options),
    });
  }

  return client.readContract({
    address: feeCalculator,
    abi: priceAndFeeCalculatorAbi,
    functionName: 'convertUnitsToToken',
    args: [vault, token, unitsAmount],
    ...readAtBlock(options),
  });
}

export async function convertTokenToNumeraire(
  client: PublicClient,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  tokenAmount: bigint,
  options: AeraPriceReadOptions = {}
): Promise<bigint> {
  if (feeCalculatorVersion !== ContractVersion.V2) {
    throw new UnsupportedFeatureError(
      'Aera: numeraire conversion requires V2 price and fee calculator'
    );
  }

  return client.readContract({
    address: feeCalculator,
    abi: priceAndFeeCalculatorV2Abi,
    functionName: 'convertTokenToNumeraire',
    args: [vault, token, tokenAmount],
    ...readAtBlock(options),
  });
}

export async function convertNumeraireToToken(
  client: PublicClient,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  token: Address,
  numeraireAmount: bigint,
  options: AeraPriceReadOptions = {}
): Promise<bigint> {
  if (feeCalculatorVersion !== ContractVersion.V2) {
    throw new UnsupportedFeatureError(
      'Aera: numeraire conversion requires V2 price and fee calculator'
    );
  }

  return client.readContract({
    address: feeCalculator,
    abi: priceAndFeeCalculatorV2Abi,
    functionName: 'convertNumeraireToToken',
    args: [vault, token, numeraireAmount],
    ...readAtBlock(options),
  });
}

export async function getAnchorTimestamp(
  client: PublicClient,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address,
  options: AeraPriceReadOptions = {}
): Promise<number> {
  if (feeCalculatorVersion !== ContractVersion.V2) {
    throw new UnsupportedFeatureError('Aera: sync redeem requires V2 price and fee calculator');
  }

  return client.readContract({
    address: feeCalculator,
    abi: priceAndFeeCalculatorV2Abi,
    functionName: 'getAnchorTimestamp',
    args: [vault],
    ...readAtBlock(options),
  });
}

export async function getVaultState(
  client: PublicClient,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address
) {
  if (feeCalculatorVersion === ContractVersion.V2) {
    const [priceState, accruals] = await client.readContract({
      address: feeCalculator,
      abi: priceAndFeeCalculatorV2Abi,
      functionName: 'getVaultState',
      args: [vault],
    });

    return [normalizeVaultPriceState(priceState), accruals] as const;
  }

  const [priceState, accruals] = await client.readContract({
    address: feeCalculator,
    abi: priceAndFeeCalculatorAbi,
    functionName: 'getVaultState',
    args: [vault],
  });

  return [normalizeVaultPriceState(priceState), accruals] as const;
}

export async function isVaultPaused(
  client: PublicClient,
  feeCalculator: Address,
  feeCalculatorVersion: ContractVersion,
  vault: Address
): Promise<boolean> {
  if (feeCalculatorVersion === ContractVersion.V2) {
    return client.readContract({
      address: feeCalculator,
      abi: priceAndFeeCalculatorV2Abi,
      functionName: 'isVaultPaused',
      args: [vault],
    });
  }

  return client.readContract({
    address: feeCalculator,
    abi: priceAndFeeCalculatorAbi,
    functionName: 'isVaultPaused',
    args: [vault],
  });
}

export const Rounding = {
  Floor: ROUNDING_FLOOR,
  Ceil: ROUNDING_CEIL,
} as const;
