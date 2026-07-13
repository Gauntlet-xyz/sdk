import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type Chain,
  type EIP1193Provider,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { AttributionMode, GauntletClient, type ChainId } from '../client';

/**
 * Structural view of a Privy embedded or connected wallet — matches
 * `ConnectedWallet` from `@privy-io/react-auth` (via `useWallets()`) and
 * `PrivyClient`-side wallets without importing Privy types, so the SDK has no
 * dependency on any `@privy-io` package.
 */
export interface PrivyEthereumWallet {
  /** The wallet's EVM address. */
  address: string;
  /** Privy's EIP-1193 provider factory for this wallet. */
  getEthereumProvider(): Promise<EIP1193Provider>;
}

/**
 * Wraps a Privy wallet in a viem `WalletClient` bound to `chain`, ready to
 * sign SDK transaction steps.
 *
 * ```ts
 * const { wallets } = useWallets();
 * const wallet = await walletClientFromPrivy(wallets[0], base);
 * ```
 */
export async function walletClientFromPrivy(
  wallet: PrivyEthereumWallet,
  chain: Chain
): Promise<WalletClient> {
  const provider = await wallet.getEthereumProvider();
  return createWalletClient({
    account: wallet.address as Address,
    chain,
    transport: custom(provider),
  });
}

export interface PrivyGauntletClientConfig {
  /** The Privy wallet to sign with (e.g. `useWallets().wallets[0]`). */
  wallet: PrivyEthereumWallet;
  /** Chains the client should be able to read from; the first is the wallet's signing chain. */
  chains: [Chain, ...Chain[]];
  /** Per-chain transport override; defaults to each chain's public RPC via `http()`. */
  transports?: Record<ChainId, Transport>;
  apiKey?: string;
  apiUrl?: string;
  attributionMode?: AttributionMode;
  builderCode?: string;
}

/**
 * Opinionated one-call setup for Privy apps: builds public clients for each
 * chain and a signing wallet from the Privy provider, returning a fully
 * configured `GauntletClient`.
 *
 * ```ts
 * const client = await createGauntletClientFromPrivy({
 *   wallet: wallets[0],
 *   chains: [base],
 *   builderCode: 'my-app',
 * });
 * const steps = await getDepositTx(client, { vaultId, amount });
 * ```
 */
export async function createGauntletClientFromPrivy(
  config: PrivyGauntletClientConfig
): Promise<GauntletClient> {
  const evmClients: Record<ChainId, PublicClient> = {};
  for (const chain of config.chains) {
    evmClients[chain.id] = createPublicClient({
      chain,
      transport: config.transports?.[chain.id] ?? http(),
    });
  }

  return new GauntletClient({
    evmClients,
    wallet: await walletClientFromPrivy(config.wallet, config.chains[0]),
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    attributionMode: config.attributionMode,
    builderCode: config.builderCode,
  });
}
