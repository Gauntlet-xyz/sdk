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
  parseEventLogs,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GauntletClient } from '../src/client';
import { getDepositTx } from '../src/evm/deposit';
import { getWithdrawTx } from '../src/evm/withdraw';
import { VaultId } from '../src/evm/vaults';
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

// First deterministic Anvil test account
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AERA_VAULT_ADDRESS: Address = '0x000000000001CdB57E58Fa75Fe420a0f4D6640D5';
const PROVISIONER_ADDRESS: Address = '0x18CF8d963E1a727F9bbF3AEffa0Bd04FB4dBdA07';
const VAULT_ID = VaultId.AeraUsdAlpha;
const DEPOSIT_AMOUNT = parseUnits('100', 6); // 100 USDC
// NOTE: update this block number if the vault was not yet deployed at block 44_182_978
const FORK_BLOCK = 44_182_978;

// FiatTokenV2.2 stores balances in a mapping at storage slot 9.
function usdcBalanceSlot(address: Address): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [address, 9n]));
}

describe('aera', () => {
  test('can do an async deposit and redeem', async () => {
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

      // ── Deposit ──────────────────────────────────────────────────────────────

      // First call: no existing allowance → expect approve + requestDeposit
      const initialSteps = await getDepositTx(client, {
        vaultId: VAULT_ID,
        amount: DEPOSIT_AMOUNT,
        depositMode: 'async',
      });
      expect(initialSteps).toHaveLength(2);
      expect(initialSteps[0].tx.type).toBe('approve');
      expect(initialSteps[1].tx.type).toBe('requestDeposit');

      // Execute approval only
      await sendTransactionAndWait(testClient, {
        to: initialSteps[0].payload.to,
        data: initialSteps[0].payload.data,
        account: account.address,
      });

      // Second call: allowance is now sufficient → no approve step
      const stepsAfterApproval = await getDepositTx(client, {
        vaultId: VAULT_ID,
        amount: DEPOSIT_AMOUNT,
        depositMode: 'async',
      });
      expect(stepsAfterApproval).toHaveLength(1);
      expect(stepsAfterApproval[0].tx.type).toBe('requestDeposit');

      // Execute requestDeposit and capture the receipt to reconstruct request params for the solver
      const depositReceipt = await sendTransactionAndWait(testClient, {
        to: stepsAfterApproval[0].payload.to,
        data: stepsAfterApproval[0].payload.data,
        account: account.address,
      });

      const depositEvents = parseEventLogs({
        abi: provisionerAbi,
        eventName: 'DepositRequested',
        logs: depositReceipt.logs,
      });
      expect(depositEvents).toHaveLength(1);
      const {
        tokensIn,
        minUnitsOut,
        solverTip: depositTip,
        deadline: depositDeadline,
        maxPriceAge: depositMaxAge,
      } = depositEvents[0].args;

      // ── Solve deposit (impersonate vault owner) ───────────────────────────────

      const vaultContract = getMultiDepositorVault(publicClient, AERA_VAULT_ADDRESS);
      const ownerAddress = await vaultContract.read.owner();
      const feeCalculatorAddress = await vaultContract.read.feeCalculator();

      await testClient.impersonateAccount({ address: ownerAddress });
      await testClient.setBalance({ address: ownerAddress, value: parseEther('10') });

      // Relax thresholds and refresh price so price validation passes in solveRequestsVault
      const currentBlock = await testClient.getBlock();
      const feeCalcContract = getPriceAndFeeCalculator(publicClient, feeCalculatorAddress);
      const [priceState] = await feeCalcContract.read.getVaultState([AERA_VAULT_ADDRESS]);
      const accountantAddress = await feeCalcContract.read.vaultAccountant([AERA_VAULT_ADDRESS]);

      await simulateAndWriteContractAndWait(testClient, {
        ...setThresholdsTxRequest(
          feeCalculatorAddress,
          AERA_VAULT_ADDRESS,
          9_000, // minPriceToleranceRatio (90%)
          11_000, // maxPriceToleranceRatio (110%)
          1, // minUpdateIntervalMinutes
          255, // maxPriceAge (hours, uint8 max)
          30, // maxUpdateDelayDays
          ownerAddress
        ),
      });

      // setUnitPrice requires the vault accountant, not the owner
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
        requestType: 0, // RequestType.DEPOSIT
        user: account.address,
        units: minUnitsOut,
        tokens: tokensIn,
        solverTip: depositTip,
        deadline: depositDeadline,
        maxPriceAge: depositMaxAge,
      };

      await simulateAndWriteContractAndWait(testClient, {
        ...solveRequestsVaultTxRequest(
          PROVISIONER_ADDRESS,
          USDC_ADDRESS,
          [depositRequest],
          ownerAddress
        ),
      });

      const units = await publicClient.readContract({
        address: AERA_VAULT_ADDRESS,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      expect(units).toBeGreaterThan(0n);

      // ── Redeem ────────────────────────────────────────────────────────────────

      // Convert units → token amount so the adapter can compute a non-zero minTokensOut
      const redeemTokenAmount = await feeCalcContract.read.convertUnitsToToken([
        AERA_VAULT_ADDRESS,
        USDC_ADDRESS,
        units,
      ]);

      // withdraw.ts doesn't forward depositMode to the adapter, so isAsync is undefined
      // and the adapter always takes the async path for Aera vaults

      // First call: no existing allowance for vault token → expect approve + requestRedeem
      const initialWithdrawSteps = await getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: redeemTokenAmount,
      });
      expect(initialWithdrawSteps).toHaveLength(2);
      expect(initialWithdrawSteps[0].tx.type).toBe('approve');
      expect(initialWithdrawSteps[1].tx.type).toBe('requestRedeem');

      // Execute approval only
      await testClient.impersonateAccount({ address: account.address });
      await sendTransactionAndWait(testClient, {
        to: initialWithdrawSteps[0].payload.to,
        data: initialWithdrawSteps[0].payload.data,
        account: account.address,
      });

      // Second call: allowance is now sufficient → no approve step
      const withdrawSteps = await getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: redeemTokenAmount,
      });
      expect(withdrawSteps).toHaveLength(1);
      expect(withdrawSteps[0].tx.type).toBe('requestRedeem');

      const redeemReceipt = await sendTransactionAndWait(testClient, {
        to: withdrawSteps[0].payload.to,
        data: withdrawSteps[0].payload.data,
        account: account.address,
      });

      const redeemEvents = parseEventLogs({
        abi: provisionerAbi,
        eventName: 'RedeemRequested',
        logs: redeemReceipt.logs,
      });
      expect(redeemEvents).toHaveLength(1);
      const {
        unitsIn,
        minTokensOut,
        solverTip: redeemTip,
        deadline: redeemDeadline,
        maxPriceAge: redeemMaxAge,
      } = redeemEvents[0].args;

      // ── Solve redeem (still impersonating vault owner) ────────────────────────

      const redeemRequest: ProvisionerRequest = {
        requestType: 1, // RequestType.REDEEM
        user: account.address,
        units: unitsIn,
        tokens: minTokensOut,
        solverTip: redeemTip,
        deadline: redeemDeadline,
        maxPriceAge: redeemMaxAge,
      };

      const usdcBefore = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

      await simulateAndWriteContractAndWait(testClient, {
        ...solveRequestsVaultTxRequest(
          PROVISIONER_ADDRESS,
          USDC_ADDRESS,
          [redeemRequest],
          ownerAddress
        ),
      });

      const usdcAfter = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      expect(usdcAfter).toBeGreaterThan(usdcBefore);

      const unitsAfter = await publicClient.readContract({
        address: AERA_VAULT_ADDRESS,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      // Allow for dust from unit↔token round-trip conversion
      expect(unitsAfter).toBeLessThan(units / 1_000_000n);
    });
  }, 120_000);
});
