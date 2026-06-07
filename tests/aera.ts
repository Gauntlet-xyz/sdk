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
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type Address,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GauntletClient } from '../src/client';
import { getDepositTx } from '../src/evm/deposit';
import { getDepositReceiverApprovalTx } from '../src/evm/depositReceiverApproval';
import { getWithdrawTx } from '../src/evm/withdraw';
import { VaultId } from '../src/evm/vaults';
import { erc20Abi } from '../src/evm/abis/erc20';
import { StalePriceError, UnsupportedDepositModeError, UnsupportedFeatureError } from '../src/errors';
import { resolveAeraRuntimeContracts, resolveContractVersion } from '../src/evm/aeraContracts';
import { ContractVersion, type EvmVaultDeployment } from '../src/evm/types';
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
const ALICE_PRIVATE_KEY = '0x59c6995e998f97a5a0044976f1fbb7f9e2cc59e6da44b6e5d012b6ef4ca5a7f8';

const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AERA_VAULT_ADDRESS: Address = '0x000000000001CdB57E58Fa75Fe420a0f4D6640D5';
const PROVISIONER_ADDRESS: Address = '0x18CF8d963E1a727F9bbF3AEffa0Bd04FB4dBdA07';
const VAULT_ID = VaultId.AeraUsdAlpha;
const DEPOSIT_AMOUNT = parseUnits('100', 6); // 100 USDC
const RECEIVER: Address = '0x00000000000000000000000000000000deadbeef';
// NOTE: update this block number if the vault was not yet deployed at block 44_182_978
const FORK_BLOCK = 44_182_978;

const contractVersionAbi = [
  {
    type: 'function',
    inputs: [],
    name: 'version',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
] as const;

function versionExecutionError(cause: ConstructorParameters<typeof ContractFunctionExecutionError>[0]) {
  return new ContractFunctionExecutionError(cause, {
    abi: contractVersionAbi,
    functionName: 'version',
  });
}

// FiatTokenV2.2 stores balances in a mapping at storage slot 9.
function usdcBalanceSlot(address: Address): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [address, 9n]));
}

function aeraDeployment(): EvmVaultDeployment {
  return {
    chain: 'evm',
    chainId: base.id,
    vaultAddress: AERA_VAULT_ADDRESS,
    vaultType: 'multi-depositor',
    supplyToken: [{ symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 }],
  };
}

// Minimal PublicClient fixture. It only implements the readContract shape
// resolveContractVersion reaches through viem's getContract(...).read.version().
function publicClientWithContractVersion({
  version,
  error,
  onVersionRead,
}: {
  version?: string;
  error?: Error;
  onVersionRead?: () => void;
} = {}): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName !== 'version') throw new Error(`Unexpected read: ${functionName}`);
      onVersionRead?.();
      if (error) throw error;
      if (version === undefined) {
        throw versionExecutionError(new ContractFunctionZeroDataError({ functionName: 'version' }));
      }
      return version;
    },
  } as unknown as PublicClient;
}

