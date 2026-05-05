import { createAnvil, type Anvil } from '@viem/anvil';
import {
  createTestClient,
  http,
  walletActions,
  publicActions,
  type Abi,
  type Chain,
  type Transport,
  type Account,
  type Address,
  type Hex,
  type ContractFunctionName,
  type ContractFunctionArgs,
  type SimulateContractParameters,
  type WriteContractReturnType,
  type WriteContractParameters,
  type TransactionReceipt,
  type TestClient,
  type WalletActions,
  type PublicActions,
} from 'viem';

export interface TestNode {
  testClient: TestClient & WalletActions & PublicActions;
  anvil: Anvil;
  chain: Chain;
}

const ALCHEMY_NETWORK_NAMES: Record<number, string> = {
  1: 'eth-mainnet',
  8453: 'base-mainnet',
  42161: 'arb-mainnet',
  10: 'opt-mainnet',
  137: 'polygon-mainnet',
};

function getAlchemyForkUrl(chain: Chain): string | undefined {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) return undefined;
  const network = ALCHEMY_NETWORK_NAMES[chain.id];
  if (!network) return undefined;
  return `https://${network}.g.alchemy.com/v2/${key}`;
}

export async function setupAnvil(
  chain: Chain,
  fork_block_number: number | undefined
): Promise<TestNode> {
  const forkUrl =
    process.env[`FORK_URL_${chain.id}`] ??
    getAlchemyForkUrl(chain) ??
    chain.rpcUrls.default.http[0];

  const anvil = createAnvil({
    forkUrl,
    forkBlockNumber: fork_block_number !== undefined ? BigInt(fork_block_number) : undefined,
  });

  await anvil.start();

  const transport = http(`http://127.0.0.1:${anvil.port}`);

  const testClient = createTestClient({ chain, mode: 'anvil', transport })
    .extend(walletActions)
    .extend(publicActions);

  return { testClient, anvil, chain };
}

export async function withAnvil<T>(
  chain: Chain,
  fork_block_number: number | undefined,
  fn: (testNode: TestNode) => Promise<T>
) {
  const testNode = await setupAnvil(chain, fork_block_number);
  try {
    return await fn(testNode);
  } finally {
    await testNode.anvil.stop();
  }
}

export async function simulateAndWriteContract<
  const abi extends Abi | readonly unknown[],
  functionName extends ContractFunctionName<abi, 'nonpayable' | 'payable'>,
  const args extends ContractFunctionArgs<abi, 'nonpayable' | 'payable', functionName>,
  chainOverride extends Chain | undefined,
  accountOverride extends Account | Address | undefined = undefined,
  transport extends Transport = Transport,
  chain extends Chain | undefined = Chain | undefined,
  account extends Account | undefined = Account | undefined,
>(
  client: PublicActions<transport, chain, account> & WalletActions<chain, account>,
  args: SimulateContractParameters<abi, functionName, args, chain, chainOverride, accountOverride>
): Promise<WriteContractReturnType> {
  const { request } = await client.simulateContract(args);
  // Idk why this doesn't work without the cast
  return await client.writeContract(
    request as unknown as WriteContractParameters<
      abi,
      functionName,
      args,
      chain,
      account,
      chainOverride
    >
  );
}

export async function sendTransactionAndWait(
  client: PublicActions & WalletActions,
  tx: { to: Address; data: Hex; account: Address }
): Promise<TransactionReceipt> {
  const hash = await client.sendTransaction(tx);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error(`Transaction reverted: to=${tx.to} selector=${tx.data.slice(0, 10)}`);
  }
  return receipt;
}

export async function simulateAndWriteContractAndWait<
  const abi extends Abi | readonly unknown[],
  functionName extends ContractFunctionName<abi, 'nonpayable' | 'payable'>,
  const args extends ContractFunctionArgs<abi, 'nonpayable' | 'payable', functionName>,
  chainOverride extends Chain | undefined,
  accountOverride extends Account | Address | undefined = undefined,
  transport extends Transport = Transport,
  chain extends Chain | undefined = Chain | undefined,
  account extends Account | undefined = Account | undefined,
>(
  client: PublicActions<transport, chain, account> & WalletActions<chain, account>,
  args: SimulateContractParameters<abi, functionName, args, chain, chainOverride, accountOverride>
): Promise<TransactionReceipt> {
  const tx = await simulateAndWriteContract(client, args);
  return await client.waitForTransactionReceipt({ hash: tx });
}
