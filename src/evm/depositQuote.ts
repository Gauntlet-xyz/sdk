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
import { getSyncDepositFeeBps, getSyncDepositQuoteValues } from './aeraContracts/v2';
import { resolveOperationMode } from './operationMode';
import { ContractVersion } from './types';
import { resolveVault } from './vaults';

export type SyncDepositQuote = Readonly<{
  unitsOut: bigint;
  minUnitsOut: bigint;
  /** Deposit amount converted to the vault's numeraire, after the Instant Supply fee. */
  numeraireOut: bigint;
  /** Instant Supply fee applied to the deposited token amount, in basis points. */
  feeBps: bigint;
  /** Slippage tolerance used to derive `minUnitsOut`, in basis points. */
  slippageBps: number;
}>;

export type SyncDepositQuoteParams = {
  vaultId: string;
  chainId?: number;
  assetSymbol?: string;
  amount: bigint;
  slippageBps?: number;
};

export type SyncDepositRateParams = {
  vaultId: string;
  chainId?: number;
  assetSymbol?: string;
};

export type SyncDepositRate = Readonly<{
  /** Instant Supply fee, in basis points. Independent of the deposit amount. */
  feeBps: bigint;
}>;

async function resolveSyncDepositContext(
  client: GauntletClient,
  params: SyncDepositRateParams,
  readKind: 'quote' | 'rate'
) {
  const resolved = await resolveVault(client, params.vaultId, params.chainId);
  if (!resolved) throw new VaultNotFoundError(params.vaultId, params.chainId);
  if (resolved.protocol !== 'aera') {
    throw new UnsupportedFeatureError(
      readKind === 'quote'
        ? 'Sync deposit quote is only available for Aera vaults'
        : 'Sync deposit rate is only available for Aera vaults'
    );
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
    throw new UnsupportedFeatureError(
      readKind === 'quote'
        ? 'Sync deposit quote requires an Aera V2 provisioner'
        : 'Sync deposit rate requires an Aera V2 provisioner'
    );
  }

  const tokenModeSupport = await resolveAeraTokenModeSupport(publicClient, runtime, token.address, {
    includeSyncModes: true,
  });
  resolveOperationMode(params.vaultId, 'sync', {
    async: tokenModeSupport.asyncDeposit,
    sync: tokenModeSupport.syncDeposit,
  });

  return { publicClient, vault, token, runtime };
}

/** Quotes an Aera synchronous deposit and its execution bounds. */
export async function getSyncDepositQuote(
  client: GauntletClient,
  params: SyncDepositQuoteParams
): Promise<SyncDepositQuote> {
  const slippageBps = params.slippageBps ?? DEFAULT_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > Number(MAX_BPS)) {
    throw new InvalidSlippageBPSError(slippageBps);
  }

  const { publicClient, vault, token, runtime } = await resolveSyncDepositContext(
    client,
    params,
    'quote'
  );

  const { unitsOut, feeBps, numeraireOut } = await getSyncDepositQuoteValues(
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

  return { unitsOut, minUnitsOut, numeraireOut, feeBps, slippageBps };
}

/** Reads the live Instant Supply fee for a vault token, without requiring a deposit amount. */
export async function getSyncDepositRate(
  client: GauntletClient,
  params: SyncDepositRateParams
): Promise<SyncDepositRate> {
  const { publicClient, runtime, token } = await resolveSyncDepositContext(client, params, 'rate');

  const feeBps = await getSyncDepositFeeBps(
    publicClient,
    runtime.provisioner.address,
    token.address
  );
  return { feeBps };
}
