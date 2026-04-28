/**
 * Gauntlet SDK — React hooks example
 *
 * Shows how to use the SDK inside React components with wagmi hooks.
 */
import { useEffect, useMemo, useState } from 'react';
import { usePublicClient, useWalletClient, useAccount, useChainId } from 'wagmi';
import { base } from 'viem/chains';
import { GauntletClient } from '@gauntletnetworks/gauntlet-sdk';
import { getVaults, getDepositTx, getWithdrawTx } from '@gauntletnetworks/gauntlet-sdk/evm';
import type {
  VaultInfo,
  EvmDepositParams,
  EvmWithdrawParams,
} from '@gauntletnetworks/gauntlet-sdk/evm';

// ---------------------------------------------------------------------------
// Hook: build a GauntletClient from the current wagmi context
// ---------------------------------------------------------------------------
function useGauntletClient(): GauntletClient | null {
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient();

  return useMemo(() => {
    if (!publicClient) return null;
    return new GauntletClient({
      evmClients: { [chainId]: publicClient },
      wallet: walletClient ?? undefined,
    });
  }, [chainId, publicClient, walletClient]);
}

// ---------------------------------------------------------------------------
// Hook: list vaults for the current chain
// ---------------------------------------------------------------------------
function useVaults(protocol?: 'aera' | 'morpho'): VaultInfo[] {
  const chainId = useChainId();
  const client = useGauntletClient();
  const [vaults, setVaults] = useState<VaultInfo[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!client) return setVaults([]);
      const result = await getVaults(client, { chainId, protocol });
      if (!cancelled) setVaults(result);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [client, chainId, protocol]);

  return vaults;
}

// ---------------------------------------------------------------------------
// Hook: deposit into a vault
// ---------------------------------------------------------------------------
function useDeposit() {
  const client = useGauntletClient();
  const { address } = useAccount();
  const chainId = useChainId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function deposit(params: Omit<EvmDepositParams, 'chainId'>) {
    if (!client?.wallet || !address) throw new Error('Wallet not connected');
    setPending(true);
    setError(null);
    try {
      const steps = await getDepositTx(client, { ...params, chainId });
      for (const step of steps) {
        await client.wallet.writeContract({
          address: step.address,
          abi: step.abi,
          functionName: step.functionName,
          args: step.args,
          account: address,
        });
      }
    } catch (e) {
      setError(e as Error);
      throw e;
    } finally {
      setPending(false);
    }
  }

  return { deposit, pending, error };
}

// ---------------------------------------------------------------------------
// Hook: withdraw from a vault
// ---------------------------------------------------------------------------
function useWithdraw() {
  const client = useGauntletClient();
  const { address } = useAccount();
  const chainId = useChainId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function withdraw(params: Omit<EvmWithdrawParams, 'chainId'>) {
    if (!client?.wallet || !address) throw new Error('Wallet not connected');
    setPending(true);
    setError(null);
    try {
      const steps = await getWithdrawTx(client, { ...params, chainId });
      for (const step of steps) {
        await client.wallet.writeContract({
          address: step.address,
          abi: step.abi,
          functionName: step.functionName,
          args: step.args,
          account: address,
        });
      }
    } catch (e) {
      setError(e as Error);
      throw e;
    } finally {
      setPending(false);
    }
  }

  return { withdraw, pending, error };
}

// ---------------------------------------------------------------------------
// Example component
// ---------------------------------------------------------------------------
export function VaultDepositButton({ vaultId }: { vaultId: string }) {
  const { deposit, pending, error } = useDeposit();

  return (
    <div>
      <button
        disabled={pending}
        onClick={() => deposit({ vaultId, amount: 100_000_000n })} // 100 USDC
      >
        {pending ? 'Depositing…' : 'Deposit 100 USDC'}
      </button>
      {error && <p style={{ color: 'red' }}>{error.message}</p>}
    </div>
  );
}

export function VaultList() {
  const vaults = useVaults();
  const { withdraw, pending } = useWithdraw();

  return (
    <ul>
      {vaults.map((vault) => (
        <li key={vault.vaultId}>
          <span>{vault.name}</span>
          <button
            disabled={pending}
            onClick={() => withdraw({ vaultId: vault.vaultId, entireAmount: true })}
          >
            Withdraw all
          </button>
        </li>
      ))}
    </ul>
  );
}
