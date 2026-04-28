/**
 * Gauntlet SDK — wagmi example
 *
 * Shows how to wire up the SDK using wagmi's config-level clients.
 * Useful for scripts, server actions, or non-hook contexts.
 */
import { http, createConfig, getPublicClient, getWalletClient } from '@wagmi/core';
import { base, mainnet } from 'viem/chains';
import { GauntletClient } from '@gauntletnetworks/gauntlet-sdk';
import { getVaults, getDepositTx } from '@gauntletnetworks/gauntlet-sdk/evm';

// 1. Set up wagmi config
export const config = createConfig({
  chains: [base, mainnet],
  transports: {
    [base.id]: http(),
    [mainnet.id]: http(),
  },
});

// 2. Build the Gauntlet client from wagmi's clients
function makeGauntletClient() {
  const [basePublicClient, mainnetPublicClient, walletClient] = [
    getPublicClient(config, { chainId: base.id }),
    getPublicClient(config, { chainId: mainnet.id }),
    getWalletClient(config),
  ];

  return new GauntletClient({
    evmClients: {
      [base.id]: basePublicClient,
      [mainnet.id]: mainnetPublicClient,
    },
    wallet: walletClient,
  });
}

// 3. Deposit into a vault
async function deposit(vaultId: string, amount: bigint) {
  const client = await makeGauntletClient();
  const steps = await getDepositTx(client, { vaultId, amount, chainId: base.id });

  const [account] = await client.wallet!.getAddresses();

  for (const step of steps) {
    const hash = await client.wallet!.writeContract({
      address: step.address,
      abi: step.abi,
      functionName: step.functionName,
      args: step.args,
      account,
      chain: base,
    });
    console.log(`${step.type}:`, hash);
  }
}

// 4. List vaults for a chain
async function listVaults(chainId: number) {
  const client = await makeGauntletClient();
  return getVaults(client, { chainId });
}
