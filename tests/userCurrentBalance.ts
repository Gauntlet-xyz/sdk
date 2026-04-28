import { describe, test, expect } from 'vitest';
import { withAnvil, simulateAndWriteContractAndWait } from './utils';
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
  parseEventLogs,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GauntletClient } from '../src/client';
import { getDepositTx } from '../src/evm/deposit';
import { getWithdrawTx } from '../src/evm/withdraw';
import { getUserCurrentBalance } from '../src/evm/userCurrentBalance';
import { erc20Abi } from '../src/evm/abis/erc20';
import { getMultiDepositorVault } from '@gauntletnetworks/aera-v3-ts-sdk/multiDepositorVault';
import {
  solveRequestsVaultTxRequest,
  type ProvisionerRequest,
} from '@gauntletnetworks/aera-v3-ts-sdk/provisioner';
import {
  getPriceAndFeeCalculator,
  setThresholdsTxRequest,
  setUnitPriceTxRequest,
} from '@gauntletnetworks/aera-v3-ts-sdk/priceAndFeeCalculator';
import { provisionerAbi, multiDepositorVaultAbi } from '@gauntletnetworks/aera-v3-ts-sdk/generated';
import { VaultNotFoundError, UnsupportedProtocolError, ChainMismatchError } from '../src/errors';

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AERA_VAULT_ADDRESS: Address = '0x000000000001CdB57E58Fa75Fe420a0f4D6640D5';
const PROVISIONER_ADDRESS: Address = '0x18CF8d963E1a727F9bbF3AEffa0Bd04FB4dBdA07';
const VAULT_ID = 'gtusda';
const DEPOSIT_AMOUNT = parseUnits('100', 6); // 100 USDC
const FORK_BLOCK = 44_182_978;

// FiatTokenV2.2 stores balances in a mapping at storage slot 9.
function usdcBalanceSlot(address: Address): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [address, 9n]));
}

