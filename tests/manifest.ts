import { describe, test, expect } from 'vitest';
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  type Address,
  type Chain,
} from 'viem';
import { arbitrum, base, mainnet, optimism, unichain } from 'viem/chains';
import vaultManifest from '../manifest/vaults.json';

const assetAbi = [
  {
    type: 'function',
    name: 'asset',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const;

const provisionerAbi = [
  {
    type: 'function',
    name: 'provisioner',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const;

const hyperevm = defineChain({
  id: 999,
  name: 'HyperEVM',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.hyperliquid.xyz/evm'] } },
});

const CHAIN_CONFIGS: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  10: optimism,
  130: unichain,
  999: hyperevm,
};

const ALCHEMY_NETWORKS: Record<number, string> = {
  1: 'eth-mainnet',
  8453: 'base-mainnet',
  42161: 'arb-mainnet',
  10: 'opt-mainnet',
};

function getRpcUrl(chainId: number): string | undefined {
  const envUrl = process.env[`FORK_URL_${chainId}`];
  if (envUrl) return envUrl;
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  const network = ALCHEMY_NETWORKS[chainId];
  if (alchemyKey && network) {
    return `https://${network}.g.alchemy.com/v2/${alchemyKey}`;
  }
  return CHAIN_CONFIGS[chainId]?.rpcUrls.default.http[0];
}

interface VaultEntry {
  vaultId: string;
  protocol: string;
  vaultAddress: Address;
  provisionerAddress?: Address;
  supplyToken: { address: Address; symbol: string; decimals: number }[];
}

function groupByChain(): Map<number, VaultEntry[]> {
  const byChain = new Map<number, VaultEntry[]>();
  for (const vault of vaultManifest.vaults) {
    for (const d of vault.deployments) {
      if (d.chain !== 'evm') continue;
      const entries = byChain.get(d.chainId) ?? [];
      entries.push({
        vaultId: vault.vaultId,
        protocol: vault.protocol,
        vaultAddress: d.vaultAddress as Address,
        provisionerAddress: d.provisionerAddress as Address | undefined,
        supplyToken: d.supplyToken as { address: Address; symbol: string; decimals: number }[],
      });
      byChain.set(d.chainId, entries);
    }
  }
  return byChain;
}

describe('vault manifest', () => {
  test('all addresses are valid EVM addresses', () => {
    for (const vault of vaultManifest.vaults) {
      for (const d of vault.deployments) {
        if (d.chain !== 'evm') continue;
        expect(
          isAddress(d.vaultAddress),
          `${vault.vaultId} chain ${d.chainId}: invalid vaultAddress "${d.vaultAddress}"`
        ).toBe(true);

        if (d.provisionerAddress) {
          expect(
            isAddress(d.provisionerAddress),
            `${vault.vaultId} chain ${d.chainId}: invalid provisionerAddress "${d.provisionerAddress}"`
          ).toBe(true);
        }

        for (const token of d.supplyToken) {
          expect(
            isAddress(token.address),
            `${vault.vaultId} chain ${d.chainId}: invalid ${token.symbol} address "${token.address}"`
          ).toBe(true);
        }
      }
    }
  });

  test('no duplicate vaultIds', () => {
    const ids = vaultManifest.vaults.map((v) => v.vaultId);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates, `duplicate vaultIds: ${duplicates.join(', ')}`).toHaveLength(0);
  });

  test('aera multi-depositor vaults have a provisionerAddress', () => {
    for (const vault of vaultManifest.vaults) {
      if (vault.protocol !== 'aera') continue;
      for (const d of vault.deployments) {
        if (d.chain !== 'evm' || d.vaultType !== 'multi-depositor') continue;
        expect(
          d.provisionerAddress,
          `${vault.vaultId} chain ${d.chainId}: multi-depositor aera vault is missing provisionerAddress`
        ).toBeTruthy();
      }
    }
  });

  const deploymentsByChain = groupByChain();

  for (const [chainId, entries] of deploymentsByChain) {
    const rpcUrl = getRpcUrl(chainId);

    test.skipIf(!rpcUrl)(
      `chain ${chainId}: vault contracts exist and assets match manifest`,
      async () => {
        const chain =
          CHAIN_CONFIGS[chainId] ??
          defineChain({
            id: chainId,
            name: `chain-${chainId}`,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: { default: { http: [rpcUrl!] } },
          });

        const client = createPublicClient({ chain, transport: http(rpcUrl!) });

        await Promise.all(
          entries.map(async ({ vaultId, protocol, vaultAddress, provisionerAddress, supplyToken }) => {
            // Vault must be a deployed contract, not an EOA
            const bytecode = await client.getBytecode({ address: vaultAddress });
            expect(
              bytecode && bytecode.length > 2,
              `${vaultId} chain ${chainId}: no contract bytecode at vault address ${vaultAddress}`
            ).toBe(true);

            if (protocol === 'morpho') {
              // ERC4626 vault — asset() must match the declared supply token
              const asset = await client.readContract({
                address: vaultAddress,
                abi: assetAbi,
                functionName: 'asset',
              });
              expect(
                getAddress(asset),
                `${vaultId} chain ${chainId}: asset() returned ${asset}, expected ${supplyToken[0].address}`
              ).toBe(getAddress(supplyToken[0].address));
            }

            if (protocol === 'aera' && provisionerAddress) {
              // Aera vault — provisioner() must match the declared provisioner address
              const onChainProvisioner = await client.readContract({
                address: vaultAddress,
                abi: provisionerAbi,
                functionName: 'provisioner',
              });
              expect(
                getAddress(onChainProvisioner),
                `${vaultId} chain ${chainId}: provisioner() returned ${onChainProvisioner}, expected ${provisionerAddress}`
              ).toBe(getAddress(provisionerAddress));
            }
          })
        );
      },
      120_000
    );
  }
});
