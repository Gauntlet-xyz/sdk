import type { GauntletClient } from '../client';
import { DEFAULT_BPS, MAX_BPS } from '../constants';
import {
  InvalidSlippageBPSError,
  InvalidSyncDepositBoundError,
  UnsupportedAssetError,
  UnsupportedFeatureError,
  VaultNotFoundError,
} from '../errors';
import {
  applySlippageDown,
  resolveAeraRuntimeContracts,
  resolveAeraTokenModeSupport,
} from './aeraContracts';
import { getSyncDepositUnitsOut } from './aeraContracts/v2';
import { resolveOperationMode } from './operationMode';
import { ContractVersion } from './types';
import { resolveVault } from './vaults';

export type SyncDepositQuote = Readonly<{
  unitsOut: bigint;
  minUnitsOut: bigint;
}>;

export type SyncDepositQuoteParams = {
  vaultId: string;
  chainId?: number;
  assetSymbol?: string;
  amount: bigint;
  slippageBps?: number;
};

/** Quotes the output and minimum output for an Aera synchronous deposit. */
export async function getSyncDepositQuote(
  client: GauntletClient,
  params: SyncDepositQuoteParams
): Promise<SyncDepositQuote> {
  const slippageBps = params.slippageBps ?? DEFAULT_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > Number(MAX_BPS)) {
    throw new InvalidSlippageBPSError(slippageBps);
  }

  const resolved = await resolveVault(client, params.vaultId, params.chainId);
  if (!resolved) throw new VaultNotFoundError(params.vaultId, params.chainId);
  if (resolved.protocol !== 'aera') {
    throw new UnsupportedFeatureError('Sync deposit quote is only available for Aera vaults');
  }

  const { vault } = resolved;
  const token =
    vault.supplyToken.length > 1
      ? vault.supplyToken.find(({ symbol }) => symbol === params.assetSymbol)
      : vault.supplyToken[0];
  if (!token) throw new UnsupportedAssetError(params.assetSymbol ?? 'unknown', params.vaultId);

  const publicClient = client.getPublicClient(params.chainId ?? vault.chainId);
  const runtime = await resolveAeraRuntimeContracts(publicClient, vault);
  if (runtime.provisioner.version !== ContractVersion.V2) {
    throw new UnsupportedFeatureError('Sync deposit quote requires an Aera V2 provisioner');
  }

  const tokenModeSupport = await resolveAeraTokenModeSupport(publicClient, runtime, token.address, {
    includeSyncModes: true,
  });
  resolveOperationMode(params.vaultId, 'sync', {
    async: tokenModeSupport.asyncDeposit,
    sync: tokenModeSupport.syncDeposit,
  });

  const unitsOut = await getSyncDepositUnitsOut(
    publicClient,
    runtime.provisioner.address,
    runtime.feeCalculator.address,
    runtime.feeCalculator.version,
    vault.vaultAddress,
    token.address,
    params.amount
  );
  const minUnitsOut = applySlippageDown(unitsOut, slippageBps);
  if (minUnitsOut <= 0n) throw new InvalidSyncDepositBoundError();

  return { unitsOut, minUnitsOut };
}