function publicClientWithV2Reads({
  allowance = 10_000n,
  blockTimestamp = 100n,
  maxPriceAge = 100n,
  maxDynamicPremiumBps = 0n,
  anchorTimestamp = 100n,
  provisionerAddress = PROVISIONER_ADDRESS,
  feeCalculatorAddress = '0x00000000000000000000000000000000000000f1',
  provisionerVersion = '2.0',
  feeCalculatorVersion = '2.0',
  asyncDepositMultiplier = 10_000,
  asyncRedeemMultiplier = 10_000,
  syncDepositMultiplier = 10_000,
  syncRedeemMultiplier = 9_500,
}: {
  allowance?: bigint;
  blockTimestamp?: bigint;
  maxPriceAge?: bigint;
  maxDynamicPremiumBps?: bigint;
  anchorTimestamp?: bigint;
  provisionerAddress?: Address;
  feeCalculatorAddress?: Address;
  provisionerVersion?: string;
  feeCalculatorVersion?: string;
  asyncDepositMultiplier?: number;
  asyncRedeemMultiplier?: number;
  syncDepositMultiplier?: number;
  syncRedeemMultiplier?: number;
} = {}): PublicClient {
  async function readContract({
    address,
    functionName,
    args,
  }: {
    address?: Address;
    functionName: string;
    args?: readonly unknown[];
  }) {
    switch (functionName) {
      case 'provisioner':
        return provisionerAddress;
      case 'allowance':
        return allowance;
      case 'feeCalculator':
        return feeCalculatorAddress;
      case 'version':
        return address === feeCalculatorAddress ? feeCalculatorVersion : provisionerVersion;
      case 'convertTokenToUnits':
        return 2_000n;
      case 'convertTokenToUnitsIfActive':
        return args?.[2] as bigint;
      case 'convertUnitsToToken':
        return args?.[2] as bigint;
      case 'convertUnitsToTokenIfActive':
        return args?.[2] as bigint;
      case 'tokensDetails':
        return [
          true,
          true,
          true,
          true,
          asyncDepositMultiplier,
          asyncRedeemMultiplier,
          syncDepositMultiplier,
          syncRedeemMultiplier,
          RECEIVER,
          RECEIVER,
        ];
      case 'getSyncRedeemDetails':
        return [maxPriceAge, 10_000n, maxDynamicPremiumBps, 0n, 0n, 0n];
      case 'getAnchorTimestamp':
        return anchorTimestamp;
      default:
        throw new Error(`Unexpected read: ${functionName}`);
    }
  }

  return {
    readContract,
    multicall: async ({
      contracts,
    }: {
      contracts: readonly { functionName: string; args?: readonly unknown[] }[];
    }) => {
      return Promise.all(contracts.map(readContract));
    },
    getBlock: async () => ({ timestamp: blockTimestamp }),
  } as unknown as PublicClient;
}

