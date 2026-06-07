import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type Address,
  type Client,
  type GetContractReturnType,
  type PublicClient,
  getContract,
  zeroAddress,
} from 'viem';
import { UnimplementedFeatureError, UnsupportedFeatureError } from '../errors';
import { multiDepositorVaultAbi } from './abis/multiDepositorVault';
import { provisionerAbi } from './abis/provisioner';
import { provisionerV2Abi } from './abis/provisionerV2';
import { MAX_BPS } from '../constants';
import { ContractVersion, type EvmVaultDeployment } from './types';

const contractVersionCache = new Map<string, ContractVersion>();

const contractVersionAbi = [
  {
    type: 'function',
    inputs: [],
    name: 'version',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
] as const;

export interface AeraRuntimeContracts {
  provisioner: {
    address: Address;
    version: ContractVersion;
  };
  feeCalculator: {
    address: Address;
    version: ContractVersion;
  };
}

export interface AeraTokenModeSupport {
  asyncDeposit: boolean;
  asyncRedeem: boolean;
  syncDeposit: boolean;
  syncRedeem: boolean;
}

export function applySlippageDown(amount: bigint, slippageBps: number): bigint {
  return (amount * (MAX_BPS - BigInt(slippageBps))) / MAX_BPS;
}

export function applySlippageUp(amount: bigint, slippageBps: number): bigint {
  return (amount * (MAX_BPS + BigInt(slippageBps)) + MAX_BPS - 1n) / MAX_BPS;
}

function contractVersionCacheKey(client: PublicClient, address: Address): string {
  return `${client.chain?.id ?? 'unknown'}:${address.toLowerCase()}`;
}

function isVersionUnavailableError(error: unknown): boolean {
  if (!(error instanceof ContractFunctionExecutionError) || error.functionName !== 'version') {
    return false;
  }

  if (error.cause instanceof ContractFunctionRevertedError) {
    const hasDecodedError =
      error.cause.signature !== undefined ||
      error.cause.data !== undefined ||
      (error.cause.raw !== undefined && error.cause.raw !== '0x');

    return (
      !hasDecodedError &&
      (error.cause.reason === undefined || error.cause.reason === 'execution reverted')
    );
  }

  return error.cause instanceof ContractFunctionZeroDataError;
}

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

export async function resolveContractVersion(
  client: PublicClient,
  address: Address
): Promise<ContractVersion> {
  const cacheKey = contractVersionCacheKey(client, address);
  const cached = contractVersionCache.get(cacheKey);
  if (cached) return cached;

  try {
    const versionString = await client.readContract({
      address,
      abi: contractVersionAbi,
      functionName: 'version',
    });
    const version = versionString.startsWith('2.') ? ContractVersion.V2 : ContractVersion.V1;
    contractVersionCache.set(cacheKey, version);

    return version;
  } catch (error) {
    if (!isVersionUnavailableError(error)) throw error;

    contractVersionCache.set(cacheKey, ContractVersion.V1);
    return ContractVersion.V1;
  }
}

export async function resolveAeraRuntimeContracts(
  client: PublicClient,
  vault: EvmVaultDeployment
): Promise<AeraRuntimeContracts> {
  if (vault.vaultType !== 'multi-depositor') {
    throw new UnimplementedFeatureError('Aera: single depositor vaults');
  }

  const [provisionerAddress, feeCalculatorAddress] = await Promise.all([
    client.readContract({
      address: vault.vaultAddress,
      abi: multiDepositorVaultAbi,
      functionName: 'provisioner',
    }),
    client.readContract({
      address: vault.vaultAddress,
      abi: multiDepositorVaultAbi,
      functionName: 'feeCalculator',
    }),
  ]);

  if (provisionerAddress === zeroAddress) {
    throw new UnsupportedFeatureError('Aera: vault without provisioner');
  }
  if (feeCalculatorAddress === zeroAddress) {
    throw new UnsupportedFeatureError('Aera: vault without price and fee calculator');
  }

  const [provisionerVersion, feeCalculatorVersion] = await Promise.all([
    resolveContractVersion(client, provisionerAddress),
    resolveContractVersion(client, feeCalculatorAddress),
  ]);

  return {
    provisioner: {
      address: provisionerAddress,
      version: provisionerVersion,
    },
    feeCalculator: {
      address: feeCalculatorAddress,
      version: feeCalculatorVersion,
    },
  };
}

export async function resolveAeraTokenModeSupport(
  client: PublicClient,
  runtime: AeraRuntimeContracts,
  token: Address
): Promise<AeraTokenModeSupport> {
  if (runtime.provisioner.version === ContractVersion.V2) {
    const tokenDetails = await client.readContract({
      address: runtime.provisioner.address,
      abi: provisionerV2Abi,
      functionName: 'tokensDetails',
      args: [token],
    });

    return {
      asyncDeposit: Boolean(tokenDetails[0]),
      asyncRedeem: Boolean(tokenDetails[1]),
      syncDeposit: Boolean(tokenDetails[2]),
      syncRedeem: Boolean(tokenDetails[3]),
    };
  }

  const tokenDetails = await client.readContract({
    address: runtime.provisioner.address,
    abi: provisionerAbi,
    functionName: 'tokensDetails',
    args: [token],
  });

  return {
    asyncDeposit: Boolean(tokenDetails[0]),
    asyncRedeem: Boolean(tokenDetails[1]),
    syncDeposit: false,
    syncRedeem: false,
  };
}