describe('getUserCurrentBalance', () => {
  // ── Fork tests ────────────────────────────────────────────────────────────

  test('zero balance before any position', async () => {
    await withAnvil(base, FORK_BLOCK, async ({ anvil }) => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      const rpcUrl = `http://127.0.0.1:${anvil.port}`;
      const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
      const client = new GauntletClient({ evmClients: { [base.id]: publicClient }, wallet: walletClient });

      const result = await getUserCurrentBalance(client, {
        vaultId: VAULT_ID,
        address: account.address,
        chainId: base.id,
      });

      expect(result).toHaveLength(1);
      expect(result[0].chain).toBe('base');
      expect(result[0].token).toBe(USDC_ADDRESS);
      expect(result[0].decimals).toBe(6);
      expect(result[0].pendingDeposit).toBe(0n);
      expect(result[0].balance).toBe(0n);
      expect(result[0].pendingWithdraw).toBe(0n);
    });
  }, 60_000);

  test('tracks balance through async deposit and redeem lifecycle', async () => {
    await withAnvil(base, FORK_BLOCK, async ({ testClient, anvil }) => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      const rpcUrl = `http://127.0.0.1:${anvil.port}`;
      const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });

      await testClient.setBalance({ address: account.address, value: parseEther('10') });
      await testClient.setStorageAt({
        address: USDC_ADDRESS,
        index: usdcBalanceSlot(account.address),
        value: numberToHex(DEPOSIT_AMOUNT, { size: 32 }),
      });

      const client = new GauntletClient({ evmClients: { [base.id]: publicClient }, wallet: walletClient });

      // ── Deposit: approve then requestDeposit ─────────────────────────────────

      // First call returns approve + requestDeposit; execute approve only.
      const initialSteps = await getDepositTx(client, {
        vaultId: VAULT_ID,
        amount: DEPOSIT_AMOUNT,
        depositMode: 'async',
      });
      expect(initialSteps[0].tx.type).toBe('approve');
      await simulateAndWriteContractAndWait(testClient, {
        address: initialSteps[0].tx.address,
        abi: initialSteps[0].tx.abi,
        functionName: initialSteps[0].tx.functionName,
        args: initialSteps[0].tx.args,
        account: account.address,
      });

      // Second call returns just requestDeposit; execute and capture receipt for solver args.
      const [requestDepositStep] = await getDepositTx(client, {
        vaultId: VAULT_ID,
        amount: DEPOSIT_AMOUNT,
        depositMode: 'async',
      });
      expect(requestDepositStep.tx.type).toBe('requestDeposit');
      const depositReceipt = await simulateAndWriteContractAndWait(testClient, {
        address: requestDepositStep.tx.address,
        abi: requestDepositStep.tx.abi,
        functionName: requestDepositStep.tx.functionName,
        args: requestDepositStep.tx.args,
        account: account.address,
      });

      const depositEvents = parseEventLogs({
        abi: provisionerAbi,
        eventName: 'DepositRequested',
        logs: depositReceipt.logs,
      });
      const { tokensIn, minUnitsOut, solverTip, deadline, maxPriceAge } = depositEvents[0].args;

      // ── Stage 1: pendingDeposit is live ──────────────────────────────────────

      const afterRequest = await getUserCurrentBalance(client, {
        vaultId: VAULT_ID,
        address: account.address,
        chainId: base.id,
      });
      expect(afterRequest[0].pendingDeposit).toBe(DEPOSIT_AMOUNT);
      expect(afterRequest[0].balance).toBe(0n);
      expect(afterRequest[0].pendingWithdraw).toBe(0n);

      // ── Solve deposit ─────────────────────────────────────────────────────────

      const vaultContract = getMultiDepositorVault(publicClient, AERA_VAULT_ADDRESS);
      const ownerAddress = await vaultContract.read.owner();
      const feeCalculatorAddress = await vaultContract.read.feeCalculator();

      await testClient.impersonateAccount({ address: ownerAddress });
      await testClient.setBalance({ address: ownerAddress, value: parseEther('10') });

      const currentBlock = await testClient.getBlock();
      const feeCalcContract = getPriceAndFeeCalculator(publicClient, feeCalculatorAddress);
      const [priceState] = await feeCalcContract.read.getVaultState([AERA_VAULT_ADDRESS]);
      const accountantAddress = await feeCalcContract.read.vaultAccountant([AERA_VAULT_ADDRESS]);

      await simulateAndWriteContractAndWait(testClient, {
        ...setThresholdsTxRequest(feeCalculatorAddress, AERA_VAULT_ADDRESS, 9_000, 11_000, 1, 255, 30, ownerAddress),
      });
      await testClient.impersonateAccount({ address: accountantAddress });
      await testClient.setBalance({ address: accountantAddress, value: parseEther('10') });
      await simulateAndWriteContractAndWait(testClient, {
        ...setUnitPriceTxRequest(
          feeCalculatorAddress,
          AERA_VAULT_ADDRESS,
          priceState.unitPrice,
          Number(currentBlock.timestamp),
          accountantAddress
        ),
      });
      await testClient.impersonateAccount({ address: ownerAddress });

      const depositRequest: ProvisionerRequest = {
        requestType: 0,
        user: account.address,
        units: minUnitsOut,
        tokens: tokensIn,
        solverTip,
        deadline,
        maxPriceAge,
      };
      await simulateAndWriteContractAndWait(testClient, {
        ...solveRequestsVaultTxRequest(PROVISIONER_ADDRESS, USDC_ADDRESS, [depositRequest], ownerAddress),
      });

      // ── Stage 2: deposit solved → balance live ────────────────────────────────

      const afterDepositSolved = await getUserCurrentBalance(client, {
        vaultId: VAULT_ID,
        address: account.address,
        chainId: base.id,
      });
      expect(afterDepositSolved[0].pendingDeposit).toBe(0n);
      expect(afterDepositSolved[0].balance).toBeGreaterThan(0n);
      expect(afterDepositSolved[0].pendingWithdraw).toBe(0n);

      // ── Redeem: approve vault token then requestRedeem ────────────────────────

      await testClient.impersonateAccount({ address: account.address });

      // Convert balance back to token amount for the withdraw call.
      const activeBalance = afterDepositSolved[0].balance;

      const initialWithdrawSteps = await getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: activeBalance,
        depositMode: 'async',
      });
      expect(initialWithdrawSteps[0].tx.type).toBe('approve');
      await simulateAndWriteContractAndWait(testClient, {
        address: initialWithdrawSteps[0].tx.address,
        abi: initialWithdrawSteps[0].tx.abi,
        functionName: initialWithdrawSteps[0].tx.functionName,
        args: initialWithdrawSteps[0].tx.args,
        account: account.address,
      });

      const [requestRedeemStep] = await getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: activeBalance,
        depositMode: 'async',
      });
      expect(requestRedeemStep.tx.type).toBe('requestRedeem');
      const redeemReceipt = await simulateAndWriteContractAndWait(testClient, {
        address: requestRedeemStep.tx.address,
        abi: requestRedeemStep.tx.abi,
        functionName: requestRedeemStep.tx.functionName,
        args: requestRedeemStep.tx.args,
        account: account.address,
      });

      const redeemEvents = parseEventLogs({
        abi: provisionerAbi,
        eventName: 'RedeemRequested',
        logs: redeemReceipt.logs,
      });
      const {
        unitsIn,
        minTokensOut,
        solverTip: redeemTip,
        deadline: redeemDeadline,
        maxPriceAge: redeemMaxAge,
      } = redeemEvents[0].args;

      // ── Stage 3: redeem is pending on-chain ──────────────────────────────────
      // Units were transferred to the provisioner, so active balance is now 0.
      // Use direct contract reads rather than getUserCurrentBalance's log scan:
      // getUserCurrentBalance relies on eth_getLogs which is gated by viem's
      // cached getBlockNumber() (4s TTL). When the public RPC responds quickly
      // the cache is still warm and the query window excludes the RedeemRequested
      // block, making pendingWithdraw return 0n non-deterministically.
      const redeemRequestHash = redeemEvents[0].args.redeemRequestHash!;
      const redeemHashExists = await publicClient.readContract({
        address: PROVISIONER_ADDRESS,
        abi: provisionerAbi,
        functionName: 'asyncRedeemHashes',
        args: [redeemRequestHash],
      });
      expect(redeemHashExists).toBe(true);
      expect(unitsIn).toBeGreaterThan(0n);

      // ── Solve redeem ──────────────────────────────────────────────────────────

      const redeemRequest: ProvisionerRequest = {
        requestType: 1,
        user: account.address,
        units: unitsIn,
        tokens: minTokensOut,
        solverTip: redeemTip,
        deadline: redeemDeadline,
        maxPriceAge: redeemMaxAge,
      };
      await simulateAndWriteContractAndWait(testClient, {
        ...solveRequestsVaultTxRequest(PROVISIONER_ADDRESS, USDC_ADDRESS, [redeemRequest], ownerAddress),
      });

      // ── Stage 4: redeem solved → all clear ───────────────────────────────────

      const afterRedeemSolved = await getUserCurrentBalance(client, {
        vaultId: VAULT_ID,
        address: account.address,
        chainId: base.id,
      });
      expect(afterRedeemSolved[0].pendingDeposit).toBe(0n);
      expect(afterRedeemSolved[0].pendingWithdraw).toBe(0n);
      // Allow for dust from unit↔token round-trip conversion
      const remainingUnits = await publicClient.readContract({
        address: AERA_VAULT_ADDRESS,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      expect(remainingUnits).toBeLessThan(unitsIn / 1_000_000n);
    });
  }, 180_000);

  // ── Error cases (no fork needed) ─────────────────────────────────────────

  test('throws VaultNotFoundError for unknown vaultId', async () => {
    const client = new GauntletClient({});
    await expect(
      getUserCurrentBalance(client, {
        vaultId: 'doesNotExist',
        address: '0x0000000000000000000000000000000000000001',
      })
    ).rejects.toThrow(VaultNotFoundError);
  });

  test('throws UnsupportedProtocolError for Morpho vault', async () => {
    const client = new GauntletClient({});
    await expect(
      getUserCurrentBalance(client, {
        vaultId: 'baseUsdcPrime',
        address: '0x0000000000000000000000000000000000000001',
      })
    ).rejects.toThrow(UnsupportedProtocolError);
  });

  test('throws ChainMismatchError when chainId has no deployment', async () => {
    const client = new GauntletClient({});
    await expect(
      getUserCurrentBalance(client, {
        vaultId: VAULT_ID,
        address: '0x0000000000000000000000000000000000000001',
        chainId: 999,
      })
    ).rejects.toThrow(ChainMismatchError);
  });
});
