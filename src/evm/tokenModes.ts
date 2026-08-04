import type { GauntletClient } from '../client';
import { UnsupportedAssetError, UnsupportedFeatureError, VaultNotFoundError } from '../errors';
import { resolveVault } from './vaults';
import {
  resolveAeraRuntimeContracts,
  resolveAeraTokenModeSupport,
  type AeraTokenModeSupport,
} from './aeraContracts';

export interface AeraTokenModeSupportParams {
  vaultId: string;
  /** EVM chain ID. Defaults to the vault's primary chain (Base for current multichain vaults). */
  chainId?: number;
  /** Required for multiasset vaults. */
  assetSymbol?: string;
}

/**
 * Reads which deposit/redeem modes (sync vs async) are currently enabled on-chain for a vault token.
 *
 * Use this to decide which entry points to offer a user (e.g. whether an instant withdraw is
 * available) before any amount is entered. Mode availability includes the provisioner's token
 * settings and live runtime gates. A paused V2 solving gate disables both sync modes.
 *
 * @throws {VaultNotFoundError} If the vault ID is not found.
 * @throws {UnsupportedFeatureError} If the vault is not an Aera deployment.
 * @throws {UnsupportedAssetError} If the asset symbol is not accepted by the vault.
 */
export async function getAeraTokenModeSupport(
  client: GauntletClient,
  params: AeraTokenModeSupportParams
): Promise<AeraTokenModeSupport> {
  const resolved = await resolveVault(client, params.vaultId, params.chainId);
  if (!resolved) throw new VaultNotFoundError(params.vaultId);

  const { vault, protocol } = resolved;
  if (protocol !== 'aera') {
    throw new UnsupportedFeatureError('Token mode support is only available for Aera vaults');
  }

  const chainId = params.chainId ?? vault.chainId;
  const publicClient = client.getPublicClient(chainId);

  const token =
    vault.supplyToken.length > 1
      ? vault.supplyToken.find((tInfo) => tInfo.symbol === params.assetSymbol)
      : vault.supplyToken[0];
  if (token === undefined) {
    throw new UnsupportedAssetError(params.assetSymbol ?? 'unknown', params.vaultId);
  }

  const runtime = await resolveAeraRuntimeContracts(publicClient, vault);
  return resolveAeraTokenModeSupport(publicClient, runtime, token.address);
}