describe('aera', () => {
  test('detects runtime V2 provisioner version and caches result', async () => {
    let versionReads = 0;
    const v2Client = publicClientWithContractVersion({
      version: '2.0',
      onVersionRead: () => versionReads++,
    });
    const provisionerAddress = '0x0000000000000000000000000000000000000012';

    await expect(resolveContractVersion(v2Client, provisionerAddress)).resolves.toBe(
      ContractVersion.V2
    );
    await expect(resolveContractVersion(v2Client, provisionerAddress)).resolves.toBe(
      ContractVersion.V2
    );

    expect(versionReads).toBe(1);
  });

  test('detects runtime V1 provisioner version and caches result', async () => {
    let versionReads = 0;
    const v1Client = publicClientWithContractVersion({
      version: '1.0',
      onVersionRead: () => versionReads++,
    });
    const provisionerAddress = '0x0000000000000000000000000000000000000011';

    await expect(resolveContractVersion(v1Client, provisionerAddress)).resolves.toBe(
      ContractVersion.V1
    );
    await expect(resolveContractVersion(v1Client, provisionerAddress)).resolves.toBe(
      ContractVersion.V1
    );

    expect(versionReads).toBe(1);
  });

  test('defaults to legacy V1 when provisioner version method is unavailable', async () => {
    await expect(
      resolveContractVersion(
        publicClientWithContractVersion(),
        '0x0000000000000000000000000000000000000010'
      )
    ).resolves.toBe(ContractVersion.V1);
  });

  test('defaults to legacy V1 when provisioner version call reverts without data', async () => {
    await expect(
      resolveContractVersion(
        publicClientWithContractVersion({
          error: versionExecutionError(
            new ContractFunctionRevertedError({
              abi: contractVersionAbi,
              functionName: 'version',
              data: '0x',
              message: 'execution reverted',
            })
          ),
        }),
        '0x0000000000000000000000000000000000000016'
      )
    ).resolves.toBe(ContractVersion.V1);
  });

  test('does not default to V1 when version detection fails for other reasons', async () => {
    const error = new Error('rpc unavailable');

    await expect(
      resolveContractVersion(
        publicClientWithContractVersion({ error }),
        '0x0000000000000000000000000000000000000015'
      )
    ).rejects.toBe(error);
  });

  test('does not default to V1 when version call reverts with a reason', async () => {
    const error = versionExecutionError(
      new ContractFunctionRevertedError({
        abi: contractVersionAbi,
        functionName: 'version',
        data: '0x',
        message: 'version lookup failed',
      })
    );

    await expect(
      resolveContractVersion(
        publicClientWithContractVersion({ error }),
        '0x0000000000000000000000000000000000000017'
      )
    ).rejects.toBe(error);
  });

  test('resolves live provisioner and fee calculator versions independently', async () => {
    const provisionerAddress = '0x0000000000000000000000000000000000000013';
    const feeCalculatorAddress = '0x0000000000000000000000000000000000000014';
    const runtime = await resolveAeraRuntimeContracts(
      publicClientWithV2Reads({
        provisionerAddress,
        feeCalculatorAddress,
        provisionerVersion: '2.0',
        feeCalculatorVersion: '1.0',
      }),
      aeraDeployment()
    );

    expect(runtime.provisioner).toEqual({
      address: provisionerAddress,
      version: ContractVersion.V2,
    });
    expect(runtime.feeCalculator).toEqual({
      address: feeCalculatorAddress,
      version: ContractVersion.V1,
    });
  });

  test('builds V2 deposit receiver approval as a receiver-signed standalone transaction', async () => {
    const receiverAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
    const publicClient = publicClientWithV2Reads();
    const walletClient = createWalletClient({
      account: receiverAccount,
      chain: base,
      transport: http(),
    });
    const client = new GauntletClient({
      evmClients: { [base.id]: publicClient },
      wallet: walletClient,
    });
    client.setManifest({
      version: 'test',
      vaults: [
        {
          vaultId: VAULT_ID,
          name: 'Mock Aera V2',
          protocol: 'aera',
          strategy: 'test',
          deployments: [
            {
              chain: 'evm',
              chainId: base.id,
              vaultAddress: AERA_VAULT_ADDRESS,
              vaultType: 'multi-depositor',
              supplyToken: [{ symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 }],
            },
          ],
        },
      ],
    });

    const approval = await getDepositReceiverApprovalTx(client, {
      vaultId: VAULT_ID,
      depositor: RECEIVER,
    });

    expect(approval.tx.type).toBe('setDepositReceiverApproval');
    expect(approval.tx.functionName).toBe('setDepositReceiverApproval');
    expect(approval.tx.account).toBe(receiverAccount.address);
    expect(approval.tx.args).toEqual([RECEIVER, true]);
  });

  test('does not mix receiver approval into V2 separate-receiver sync deposit steps', async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const publicClient = publicClientWithV2Reads();
    const walletClient = createWalletClient({ account, chain: base, transport: http() });
    const client = new GauntletClient({
      evmClients: { [base.id]: publicClient },
      wallet: walletClient,
    });
    client.setManifest({
      version: 'test',
      vaults: [
        {
          vaultId: VAULT_ID,
          name: 'Mock Aera V2',
          protocol: 'aera',
          strategy: 'test',
          deployments: [
            {
              chain: 'evm',
              chainId: base.id,
              vaultAddress: AERA_VAULT_ADDRESS,
              vaultType: 'multi-depositor',
              supplyToken: [{ symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 }],
            },
          ],
        },
      ],
    });

    const steps = await getDepositTx(client, {
      vaultId: VAULT_ID,
      amount: 2_000n,
      depositMode: 'sync',
      receiver: RECEIVER,
    });

    expect(steps.map((step) => step.tx.type)).toEqual(['deposit']);
    expect(steps[0].tx.account).toBe(account.address);
    expect(steps[0].tx.args[3]).toBe(RECEIVER);
  });

  test('approves the vault and applies V2 sync deposit multiplier', async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const publicClient = publicClientWithV2Reads({
      allowance: 0n,
      syncDepositMultiplier: 9_500,
    });
    const walletClient = createWalletClient({ account, chain: base, transport: http() });
    const client = new GauntletClient({
      evmClients: { [base.id]: publicClient },
      wallet: walletClient,
    });
    client.setManifest({
      version: 'test',
      vaults: [
        {
          vaultId: VAULT_ID,
          name: 'Mock Aera V2',
          protocol: 'aera',
          strategy: 'test',
          deployments: [
            {
              chain: 'evm',
              chainId: base.id,
              vaultAddress: AERA_VAULT_ADDRESS,
              vaultType: 'multi-depositor',
              supplyToken: [{ symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 }],
            },
          ],
        },
      ],
    });

    const steps = await getDepositTx(client, {
      vaultId: VAULT_ID,
      amount: 2_000n,
      depositMode: 'sync',
      receiver: RECEIVER,
      slippageBps: 0,
    });

    expect(steps.map((step) => step.tx.type)).toEqual(['approve', 'deposit']);
    expect(steps[0].tx.args).toEqual([AERA_VAULT_ADDRESS, 2_000n]);
    expect(steps[1].tx.args[2]).toBe(1_900n);
  });

  test('builds Bob receiver approval before Alice deposits to Bob', async () => {
    const alice = privateKeyToAccount(ALICE_PRIVATE_KEY);
    const bob = privateKeyToAccount(TEST_PRIVATE_KEY);
    const publicClient = publicClientWithV2Reads();
    const bobClient = new GauntletClient({
      evmClients: { [base.id]: publicClient },
      wallet: createWalletClient({ account: bob, chain: base, transport: http() }),
    });
    const aliceClient = new GauntletClient({
      evmClients: { [base.id]: publicClient },
      wallet: createWalletClient({ account: alice, chain: base, transport: http() }),
    });
    const manifest = {
      version: 'test',
      vaults: [
        {
          vaultId: VAULT_ID,
          name: 'Mock Aera V2',
          protocol: 'aera' as const,
          strategy: 'test',
          deployments: [
            {
              chain: 'evm' as const,
              chainId: base.id,
              vaultAddress: AERA_VAULT_ADDRESS,
              vaultType: 'multi-depositor' as const,
              supplyToken: [{ symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 }],
            },
          ],
        },
      ],
    };
    bobClient.setManifest(manifest);
    aliceClient.setManifest(manifest);

    const approval = await getDepositReceiverApprovalTx(bobClient, {
      vaultId: VAULT_ID,
      depositor: alice.address,
    });

    expect(approval.tx.type).toBe('setDepositReceiverApproval');
    expect(approval.tx.account).toBe(bob.address);
    expect(approval.tx.args).toEqual([alice.address, true]);

    const depositSteps = await getDepositTx(aliceClient, {
      vaultId: VAULT_ID,
      amount: 2_000n,
      depositMode: 'sync',
      receiver: bob.address,
    });

    expect(depositSteps.map((step) => step.tx.type)).toEqual(['deposit']);
    expect(depositSteps[0].tx.account).toBe(alice.address);
    expect(depositSteps[0].tx.functionName).toBe('deposit');
    expect(depositSteps[0].tx.args[3]).toBe(bob.address);
  });

  test('uses V2 sync redeem premium and ceil rounding for sync withdraw bounds', async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const publicClient = publicClientWithV2Reads({ allowance: 0n });
    const walletClient = createWalletClient({ account, chain: base, transport: http() });
    const client = new GauntletClient({
      evmClients: { [base.id]: publicClient },
      wallet: walletClient,
    });
    client.setManifest({
      version: 'test',
      vaults: [
        {
          vaultId: VAULT_ID,
          name: 'Mock Aera V2',
          protocol: 'aera',
          strategy: 'test',
          deployments: [
            {
              chain: 'evm',
              chainId: base.id,
              vaultAddress: AERA_VAULT_ADDRESS,
              vaultType: 'multi-depositor',
              supplyToken: [{ symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 }],
            },
          ],
        },
      ],
    });

    const [withdraw] = await getWithdrawTx(client, {
      vaultId: VAULT_ID,
      amount: 100n,
      depositMode: 'sync',
      slippageBps: 0,
    });

    expect(withdraw.tx.type).toBe('withdraw');
    expect(withdraw.tx.args[1]).toBe(100n);
    expect(withdraw.tx.args[2]).toBe(106n);

    const [redeem] = await getWithdrawTx(client, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      depositMode: 'sync',
      slippageBps: 0,
    });

    expect(redeem.tx.type).toBe('redeem');
    expect(redeem.tx.args[1]).toBe(1_000n);
    expect(redeem.tx.args[2]).toBe(950n);
  });

  test('rejects V2 sync withdraw and redeem quotes when sync redeem price is stale', async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const publicClient = publicClientWithV2Reads({
      anchorTimestamp: 100n,
      blockTimestamp: 211n,
      maxDynamicPremiumBps: 4_999n,
      maxPriceAge: 100n,
    });
    const walletClient = createWalletClient({ account, chain: base, transport: http() });
    const client = new GauntletClient({
      evmClients: { [base.id]: publicClient },
      wallet: walletClient,
    });
    client.setManifest({
      version: 'test',
      vaults: [
        {
          vaultId: VAULT_ID,
          name: 'Mock Aera V2',
          protocol: 'aera',
          strategy: 'test',
          deployments: [
            {
              chain: 'evm',
              chainId: base.id,
              vaultAddress: AERA_VAULT_ADDRESS,
              vaultType: 'multi-depositor',
              supplyToken: [{ symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 }],
            },
          ],
        },
      ],
    });

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: 100n,
        depositMode: 'sync',
      })
    ).rejects.toThrow(StalePriceError);

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        shares: 1_000n,
        depositMode: 'sync',
      })
    ).rejects.toThrow(StalePriceError);
  });

  test('passes async provisioner solver tip and max price age overrides', async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const publicClient = publicClientWithV2Reads();
    const walletClient = createWalletClient({ account, chain: base, transport: http() });
    const client = new GauntletClient({
      evmClients: { [base.id]: publicClient },
      wallet: walletClient,
    });
    client.setManifest({
      version: 'test',
      vaults: [
        {
          vaultId: VAULT_ID,
          name: 'Mock Aera V2',
          protocol: 'aera',
          strategy: 'test',
          deployments: [
            {
              chain: 'evm',
              chainId: base.id,
              vaultAddress: AERA_VAULT_ADDRESS,
              vaultType: 'multi-depositor',
              supplyToken: [{ symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 }],
            },
          ],
        },
      ],
    });

    const [deposit] = await getDepositTx(client, {
      vaultId: VAULT_ID,
      amount: 2_000n,
      depositMode: 'async',
      slippageBps: 0,
      solverTip: 7n,
      maxPriceAge: 42n,
    });

    expect(deposit.tx.type).toBe('requestDeposit');
    expect(deposit.tx.args[3]).toBe(7n);
    expect(deposit.tx.args[5]).toBe(42n);

    const [redeem] = await getWithdrawTx(client, {
      vaultId: VAULT_ID,
      shares: 100n,
      depositMode: 'async',
      slippageBps: 0,
      solverTip: 11n,
      maxPriceAge: 77n,
    });

    expect(redeem.tx.type).toBe('requestRedeem');
    expect(redeem.tx.args[3]).toBe(11n);
    expect(redeem.tx.args[5]).toBe(77n);
  });

  test('applies async solver tips and provisioner multipliers to bounds', async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const publicClient = publicClientWithV2Reads({
      asyncDepositMultiplier: 9_000,
      asyncRedeemMultiplier: 8_000,
    });
    const walletClient = createWalletClient({ account, chain: base, transport: http() });
    const client = new GauntletClient({
      evmClients: { [base.id]: publicClient },
      wallet: walletClient,
    });
    client.setManifest({
      version: 'test',
      vaults: [
        {
          vaultId: VAULT_ID,
          name: 'Mock Aera V2',
          protocol: 'aera',
          strategy: 'test',
          deployments: [
            {
              chain: 'evm',
              chainId: base.id,
              vaultAddress: AERA_VAULT_ADDRESS,
              vaultType: 'multi-depositor',
              supplyToken: [{ symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 }],
            },
          ],
        },
      ],
    });

    const [deposit] = await getDepositTx(client, {
      vaultId: VAULT_ID,
      amount: 2_000n,
      depositMode: 'async',
      slippageBps: 0,
      solverTip: 200n,
    });

    expect(deposit.tx.type).toBe('requestDeposit');
    expect(deposit.tx.args[1]).toBe(2_000n);
    expect(deposit.tx.args[2]).toBe(1_620n);
    expect(deposit.tx.args[3]).toBe(200n);

    const [redeemByShares] = await getWithdrawTx(client, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      depositMode: 'async',
      slippageBps: 0,
      solverTip: 50n,
    });

    expect(redeemByShares.tx.type).toBe('requestRedeem');
    expect(redeemByShares.tx.args[1]).toBe(1_000n);
    expect(redeemByShares.tx.args[2]).toBe(750n);
    expect(redeemByShares.tx.args[3]).toBe(50n);

    const [redeemByAmount] = await getWithdrawTx(client, {
      vaultId: VAULT_ID,
      amount: 750n,
      depositMode: 'async',
      slippageBps: 0,
      solverTip: 50n,
    });

    expect(redeemByAmount.tx.type).toBe('requestRedeem');
    expect(redeemByAmount.tx.args[1]).toBe(1_000n);
    expect(redeemByAmount.tx.args[2]).toBe(750n);
    expect(redeemByAmount.tx.args[3]).toBe(50n);
  });

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

  test('keeps V1 sync and separate receiver paths rejected', async () => {
    await withAnvil(base, FORK_BLOCK, async ({ anvil }) => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      const rpcUrl = `http://127.0.0.1:${anvil.port}`;
      const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });

      const client = new GauntletClient({
        evmClients: { [base.id]: publicClient },
        wallet: walletClient,
      });
      client.setManifest({
        version: 'test',
        vaults: [
          {
            vaultId: VAULT_ID,
            name: 'Mock Aera V1',
            protocol: 'aera',
            strategy: 'test',
            deployments: [
              {
                chain: 'evm',
                chainId: base.id,
                vaultAddress: AERA_VAULT_ADDRESS,
                vaultType: 'multi-depositor',
                supplyToken: [{ symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 }],
              },
            ],
          },
        ],
      });

      await expect(
        getDepositTx(client, {
          vaultId: VAULT_ID,
          amount: 2_000n,
          depositMode: 'async',
          receiver: RECEIVER,
        })
      ).rejects.toBeInstanceOf(UnsupportedFeatureError);

      await expect(
        getDepositTx(client, {
          vaultId: VAULT_ID,
          amount: 2_000n,
          depositMode: 'sync',
        })
      ).rejects.toBeInstanceOf(UnsupportedDepositModeError);

      await expect(
        getWithdrawTx(client, {
          vaultId: VAULT_ID,
          amount: 2_000n,
          depositMode: 'sync',
        })
      ).rejects.toBeInstanceOf(UnsupportedDepositModeError);
    });
  }, 60_000);

  test('builds V2 provisioner transactions from SDK params', async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const publicClient = publicClientWithV2Reads({ allowance: 0n });
    const walletClient = createWalletClient({ account, chain: base, transport: http() });

    const client = new GauntletClient({
      evmClients: { [base.id]: publicClient },
      wallet: walletClient,
    });
    client.setManifest({
      version: 'test',
      vaults: [
        {
          vaultId: VAULT_ID,
          name: 'Mock Aera V2',
          protocol: 'aera',
          strategy: 'test',
          deployments: [
            {
              chain: 'evm',
              chainId: base.id,
              vaultAddress: AERA_VAULT_ADDRESS,
              vaultType: 'multi-depositor',
              supplyToken: [{ symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 }],
            },
          ],
        },
      ],
    });

    const v2SameReceiverDeposit = await getDepositTx(client, {
      vaultId: VAULT_ID,
      amount: 2_000n,
      depositMode: 'async',
    });
    const sameReceiverRequestDeposit = v2SameReceiverDeposit.find(
      (step) => step.tx.type === 'requestDeposit'
    );
    expect(sameReceiverRequestDeposit?.tx.args).toHaveLength(8);
    expect(sameReceiverRequestDeposit?.tx.args[7]).toBe(account.address);

    const v2Deposit = await getDepositTx(client, {
      vaultId: VAULT_ID,
      amount: 2_000n,
      depositMode: 'async',
      receiver: RECEIVER,
    });
    const requestDeposit = v2Deposit.find((step) => step.tx.type === 'requestDeposit');
    expect(requestDeposit?.tx.args).toHaveLength(8);
    expect(requestDeposit?.tx.args[7]).toBe(RECEIVER);

    const v2SyncDeposit = await getDepositTx(client, {
      vaultId: VAULT_ID,
      amount: 2_000n,
      depositMode: 'sync',
      receiver: RECEIVER,
    });
    expect(v2SyncDeposit.map((step) => step.tx.type)).toEqual(['approve', 'deposit']);
    const deposit = v2SyncDeposit.find((step) => step.tx.type === 'deposit');
    expect(deposit?.tx.functionName).toBe('deposit');
    expect(deposit?.tx.args).toHaveLength(4);
    expect(deposit?.tx.args[0]).toBe(USDC_ADDRESS);
    expect(deposit?.tx.args[1]).toBe(2_000n);
    expect(deposit?.tx.args[3]).toBe(RECEIVER);

    const v2AsyncRedeem = await getWithdrawTx(client, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      depositMode: 'async',
      receiver: RECEIVER,
    });
    const requestRedeem = v2AsyncRedeem.find((step) => step.tx.type === 'requestRedeem');
    expect(requestRedeem?.tx.args).toHaveLength(8);
    expect(requestRedeem?.tx.args[7]).toBe(RECEIVER);
  });
});
