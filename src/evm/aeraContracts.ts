/**
 *  CODE PULLED FROM AERA-V3-TS-SDK in gauntlet/apps/packages/aera-v3-ts-sdk
 *  pulled in here with the goal to have this SDK replace the previous
 */
import { type Address, type Client, type GetContractReturnType, getContract } from 'viem';
import { multiDepositorVaultAbi } from './abis/multiDepositorVault';
import { provisionerV2Abi } from './abis/provisionerV2';
import { MAX_BPS } from '../constants';
import { ContractVersion, type EvmVaultDeployment } from './types';

const contractVersionCache = new Map<string, ContractVersion>();

export function applySlippageDown(amount: bigint, slippageBps: number): bigint {
  return (amount * (MAX_BPS - BigInt(slippageBps))) / MAX_BPS;
}

export function applySlippageUp(amount: bigint, slippageBps: number): bigint {
  return (amount * (MAX_BPS + BigInt(slippageBps)) + MAX_BPS - 1n) / MAX_BPS;
}

function contractVersionCacheKey(vault: EvmVaultDeployment): string | undefined {
  if (!vault.provisionerAddress) return undefined;
  return `${vault.chainId}:${vault.provisionerAddress.toLowerCase()}`;
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

export async function resolveContractVersion<T extends Client>(
  client: T,
  vault: EvmVaultDeployment
): Promise<ContractVersion> {
  if (!vault.provisionerAddress) return ContractVersion.V1;

  if (vault.contractVersion) {
    return vault.contractVersion;
  }

  const cacheKey = contractVersionCacheKey(vault);
  if (cacheKey) {
    const cached = contractVersionCache.get(cacheKey);
    if (cached) return cached;
  }

  try {
    const contract = getContract({
      address: vault.provisionerAddress,
      abi: provisionerV2Abi,
      client,
    });

    const versionString = await contract.read.version();
    const version = versionString.startsWith('2.') ? ContractVersion.V2 : ContractVersion.V1;

    if (cacheKey) {
      contractVersionCache.set(cacheKey, version);
    }

    return version;
  } catch {
    return ContractVersion.V1;
  }
}
