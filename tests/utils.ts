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
    port: 0,
  });

  await anvil.start();

  const selectedPort = getSelectedAnvilPort(anvil);
  const transport = http(`http://127.0.0.1:${selectedPort}`);

  const testClient = createTestClient({ chain, mode: 'anvil', transport })
    .extend(walletActions)
    .extend(publicActions);

  return { testClient, anvil: { ...anvil, port: selectedPort }, chain };
}

function getSelectedAnvilPort(anvil: Anvil): number {
  if (anvil.port !== 0) return anvil.port;

  const listeningLine = anvil.logs.find((log) => log.includes('Listening on'));
  const selectedPort = listeningLine?.match(/Listening on .*:(\d+)/)?.[1];
  if (selectedPort === undefined) {
    throw new Error('Unable to determine selected Anvil port from startup logs');
  }

  return Number(selectedPort);
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

// Headroom over anvil's non-deterministic fork gas estimate; these txs run ~99% of it and OOG without it.
const GAS_BUFFER = 2n;

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
  const writeRequest = request as unknown as WriteContractParameters<
    abi,
    functionName,
    args,
    chain,
    account,
    chainOverride
  >;
  const gas = await client.estimateContractGas(
    writeRequest as unknown as Parameters<typeof client.estimateContractGas>[0]
  );
  return await client.writeContract({ ...writeRequest, gas: gas * GAS_BUFFER } as typeof writeRequest);
}

export async function sendTransactionAndWait(
  client: PublicActions & WalletActions,
  tx: { to: Address; data: Hex; account: Address }
): Promise<TransactionReceipt> {
  // estimateGas runs the tx, so a logical revert throws here (with reason) before we send.
  const gas = await client.estimateGas({ to: tx.to, data: tx.data, account: tx.account });
  const hash = await client.sendTransaction({ ...tx, gas: gas * GAS_BUFFER });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error(
      `Transaction reverted on-chain despite a clean gas estimate: to=${tx.to} selector=${tx.data.slice(0, 10)} gasUsed=${receipt.gasUsed}`
    );
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
