/**
 * Gauntlet SDK — viem example
 *
 * Shows how to use the SDK directly with viem clients.
 */
import { createPublicClient, createWalletClient, custom, http } from 'viem';
import { base } from 'viem/chains';
import { GauntletClient } from '@gauntletnetworks/gauntlet-sdk';
import { getVaults, getDepositTx, getWithdrawTx } from '@gauntletnetworks/gauntlet-sdk/evm';

// 1. Create viem clients
const publicClient = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org'),
});

const walletClient = createWalletClient({
  chain: base,
  transport: custom(window.ethereum),
});

/* for those not on browser wallets:

const account = privateKeyToAccount('0x0ADB...123');

const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(process.env.RPC_URL),
});
*/

// 2. Initialize the Gauntlet client
const client = new GauntletClient({
  evmClients: { [base.id]: publicClient },
  wallet: walletClient,
});

// 3. List available vaults (reads local manifest, no network call)
const vaults = await getVaults(client, { chainId: base.id });
console.log(
  'Available vaults:',
  vaults.map((v) => v.name)
);

// 4. Deposit
const [account] = await walletClient.getAddresses();
const vault = vaults[0];

const depositSteps = await getDepositTx(client, {
  vaultId: vault.vaultId,
  amount: 100_000_000n, // 100 USDC (6 decimals)
  chainId: base.id,
});

for (const step of depositSteps) {
  const hash = await walletClient.writeContract({
    address: step.address,
    abi: step.abi,
    functionName: step.functionName,
    args: step.args,
    account,
    chain: base,
  });
  console.log(`${step.type} tx:`, hash);
}

// 5. Withdraw entire balance
const withdrawSteps = await getWithdrawTx(client, {
  vaultId: vault.vaultId,
  chainId: base.id,
  entireAmount: true,
});

for (const step of withdrawSteps) {
  const hash = await walletClient.writeContract({
    address: step.address,
    abi: step.abi,
    functionName: step.functionName,
    args: step.args,
    account,
    chain: base,
  });
  console.log(`${step.type} tx:`, hash);
}
