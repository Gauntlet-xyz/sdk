import type { GauntletClient } from '../client';
import { VaultNotFoundError } from '../errors';
import { resolveVault } from '../evm/vaults';
import { InvalidCaipIdError } from './errors';

/**
 * The Gaia API identifies vaults as `"{chainId}:{address}"` with a lowercase
 * address (a CAIP-10-style account id without the `eip155` namespace prefix).
 */
export interface ApiVaultId {
  chainId: number;
  /** Lowercase EVM address. */
  address: string;
}

export function parseApiVaultId(id: string): ApiVaultId {
  const match = /^(?:eip155:)?(\d+):(0x[0-9a-fA-F]{40})$/.exec(id);
  if (!match) throw new InvalidCaipIdError(id);
  return { chainId: Number(match[1]), address: match[2].toLowerCase() };
}

export function formatApiVaultId(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/**
 * Resolves a manifest vault id (e.g. `VaultId.AeraUsdAlpha` / `'gtusda'`) to
 * the Gaia API's CAIP-10 id for the vault's deployment on `chainId`.
 *
 * Deployment resolution is `resolveVault` — the same rules tx-building uses:
 * single-deployment vaults resolve directly (a mismatched explicit `chainId`
 * throws `ChainMismatchError`), multi-chain vaults default to Base when
 * `chainId` is omitted.
 */
export async function apiVaultIdFromVaultId(
  client: GauntletClient,
  vaultId: string,
  chainId?: number
): Promise<string> {
  const resolved = await resolveVault(client, vaultId, chainId);
  if (!resolved) throw new VaultNotFoundError(vaultId, chainId);
  return formatApiVaultId(resolved.vault.chainId, resolved.vault.vaultAddress);
}

/**
 * Resolves a Gaia API CAIP-10 vault id back to the manifest vault id, or
 * `undefined` when the vault is not in the bundled manifest (the API indexes
 * more vaults than the manifest lists).
 */
export async function vaultIdFromApiVaultId(
  client: GauntletClient,
  apiVaultId: string
): Promise<string | undefined> {
  const { chainId, address } = parseApiVaultId(apiVaultId);
  const manifest = await client.manifest;
  return manifest.vaults.find((v) =>
    v.deployments.some(
      (d) => d.chain === 'evm' && d.chainId === chainId && d.vaultAddress.toLowerCase() === address
    )
  )?.vaultId;
}
