import { describe, test, expect } from 'vitest';
import { withAnvil, simulateAndWriteContractAndWait, sendTransactionAndWait, type TestNode } from './utils';
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
import { provisionerV2Abi } from '../src/evm/abis/provisionerV2';

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

// V2 vault (devusda2) — has a V2 provisioner with sync deposit + redeem support
const V2_VAULT_ADDRESS: Address = '0x70d974963f44Bb5CeA01378E83e55cced102EE82';
const V2_VAULT_ID = VaultId.AeraUsdAlphaDevDeux;
// NOTE: devusda2 deployed and V2 provisioner live as of this block
const V2_FORK_BLOCK = 47_000_000;
// V2 fee calculator and its authorised accountant (caller for setAnchorPrice)
const V2_FEE_CALC_ADDRESS: Address = '0xa90fd5C2020DBf19c6c29609dF85F7e4DBAC30db';
const V2_ACCOUNTANT_ADDRESS: Address = '0x67A7791E66624dcE5D3050F5865468AC6c9C4535';
const V2_PROVISIONER_OWNER: Address = '0x920B2Df2e018A688527bf3596F26F29d443903F2';
const V2_PROVISIONER_ADDRESS: Address = '0x11C6a42B70B66bc4A851D35e85A95103b67eC112';
// devusda2 has ~10 USDC AUM at the fork block; keep deposits well below the
// 100% epoch sync-redeem cap so tests don't trip Aera__SyncRedeemEpochCapExceeded.
const V2_DEPOSIT_AMOUNT = parseUnits('5', 6); // 5 USDC = ~50% of vault AUM

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

// ─────────────────────────────────────────────────────────────────────────────
// V2 sync fork tests — execute real transactions against an Anvil fork
// ─────────────────────────────────────────────────────────────────────────────

