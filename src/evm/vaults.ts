import { base } from 'viem/chains';
import type { GauntletClient } from '../client';
import type { EvmVaultDeployment, VaultDeployment, VaultInfo } from './types';
import { ChainMismatchError } from '../errors';

export enum VaultId {
  BaseUsdcPrime = 'baseUsdcPrime',
  EthUsdcPrime = 'ethUsdcPrime',
  AeraUsdAlpha = 'gtusda',
  EthUsdcPrimeV2 = 'ethUsdcPrimeV2',
  AeraUsdAlphaStaging = 'stgusda',
  AeraUsdAlphaDev = 'devusda',
  AeraUsdAlphaDevDeux = 'devusda2',
  AeraLeveredFalconX = 'gpaafalconx',
  AeraLeveredFalconXStaging = 'pytstg',
  AeraSyrupUsdc = 'gpsyrupusdc',
  AeraSyrupUsdcStaging = 'syruppytstg',
  AeraBtcYield = 'gtbtc',
  AeraBtcYieldStaging = 'gtbtcstaging',
  AeraLeveredUsccStaging = 'gtusccstg',
  AeraLeveredUscc = 'gtuscc',
  AeraLend = 'gtlend',
  AeraKastEth = 'kasteth',
}

export interface VaultFilter {
  /** Filter to vaults that have at least one EVM deployment on this chainId. */
  chainId?: number;
  protocol?: string;
}

/**
 * Returns vaults from the bundled manifest, optionally filtered by chain and/or protocol.
 * Does not make any network requests.
 *
 * @param client - A configured `GauntletClient` instance.
 * @param filter - Optional filter criteria. `chainId` restricts results to vaults that have
 *   at least one EVM deployment on that chain. `protocol` restricts results to a specific
 *   protocol (e.g. `'aera'`, `'morpho'`).
 * @returns Array of `VaultInfo` objects matching the filter, or all vaults if no filter is given.
 *
 * @example
 * ```ts
 * // All vaults on Base
 * const vaults = await getVaults(client, { chainId: base.id });
 *
 * // All Aera vaults
 * const aeraVaults = await getVaults(client, { protocol: 'aera' });
 * ```
 */
export async function getVaults(
  client: GauntletClient,
  filter?: VaultFilter
): Promise<VaultInfo[]> {
  const manifest = await client.manifest;
  let vaults = manifest.vaults;

  if (filter?.chainId) {
    vaults = vaults.filter((v) =>
      v.deployments.some((d) => d.chain === 'evm' && d.chainId === filter.chainId)
    );
  }

  if (filter?.protocol) {
    vaults = vaults.filter((v) => v.protocol === filter.protocol);
  }

  return vaults;
}

export async function resolveVault(
  client: GauntletClient,
  vaultId: string,
  chainId?: string | number
): Promise<{ vault: VaultDeployment; protocol: string } | undefined> {
  const manifest = await client.manifest;
  const vaultInfo = manifest.vaults.find((v) => v.vaultId === vaultId);
  if (!vaultInfo) return undefined;

  const evmDeployments = vaultInfo.deployments.filter(
    (d): d is EvmVaultDeployment => d.chain === 'evm'
  );

  if (evmDeployments.length === 1) {
    // if user specifies a chain we need to make sure they get it
    if (chainId !== undefined && evmDeployments[0].chainId !== chainId) {
      throw new ChainMismatchError(`${chainId}`, `${evmDeployments[0].chainId}`);
    }
    // otherwise they're expected to know what chain
    // the single chain vault they request is on
    return { vault: evmDeployments[0], protocol: vaultInfo.protocol };
  }

  // now we default to base
  const defaultChainId = chainId ?? base.id;

  const deployment = evmDeployments.find((d) => d.chainId === defaultChainId);
  if (!deployment) return undefined;

  return { vault: deployment, protocol: vaultInfo.protocol };
}
