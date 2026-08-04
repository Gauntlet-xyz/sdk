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
import { readAtBlock } from './aeraContracts/readOptions';

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

const solvingGateAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'provisioner', internalType: 'address', type: 'address' },
      { name: 'token', internalType: 'address', type: 'address' },
    ],
    name: 'paused',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
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

export function requireAeraSyncRedeemRuntime(runtime: AeraRuntimeContracts): void {
  if (runtime.provisioner.version !== ContractVersion.V2) {
    throw new UnsupportedFeatureError('Aera: sync redeem requires a V2 provisioner');
  }
  if (runtime.feeCalculator.version !== ContractVersion.V2) {
    throw new UnsupportedFeatureError('Aera: sync redeem requires a V2 price and fee calculator');
  }
}

export type AeraReadOptions = {
  blockNumber?: bigint;
};

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
  address: Address,
  options: AeraReadOptions = {}
): Promise<ContractVersion> {
  const cacheKey = contractVersionCacheKey(client, address);
  const cached = contractVersionCache.get(cacheKey);
  if (cached) return cached;

  try {
    const versionString = await client.readContract({
      address,
      abi: contractVersionAbi,
      functionName: 'version',
      ...readAtBlock(options),
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
  vault: EvmVaultDeployment,
  options: AeraReadOptions = {}
): Promise<AeraRuntimeContracts> {
  if (vault.vaultType !== 'multi-depositor') {
    throw new UnimplementedFeatureError('Aera: single depositor vaults');
  }

  const [provisionerAddress, feeCalculatorAddress] = await Promise.all([
    client.readContract({
      address: vault.vaultAddress,
      abi: multiDepositorVaultAbi,
      functionName: 'provisioner',
      ...readAtBlock(options),
    }),
    client.readContract({
      address: vault.vaultAddress,
      abi: multiDepositorVaultAbi,
      functionName: 'feeCalculator',
      ...readAtBlock(options),
    }),
  ]);

  if (provisionerAddress === zeroAddress) {
    throw new UnsupportedFeatureError('Aera: vault without provisioner');
  }
  if (feeCalculatorAddress === zeroAddress) {
    throw new UnsupportedFeatureError('Aera: vault without price and fee calculator');
  }

  const [provisionerVersion, feeCalculatorVersion] = await Promise.all([
    resolveContractVersion(client, provisionerAddress, options),
    resolveContractVersion(client, feeCalculatorAddress, options),
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
  token: Address,
  options: AeraReadOptions & { includeSyncModes?: boolean } = {}
): Promise<AeraTokenModeSupport> {
  if (runtime.provisioner.version === ContractVersion.V2) {
    const tokenDetailsPromise = client.readContract({
      address: runtime.provisioner.address,
      abi: provisionerV2Abi,
      functionName: 'tokensDetails',
      args: [token],
      ...readAtBlock(options),
    });
    if (options.includeSyncModes === false) {
      const tokenDetails = await tokenDetailsPromise;
      return {
        asyncDeposit: Boolean(tokenDetails[0]),
        asyncRedeem: Boolean(tokenDetails[1]),
        syncDeposit: false,
        syncRedeem: false,
      };
    }

    const [tokenDetails, solvingGateEnabled, solvingGate] = await Promise.all([
      tokenDetailsPromise,
      client.readContract({
        address: runtime.provisioner.address,
        abi: provisionerV2Abi,
        functionName: 'SOLVING_GATE_ENABLED',
        ...readAtBlock(options),
      }),
      client.readContract({
        address: runtime.provisioner.address,
        abi: provisionerV2Abi,
        functionName: 'solvingGate',
        ...readAtBlock(options),
      }),
    ]);
    const solvingPaused =
      solvingGateEnabled && solvingGate !== zeroAddress
        ? await client.readContract({
            address: solvingGate,
            abi: solvingGateAbi,
            functionName: 'paused',
            args: [runtime.provisioner.address, token],
            ...readAtBlock(options),
          })
        : false;

    return {
      asyncDeposit: Boolean(tokenDetails[0]),
      asyncRedeem: Boolean(tokenDetails[1]),
      syncDeposit: Boolean(tokenDetails[2]) && !solvingPaused,
      syncRedeem:
        Boolean(tokenDetails[3]) &&
        !solvingPaused &&
        runtime.feeCalculator.version === ContractVersion.V2,
    };
  }

  const tokenDetails = await client.readContract({
    address: runtime.provisioner.address,
    abi: provisionerAbi,
    functionName: 'tokensDetails',
    args: [token],
    ...readAtBlock(options),
  });

  return {
    asyncDeposit: Boolean(tokenDetails[0]),
    asyncRedeem: Boolean(tokenDetails[1]),
    syncDeposit: false,
    syncRedeem: false,
  };
}