// Minimal ABI for the V2 fee calculator's setAnchorPrice (V1 uses setUnitPrice — different selector).
const priceAndFeeCalculatorV2SetAnchorAbi = [
  {
    type: 'function',
    name: 'setAnchorPrice',
    inputs: [
      { name: 'vault', type: 'address' },
      { name: 'price', type: 'uint128' },
      { name: 'timestamp', type: 'uint32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

// Minimal ABIs for V2 provisioner owner functions not in the shipped provisionerV2Abi.
const provisionerV2OwnerAbi = [
  {
    type: 'function',
    name: 'setTokenDetails',
    inputs: [
      { name: 'token', type: 'address' },
      {
        name: 'details',
        type: 'tuple',
        components: [
          { name: 'asyncDepositEnabled', type: 'bool' },
          { name: 'asyncRedeemEnabled', type: 'bool' },
          { name: 'syncDepositEnabled', type: 'bool' },
          { name: 'syncRedeemEnabled', type: 'bool' },
          { name: 'asyncDepositMultiplier', type: 'uint16' },
          { name: 'asyncRedeemMultiplier', type: 'uint16' },
          { name: 'syncDepositMultiplier', type: 'uint16' },
          { name: 'syncRedeemMultiplier', type: 'uint16' },
          { name: 'pushFundsSubmitDataPointer', type: 'address' },
          { name: 'pullFundsSubmitDataPointer', type: 'address' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setSyncRedeemDetails',
    inputs: [
      { name: 'maxPriceAge', type: 'uint24' },
      { name: 'relativeCapBps', type: 'uint16' },
      { name: 'absoluteCapNumeraire', type: 'uint80' },
      { name: 'maxDynamicPremiumBps', type: 'uint16' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/**
 * Brings the V2 vault up to a state where sync deposit and redeem work:
 *
 *  1. Seeds the vault's USDC balance so sync redeems can be fulfilled against
 *     the vault's liquid assets (the dev vault has ~10 USDC of AUM but all of
 *     it is deployed off the vault's balance sheet).
 *  2. Enables syncDepositEnabled + syncRedeemEnabled for USDC on the provisioner.
 *  3. Sets sync redeem details (maxPriceAge = 1 day, generous caps) so the
 *     provisioner permits redemptions.
 *  4. Refreshes the fee-calculator anchor price to the current block timestamp
 *     so the SDK stale-price guard (`anchorTimestamp + maxPriceAge < blockTimestamp`)
 *     evaluates to false.
 */
async function setupV2SyncFork({ testClient }: { testClient: TestNode['testClient'] }) {
  // Seed the vault with enough USDC to satisfy sync redeems.  At the fork block
  // the vault's liquid USDC balance is 0 (all AUM is deployed off-balance), so
  // without seeding the vault's own `transfer` would fail.
  await testClient.setStorageAt({
    address: USDC_ADDRESS,
    index: usdcBalanceSlot(V2_VAULT_ADDRESS),
    value: numberToHex(parseUnits('10000', 6), { size: 32 }),
  });
  const block = await testClient.getBlock();
  const blockTimestamp = Number(block.timestamp);

  await testClient.impersonateAccount({ address: V2_PROVISIONER_OWNER });
  await testClient.setBalance({ address: V2_PROVISIONER_OWNER, value: parseEther('10') });

  // ── Configure sync-redeem vault caps (must precede setTokenDetails) ────────
  await simulateAndWriteContractAndWait(testClient, {
    address: V2_PROVISIONER_ADDRESS,
    abi: provisionerV2OwnerAbi,
    functionName: 'setSyncRedeemDetails',
    args: [
      86_400,      // maxPriceAge: 1 day in seconds
      10_000,      // relativeCapBps: 100 % (whole epoch may be redeemed)
      2n**80n - 1n, // absoluteCapNumeraire: uint80 max
      0,           // maxDynamicPremiumBps: no premium (must be in [0, max])
    ],
    account: V2_PROVISIONER_OWNER,
  });

  // ── Enable sync deposit + redeem for USDC ─────────────────────────────────
  // At the fork block the token only has async enabled; we add sync on top.
  await simulateAndWriteContractAndWait(testClient, {
    address: V2_PROVISIONER_ADDRESS,
    abi: provisionerV2OwnerAbi,
    functionName: 'setTokenDetails',
    args: [
      USDC_ADDRESS,
      {
        asyncDepositEnabled: true,
        asyncRedeemEnabled: true,
        syncDepositEnabled: true,
        syncRedeemEnabled: true,
        asyncDepositMultiplier: 10_000,
        asyncRedeemMultiplier: 10_000,
        syncDepositMultiplier: 10_000,
        syncRedeemMultiplier: 10_000,
        pushFundsSubmitDataPointer: '0x0000000000000000000000000000000000000000',
        pullFundsSubmitDataPointer: '0x0000000000000000000000000000000000000000',
      },
    ],
    account: V2_PROVISIONER_OWNER,
  });

  // ── Advance the fee-calculator anchor timestamp to the current block ──────
  // The SDK check is: anchorTimestamp + maxPriceAge < blockTimestamp → stale.
  // Setting anchorTimestamp = blockTimestamp makes the check false (not stale)
  // even when maxPriceAge = 0.
  await testClient.impersonateAccount({ address: V2_ACCOUNTANT_ADDRESS });
  await testClient.setBalance({ address: V2_ACCOUNTANT_ADDRESS, value: parseEther('10') });

  // anchorPrice = 1306988 at the fork block; unchanged since we only bump the timestamp.
  await simulateAndWriteContractAndWait(testClient, {
    address: V2_FEE_CALC_ADDRESS,
    abi: priceAndFeeCalculatorV2SetAnchorAbi,
    functionName: 'setAnchorPrice',
    args: [V2_VAULT_ADDRESS, 1306988n, blockTimestamp],
    account: V2_ACCOUNTANT_ADDRESS,
  });
}

describe('aera V2 sync fork', () => {
  test('can do a V2 sync deposit and redeem by shares', async () => {
    await withAnvil(base, V2_FORK_BLOCK, async ({ testClient, anvil }) => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      const rpcUrl = `http://127.0.0.1:${anvil.port}`;

      await testClient.setBalance({ address: account.address, value: parseEther('10') });
      await testClient.setStorageAt({
        address: USDC_ADDRESS,
        index: usdcBalanceSlot(account.address),
        value: numberToHex(V2_DEPOSIT_AMOUNT, { size: 32 }),
      });

      const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
      const client = new GauntletClient({
        evmClients: { [base.id]: publicClient },
        wallet: walletClient,
      });

      // Enable sync deposit/redeem for USDC and refresh the anchor price before
      // any SDK calls that read token mode support or the stale-price guard.
      await setupV2SyncFork({ testClient });
      await testClient.impersonateAccount({ address: account.address });

      // ── Sync Deposit ──────────────────────────────────────────────────────────

      // No allowance yet → [approve, deposit]; for sync the approval spender is the vault itself
      const initialSteps = await getDepositTx(client, {
        vaultId: V2_VAULT_ID,
        amount: V2_DEPOSIT_AMOUNT,
        depositMode: 'sync',
      });
      expect(initialSteps).toHaveLength(2);
      expect(initialSteps[0].tx.type).toBe('approve');
      expect(initialSteps[0].tx.args[0]).toBe(V2_VAULT_ADDRESS);
      expect(initialSteps[1].tx.type).toBe('deposit');

      const usdcBefore = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

      await sendTransactionAndWait(testClient, {
        to: initialSteps[0].payload.to,
        data: initialSteps[0].payload.data,
        account: account.address,
      });

      // Allowance now sufficient → [deposit] only
      const stepsAfterApproval = await getDepositTx(client, {
        vaultId: V2_VAULT_ID,
        amount: V2_DEPOSIT_AMOUNT,
        depositMode: 'sync',
      });
      expect(stepsAfterApproval).toHaveLength(1);
      expect(stepsAfterApproval[0].tx.type).toBe('deposit');

      await sendTransactionAndWait(testClient, {
        to: stepsAfterApproval[0].payload.to,
        data: stepsAfterApproval[0].payload.data,
        account: account.address,
      });

      const usdcAfterDeposit = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      expect(usdcAfterDeposit).toBeLessThan(usdcBefore);

      const units = await publicClient.readContract({
        address: V2_VAULT_ADDRESS,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      expect(units).toBeGreaterThan(0n);

      // Units are locked for depositRefundTimeout (3600 s) after sync deposit.
      await testClient.increaseTime({ seconds: 3601 });
      await testClient.mine({ blocks: 1 });
      await testClient.impersonateAccount({ address: account.address });

      // ── Sync Redeem by shares ─────────────────────────────────────────────────

      // No vault-unit approval needed for sync redeem — units are burned directly
      const redeemSteps = await getWithdrawTx(client, {
        vaultId: V2_VAULT_ID,
        shares: units,
        depositMode: 'sync',
        slippageBps: 100,
      });
      expect(redeemSteps).toHaveLength(1);
      expect(redeemSteps[0].tx.type).toBe('redeem');
      expect(redeemSteps[0].tx.args[3]).toBe(account.address);

      const redeemReceipt = await sendTransactionAndWait(testClient, {
        to: redeemSteps[0].payload.to,
        data: redeemSteps[0].payload.data,
        account: account.address,
      });

      const redeemedEvents = parseEventLogs({
        abi: provisionerV2Abi,
        eventName: 'Redeemed',
        logs: redeemReceipt.logs,
      });
      expect(redeemedEvents).toHaveLength(1);
      const { user, receiver: redeemReceiver, unitsIn, tokensOut } = redeemedEvents[0].args;
      expect(user).toBe(account.address);
      expect(redeemReceiver).toBe(account.address);
      expect(unitsIn).toBe(units);
      expect(tokensOut).toBeGreaterThan(0n);

      const usdcAfterRedeem = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      expect(usdcAfterRedeem).toBeGreaterThan(usdcAfterDeposit);

      const unitsAfterRedeem = await publicClient.readContract({
        address: V2_VAULT_ADDRESS,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      // All shares redeemed; allow at most 1 wei of dust from share accounting rounding
      expect(unitsAfterRedeem).toBeLessThanOrEqual(1n);
    });
  }, 120_000);

  test('can do a V2 sync withdraw by exact token amount', async () => {
    await withAnvil(base, V2_FORK_BLOCK, async ({ testClient, anvil }) => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      const rpcUrl = `http://127.0.0.1:${anvil.port}`;

      await testClient.setBalance({ address: account.address, value: parseEther('10') });
      await testClient.setStorageAt({
        address: USDC_ADDRESS,
        index: usdcBalanceSlot(account.address),
        value: numberToHex(V2_DEPOSIT_AMOUNT, { size: 32 }),
      });

      const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
      const client = new GauntletClient({
        evmClients: { [base.id]: publicClient },
        wallet: walletClient,
      });

      await setupV2SyncFork({ testClient });
      await testClient.impersonateAccount({ address: account.address });

      // ── Sync Deposit ──────────────────────────────────────────────────────────

      for (const step of await getDepositTx(client, {
        vaultId: V2_VAULT_ID,
        amount: V2_DEPOSIT_AMOUNT,
        depositMode: 'sync',
      })) {
        await sendTransactionAndWait(testClient, {
          to: step.payload.to,
          data: step.payload.data,
          account: account.address,
        });
      }

      const units = await publicClient.readContract({
        address: V2_VAULT_ADDRESS,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      expect(units).toBeGreaterThan(0n);

      const usdcAfterDeposit = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

      // Units are locked for depositRefundTimeout (3600 s) after sync deposit.
      await testClient.increaseTime({ seconds: 3601 });
      await testClient.mine({ blocks: 1 });
      await testClient.impersonateAccount({ address: account.address });

      // ── Sync Withdraw by exact token amount ───────────────────────────────────

      const WITHDRAW_AMOUNT = V2_DEPOSIT_AMOUNT / 2n;

      // Sync withdraw by exact token needs no vault-unit approval
      const withdrawSteps = await getWithdrawTx(client, {
        vaultId: V2_VAULT_ID,
        amount: WITHDRAW_AMOUNT,
        depositMode: 'sync',
        slippageBps: 100,
      });
      expect(withdrawSteps).toHaveLength(1);
      expect(withdrawSteps[0].tx.type).toBe('withdraw');
      expect(withdrawSteps[0].tx.args[3]).toBe(account.address);

      await sendTransactionAndWait(testClient, {
        to: withdrawSteps[0].payload.to,
        data: withdrawSteps[0].payload.data,
        account: account.address,
      });

      const usdcAfterWithdraw = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      // withdraw() delivers exactly the requested token amount
      expect(usdcAfterWithdraw - usdcAfterDeposit).toBe(WITHDRAW_AMOUNT); // V2_DEPOSIT_AMOUNT / 2

      const unitsAfterWithdraw = await publicClient.readContract({
        address: V2_VAULT_ADDRESS,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      // Partial withdraw: some units remain, but fewer than before
      expect(unitsAfterWithdraw).toBeGreaterThan(0n);
      expect(unitsAfterWithdraw).toBeLessThan(units);
    });
  }, 120_000);

  test('can do a V2 sync deposit to a separate receiver and receiver redeems', async () => {
    await withAnvil(base, V2_FORK_BLOCK, async ({ testClient, anvil }) => {
      const alice = privateKeyToAccount(ALICE_PRIVATE_KEY); // depositor
      const bob = privateKeyToAccount(TEST_PRIVATE_KEY); // receiver
      const rpcUrl = `http://127.0.0.1:${anvil.port}`;

      await testClient.setBalance({ address: alice.address, value: parseEther('10') });
      await testClient.setBalance({ address: bob.address, value: parseEther('10') });
      await testClient.setStorageAt({
        address: USDC_ADDRESS,
        index: usdcBalanceSlot(alice.address),
        value: numberToHex(V2_DEPOSIT_AMOUNT, { size: 32 }),
      });

      const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const aliceClient = new GauntletClient({
        evmClients: { [base.id]: publicClient },
        wallet: createWalletClient({ account: alice, chain: base, transport: http(rpcUrl) }),
      });
      const bobClient = new GauntletClient({
        evmClients: { [base.id]: publicClient },
        wallet: createWalletClient({ account: bob, chain: base, transport: http(rpcUrl) }),
      });

      await setupV2SyncFork({ testClient });
      await testClient.impersonateAccount({ address: alice.address });
      await testClient.impersonateAccount({ address: bob.address });

      // ── Bob approves Alice as depositor ───────────────────────────────────────

      const receiverApproval = await getDepositReceiverApprovalTx(bobClient, {
        vaultId: V2_VAULT_ID,
        depositor: alice.address,
      });
      expect(receiverApproval.tx.type).toBe('setDepositReceiverApproval');
      expect(receiverApproval.tx.args[0]).toBe(alice.address);

      await sendTransactionAndWait(testClient, {
        to: receiverApproval.payload.to,
        data: receiverApproval.payload.data,
        account: bob.address,
      });

      // ── Alice deposits, specifying Bob as receiver ────────────────────────────

      const depositSteps = await getDepositTx(aliceClient, {
        vaultId: V2_VAULT_ID,
        amount: V2_DEPOSIT_AMOUNT,
        depositMode: 'sync',
        receiver: bob.address,
      });
      // Last step is the deposit; receiver arg should be Bob
      expect(depositSteps.at(-1)!.tx.type).toBe('deposit');
      expect(depositSteps.at(-1)!.tx.args[3]).toBe(bob.address);

      for (const step of depositSteps) {
        await sendTransactionAndWait(testClient, {
          to: step.payload.to,
          data: step.payload.data,
          account: alice.address,
        });
      }

      // Alice's USDC spent; units land on Bob, not Alice
      const aliceUsdcAfterDeposit = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [alice.address],
      });
      expect(aliceUsdcAfterDeposit).toBeLessThan(V2_DEPOSIT_AMOUNT);

      const aliceUnits = await publicClient.readContract({
        address: V2_VAULT_ADDRESS,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [alice.address],
      });
      expect(aliceUnits).toBe(0n);

      const bobUnits = await publicClient.readContract({
        address: V2_VAULT_ADDRESS,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [bob.address],
      });
      expect(bobUnits).toBeGreaterThan(0n);

      // Units are locked for depositRefundTimeout (3600 s) after sync deposit.
      await testClient.increaseTime({ seconds: 3601 });
      await testClient.mine({ blocks: 1 });
      await testClient.impersonateAccount({ address: bob.address });

      // ── Bob redeems his units back to USDC ────────────────────────────────────

      const redeemSteps = await getWithdrawTx(bobClient, {
        vaultId: V2_VAULT_ID,
        shares: bobUnits,
        depositMode: 'sync',
        slippageBps: 100,
      });
      expect(redeemSteps).toHaveLength(1);
      expect(redeemSteps[0].tx.type).toBe('redeem');
      // Receiver defaults to Bob's address
      expect(redeemSteps[0].tx.args[3]).toBe(bob.address);

      const redeemReceipt = await sendTransactionAndWait(testClient, {
        to: redeemSteps[0].payload.to,
        data: redeemSteps[0].payload.data,
        account: bob.address,
      });

      const redeemedEvents = parseEventLogs({
        abi: provisionerV2Abi,
        eventName: 'Redeemed',
        logs: redeemReceipt.logs,
      });
      expect(redeemedEvents).toHaveLength(1);
      expect(redeemedEvents[0].args.user).toBe(bob.address);
      expect(redeemedEvents[0].args.receiver).toBe(bob.address);
      expect(redeemedEvents[0].args.unitsIn).toBe(bobUnits);

      const bobUsdcAfterRedeem = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [bob.address],
      });
      expect(bobUsdcAfterRedeem).toBeGreaterThan(0n);

      const bobUnitsAfterRedeem = await publicClient.readContract({
        address: V2_VAULT_ADDRESS,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [bob.address],
      });
      expect(bobUnitsAfterRedeem).toBeLessThan(bobUnits / 1_000_000n);
    });
  }, 120_000);
});
