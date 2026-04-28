import { Address, encodeFunctionData, type Hex } from 'viem';
import { encodeBuilderCode } from './erc8021';
import { AttributionMode, GauntletClient } from '../client';
import { UnimplementedFeatureError } from '../errors';
import { TxStep } from '../evm/adapters/types';
export { encodeBuilderCode } from './erc8021';

export type PreparedPayloadWithAttribution = {
  type: string;
  to: Address;
  data: Hex;
  account?: Address;
};

export type PreparedTx = {
  payload: PreparedPayloadWithAttribution;
  tx: TxStep;
};

/**
 * Build the full attribution suffix to append to transaction calldata.
 *
 * PUBLIC:  ERC-8021 builder code only — `0x8021{builderCode utf8}`, or `0x` if no builderCode.
 * ENCODED: Requests a sourceId from the Gauntlet API with builder code as an arg and encodes that.
 * PRIVATE: Generates a random salt and posts it to the Gauntlet API.
 *
 */
export async function buildAttribution(client: GauntletClient): Promise<Hex> {
  switch (client.attributionMode) {
    case AttributionMode.PUBLIC:
      return client.builderCode ? encodeBuilderCode(client.builderCode) : '0x';
    case AttributionMode.ENCODED:
      throw new UnimplementedFeatureError('AttributionMode.ENCODED');
    case AttributionMode.PRIVATE:
      throw new UnimplementedFeatureError('AttributionMode.PRIVATE');
  }
}

export async function encodeTransactionWithAttribution(
  client: GauntletClient,
  transaction: TxStep
): Promise<PreparedTx> {
  const customAttribution = await buildAttribution(client);
  const encodedTx = encodeFunctionData({
    abi: transaction.abi,
    functionName: transaction.functionName,
    args: transaction.args,
  });
  const encodedTxWithAttribution = `${encodedTx}${customAttribution.replace('0x', '')}` as Hex;
  return {
    payload: {
      type: transaction.type,
      account: transaction.account,
      to: transaction.address,
      data: encodedTxWithAttribution,
    },
    tx: {
      ...transaction,
      attribution: customAttribution,
    },
  };
}
