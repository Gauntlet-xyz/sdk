import { expect, test } from 'vitest';
import { createPublicClient, createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { GauntletClient } from '../src/client';
import { erc20Abi } from '../src/evm/abis/erc20';
import { getDepositTx } from '../src/evm/deposit';
import { sendTransactionAndWait, withAnvil } from './utils';

const USDT: Address = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const SPENDER: Address = '0x8CB3649114051cA5119141a34C200D65dc0Faa73';
const WETH_SPENDER: Address = '0x2371e134e3455e0593363cBF89d3b6cf53740618';
const ACCOUNT = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);

test('resets an existing USDT allowance before a larger approval', async () => {
  await withAnvil(mainnet, 20_000_000, async ({ testClient, anvil }) => {
    const transport = http(`http://127.0.0.1:${anvil.port}`);
    const publicClient = createPublicClient({ chain: mainnet, transport });
    const wallet = createWalletClient({ account: ACCOUNT, chain: mainnet, transport });
    const client = new GauntletClient({ evmClients: { [mainnet.id]: publicClient }, wallet });

    const initial = await getDepositTx(client, { vaultId: 'ethUsdtPrime', amount: 1n });
    expect(initial.map(({ tx }) => tx.functionName)).toEqual(['approve', 'deposit']);
    await sendTransactionAndWait(testClient, {
      to: initial[0].payload.to,
      data: initial[0].payload.data,
      account: ACCOUNT.address,
    });

    await expect(
      publicClient.estimateContractGas({
        address: USDT,
        abi: erc20Abi,
        functionName: 'approve',
        args: [SPENDER, 2n],
        account: ACCOUNT.address,
      })
    ).rejects.toThrow();

    const steps = await getDepositTx(client, { vaultId: 'ethUsdtPrime', amount: 2n });
    expect(steps.map(({ tx }) => tx.functionName)).toEqual(['approve', 'approve', 'deposit']);
    expect(steps[0].tx.args).toEqual([SPENDER, 0n]);
    expect(steps[1].tx.args).toEqual([SPENDER, 2n]);

    for (const step of steps.slice(0, 2)) {
      await sendTransactionAndWait(testClient, {
        to: step.payload.to,
        data: step.payload.data,
        account: ACCOUNT.address,
      });
    }
    expect(
      await publicClient.readContract({
        address: USDT,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [ACCOUNT.address, SPENDER],
      })
    ).toBe(2n);

    const sufficient = await getDepositTx(client, { vaultId: 'ethUsdtPrime', amount: 2n });
    expect(sufficient.map(({ tx }) => tx.functionName)).toEqual(['deposit']);

    const wethInitial = await getDepositTx(client, { vaultId: 'ethWethPrime', amount: 1n });
    await sendTransactionAndWait(testClient, {
      to: wethInitial[0].payload.to,
      data: wethInitial[0].payload.data,
      account: ACCOUNT.address,
    });
    const wethSteps = await getDepositTx(client, { vaultId: 'ethWethPrime', amount: 2n });
    expect(wethSteps.map(({ tx }) => tx.functionName)).toEqual(['approve', 'deposit']);
    expect(wethSteps[0].tx.args).toEqual([WETH_SPENDER, 2n]);
  });
}, 60_000);
