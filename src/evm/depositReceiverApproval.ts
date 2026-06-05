import type { Address } from 'viem';
import type { GauntletClient } from '../client';
import type { PreparedTx } from '../attribution';
import { encodeTransactionWithAttribution } from '../attribution';
import { AccountRequiredError, UnsupportedFeatureError, VaultNotFoundError } from '../errors';
import { resolveContractVersion } from './aeraContracts';
import * as provisionerV2 from './aeraContracts/v2';
import { ContractVersion } from './types';
import { resolveVault } from './vaults';

export interface EvmDepositReceiverApprovalParams {
  vaultId: string;
  depositor: Address;
  approved?: boolean;
  chainId?: number;
}

/**
 * Builds the V2 receiver-side approval transaction required before a depositor
 * can make sync deposits to a separate receiver.
 *
 * The wallet account on the client is the receiver and must sign this transaction.
 */
export async function getDepositReceiverApprovalTx(
  client: GauntletClient,
  params: EvmDepositReceiverApprovalParams
): Promise<PreparedTx> {
  const resolved = await resolveVault(client, params.vaultId, params.chainId);
  if (!resolved) throw new VaultNotFoundError(params.vaultId);

  const chainId = params.chainId ?? resolved.vault.chainId;
  const receiver = client.wallet?.account?.address;
  if (!receiver) throw new AccountRequiredError();

  const { vault } = resolved;
  if (!vault.provisionerAddress) {
    throw new UnsupportedFeatureError('Aera: deposit receiver approval without provisioner');
  }

  const publicClient = client.getPublicClient(chainId);
  const isV2 = (await resolveContractVersion(publicClient, vault)) === ContractVersion.V2;
  if (!isV2) {
    throw new UnsupportedFeatureError('Aera: deposit receiver approval on V1');
  }

  return encodeTransactionWithAttribution(client, {
    type: 'setDepositReceiverApproval',
    ...provisionerV2.setDepositReceiverApprovalTxRequest(
      vault.provisionerAddress,
      params.depositor,
      params.approved ?? true,
      receiver
    ),
  });
}
