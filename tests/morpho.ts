import { describe, test, expect } from 'vitest';
import { withAnvil, simulateAndWriteContractAndWait, sendTransactionAndWait } from './utils';
import { base } from 'viem/chains';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  numberToHex,
  parseEther,
  parseUnits,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GauntletClient } from '../src/client';
import { getDepositTx } from '../src/evm/deposit';
import { getWithdrawTx } from '../src/evm/withdraw';
import { erc20Abi } from '../src/evm/abis/erc20';
import { erc4626Abi } from '../src/evm/abis/erc4626';
import { resolveVault, VaultId } from '../src/evm/vaults';

// First deterministic Anvil test account
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MORPHO_VAULT_ADDRESS: Address = '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61';
const VAULT_ID = VaultId.BaseUsdcPrime;
const DEPOSIT_AMOUNT = parseUnits('1000', 6); // 1000 USDC
const FORK_BLOCK = 44_182_978;

// FiatTokenV2.2 stores balances in a mapping at storage slot 9.
// Slot for balances[addr] = keccak256(abi.encode(addr, 9))
function usdcBalanceSlot(address: Address): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [address, 9n]));
}

describe('morpho', () => {
  test('can do a morpho deposit', async () => {
    await withAnvil(base, FORK_BLOCK, async ({ testClient, anvil }) => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      const rpcUrl = `http://127.0.0.1:${anvil.port}`;

      await testClient.setBalance({ address: account.address, value: parseEther('10') });
      await testClient.setStorageAt({
        address: USDC_ADDRESS,
        index: usdcBalanceSlot(account.address),
        value: numberToHex(DEPOSIT_AMOUNT, { size: 32 }),
      });

      const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });

      const client = new GauntletClient({
        evmClients: { [base.id]: publicClient },
        wallet: walletClient,
      });

      let steps = await getDepositTx(client, { vaultId: VAULT_ID, amount: DEPOSIT_AMOUNT });
      for (const step of steps) {
        await sendTransactionAndWait(testClient, {
          to: step.payload.to,
          data: step.payload.data,
          account: account.address,
        });
      }

      const shares = await publicClient.readContract({
        address: MORPHO_VAULT_ADDRESS,
        abi: erc4626Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

      const usdc = await publicClient.readContract({
        address: MORPHO_VAULT_ADDRESS,
        abi: erc4626Abi,
        functionName: 'convertToAssets',
        args: [shares],
      });

      // convertToAssets can be 1 wei less than deposited due to ERC4626 rounding
      expect(usdc).toBeGreaterThanOrEqual(DEPOSIT_AMOUNT - 1n);

      // Add a pre-approval to make sure we don't approve when we don't need to
      await simulateAndWriteContractAndWait(testClient, {
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'approve',
        args: [MORPHO_VAULT_ADDRESS, DEPOSIT_AMOUNT],
        account: account.address,
      });
      steps = await getDepositTx(client, { vaultId: VAULT_ID, amount: DEPOSIT_AMOUNT });
      expect(steps.length).toBe(1);
      expect(steps[0].tx.type).toBe('deposit');
    });
  }, 60_000);

  test('can do a morpho withdraw', async () => {
    await withAnvil(base, FORK_BLOCK, async ({ testClient, anvil }) => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      const rpcUrl = `http://127.0.0.1:${anvil.port}`;

      await testClient.setBalance({ address: account.address, value: parseEther('10') });
      await testClient.setStorageAt({
        address: USDC_ADDRESS,
        index: usdcBalanceSlot(account.address),
        value: numberToHex(DEPOSIT_AMOUNT, { size: 32 }),
      });

      const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });

      const client = new GauntletClient({
        evmClients: { [base.id]: publicClient },
        wallet: walletClient,
      });

      // Deposit first
      const depositSteps = await getDepositTx(client, {
        vaultId: VAULT_ID,
        amount: DEPOSIT_AMOUNT,
      });
      for (const step of depositSteps) {
        await sendTransactionAndWait(testClient, {
          to: step.payload.to,
          data: step.payload.data,
          account: account.address,
        });
      }

      const partialWithdrawAmount = 1000n;

      const usdcBeforePartial = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

      // Withdraw partial balance
      const withdrawPartialSteps = await getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: partialWithdrawAmount,
      });
      for (const step of withdrawPartialSteps) {
        await sendTransactionAndWait(testClient, {
          to: step.payload.to,
          data: step.payload.data,
          account: account.address,
        });
      }

      const usdcAfterPartial = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

      expect(usdcAfterPartial - usdcBeforePartial).toBe(partialWithdrawAmount);

      const vault = await resolveVault(client, VAULT_ID);

      if (vault?.vault?.vaultAddress === undefined) {
        expect(false);
        return;
      }

      const sharesBeforePartial = await publicClient.readContract({
        address: vault?.vault?.vaultAddress,
        abi: erc4626Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

      const partialWithdrawShares = sharesBeforePartial / 20n; //5%

      // Withdraw partial balance
      const withdrawPartialSharesSteps = await getWithdrawTx(client, {
        vaultId: VAULT_ID,
        shares: partialWithdrawShares,
      });
      for (const step of withdrawPartialSharesSteps) {
        await sendTransactionAndWait(testClient, {
          to: step.payload.to,
          data: step.payload.data,
          account: account.address,
        });
      }

      const sharesAfterPartial = await publicClient.readContract({
        address: vault?.vault?.vaultAddress,
        abi: erc4626Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

      expect(sharesBeforePartial - sharesAfterPartial).toBe(partialWithdrawShares);

      const usdcBefore = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

      // Withdraw entire balance
      const withdrawSteps = await getWithdrawTx(client, {
        vaultId: VAULT_ID,
        entireAmount: true,
      });
      for (const step of withdrawSteps) {
        await sendTransactionAndWait(testClient, {
          to: step.payload.to,
          data: step.payload.data,
          account: account.address,
        });
      }

      const usdcAfter = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

      expect(usdcAfter).toBeGreaterThan(usdcBefore);
    });
  }, 60_000);
});
