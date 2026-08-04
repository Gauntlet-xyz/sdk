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
  decodeErrorResult,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GauntletClient } from '../src/client';
import { getAeraTokenModeSupport } from '../src';
import { getDepositTx } from '../src/evm/deposit';
import { getDepositReceiverApprovalTx } from '../src/evm/depositReceiverApproval';
import { getWithdrawTx } from '../src/evm/withdraw';
import type { EvmWithdrawParams } from '../src/evm/withdraw';
import { getSyncWithdrawQuote } from '../src/evm/withdrawQuote';
import type {
  SyncWithdrawQuoteBounds,
  SyncWithdrawQuoteContext,
  SyncWithdrawQuoteParams,
} from '../src/evm/withdrawQuote';
import { VaultId } from '../src/evm/vaults';
import { erc20Abi } from '../src/evm/abis/erc20';
import {
  AccountMismatchError,
  AccountRequiredError,
  InvalidSlippageBPSError,
  InvalidSyncWithdrawBoundError,
  InvalidWithdrawParamsError,
  StalePriceError,
  UnsupportedDepositModeError,
  UnsupportedFeatureError,
} from '../src/errors';
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
const SOLVING_GATE_ADDRESS: Address = '0x0000000000000000000000000000000000000050';
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

function versionExecutionError(
  cause: ConstructorParameters<typeof ContractFunctionExecutionError>[0]
) {
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

type ObservedContractRead = {
  address?: Address;
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
};

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
  asyncDepositEnabled = true,
  asyncRedeemEnabled = true,
  syncDepositEnabled = true,
  syncRedeemEnabled = true,
  solvingGateEnabled = true,
  solvingGateAddress = SOLVING_GATE_ADDRESS,
  solvingPaused = false,
  solvingGateReadError,
  epochTimestamp = 0n,
  epochStartTvlNumeraire = 1_000_000n,
  epochRedeemedNumeraire = 0n,
  epochCapNumeraire = 1_000_000n,
  unitsRefundableUntil = 0n,
  balanceOf = 1_000n,
  tokenToNumeraireMultiplier = 1n,
  blockNumber = 123n,
  onRead,
  onMulticall,
}: {
  allowance?: bigint;
  blockTimestamp?: bigint;
  blockNumber?: bigint;
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
  asyncDepositEnabled?: boolean;
  asyncRedeemEnabled?: boolean;
  syncDepositEnabled?: boolean;
  syncRedeemEnabled?: boolean;
  solvingGateEnabled?: boolean;
  solvingGateAddress?: Address;
  solvingPaused?: boolean;
  solvingGateReadError?: Error;
  epochTimestamp?: bigint;
  epochStartTvlNumeraire?: bigint;
  epochRedeemedNumeraire?: bigint;
  epochCapNumeraire?: bigint;
  unitsRefundableUntil?: bigint;
  balanceOf?: bigint;
  tokenToNumeraireMultiplier?: bigint;
  onRead?: (read: ObservedContractRead) => void;
  onMulticall?: (call: { functionNames: string[]; blockNumber?: bigint }) => void;
} = {}): PublicClient {
  async function readContract({
    address,
    functionName,
    args,
    blockNumber,
  }: {
    address?: Address;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }) {
    onRead?.({ address, functionName, args, blockNumber });

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
          asyncDepositEnabled,
          asyncRedeemEnabled,
          syncDepositEnabled,
          syncRedeemEnabled,
          asyncDepositMultiplier,
          asyncRedeemMultiplier,
          syncDepositMultiplier,
          syncRedeemMultiplier,
          RECEIVER,
          RECEIVER,
        ];
      case 'SOLVING_GATE_ENABLED':
        return solvingGateEnabled;
      case 'solvingGate':
        return solvingGateAddress;
      case 'paused':
        if (solvingGateReadError) throw solvingGateReadError;
        return solvingPaused;
      case 'getSyncRedeemDetails':
        return [maxPriceAge, 10_000n, maxDynamicPremiumBps, 0n, 0n, 0n];
      case 'getAnchorTimestamp':
        return anchorTimestamp;
      case 'convertTokenToNumeraire':
        return (args?.[2] as bigint) * tokenToNumeraireMultiplier;
      case 'convertNumeraireToToken':
        return (args?.[2] as bigint) / tokenToNumeraireMultiplier;
      case 'getSyncRedeemEpochState':
        return [epochTimestamp, epochStartTvlNumeraire, epochRedeemedNumeraire, epochCapNumeraire];
      case 'userUnitsRefundableUntil':
        return unitsRefundableUntil;
      case 'balanceOf':
        return balanceOf;
      default:
        throw new Error(`Unexpected read: ${functionName}`);
    }
  }

  return {
    readContract,
    multicall: async ({
      contracts,
      blockNumber,
    }: {
      contracts: readonly { functionName: string; args?: readonly unknown[] }[];
      blockNumber?: bigint;
    }) => {
      onMulticall?.({
        functionNames: contracts.map((contract) => contract.functionName),
        blockNumber,
      });
      return Promise.all(contracts.map((contract) => readContract({ ...contract, blockNumber })));
    },
    getBlock: async () => ({ number: blockNumber, timestamp: blockTimestamp }),
  } as unknown as PublicClient;
}

function aeraV2QuoteClient(publicClient: PublicClient): GauntletClient {
  const client = new GauntletClient({ evmClients: { [base.id]: publicClient } });
  setAeraV2TestManifest(client);
  return client;
}

function setAeraV2TestManifest(client: GauntletClient) {
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
}

function aeraV2WalletClient(publicClient: PublicClient): GauntletClient {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const client = new GauntletClient({
    evmClients: { [base.id]: publicClient },
    wallet: createWalletClient({ account, chain: base, transport: http() }),
  });
  setAeraV2TestManifest(client);
  return client;
}

function syncWithdrawQuoteBounds({
  kind = 'withdraw',
  context,
  shares = 1_000n,
  minTokensOut = 950n,
  tokensOut = 100n,
  maxUnitsIn = 123n,
}: {
  kind?: SyncWithdrawQuoteBounds['kind'];
  context?: Partial<SyncWithdrawQuoteContext>;
  shares?: bigint;
  minTokensOut?: bigint;
  tokensOut?: bigint;
  maxUnitsIn?: bigint;
} = {}): SyncWithdrawQuoteBounds {
  const quoteContext: SyncWithdrawQuoteContext = {
    vaultId: VAULT_ID,
    chainId: base.id,
    tokenAddress: USDC_ADDRESS,
    slippageBps: 100,
    blockNumber: 123n,
    ...context,
    request:
      context?.request ??
      (kind === 'redeem'
        ? { mode: 'shares', shares }
        : { mode: 'amount', amount: tokensOut }),
  };

  if (kind === 'redeem') return { kind, shares, minTokensOut, context: quoteContext };
  return { kind, tokensOut, maxUnitsIn, context: quoteContext };
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

  test('reports available token modes for a mixed V2 provisioner and V1 fee calculator', async () => {
    const client = aeraV2QuoteClient(
      publicClientWithV2Reads({
        provisionerAddress: '0x0000000000000000000000000000000000000021',
        feeCalculatorAddress: '0x0000000000000000000000000000000000000022',
        provisionerVersion: '2.0',
        feeCalculatorVersion: '1.0',
        asyncDepositEnabled: false,
        asyncRedeemEnabled: true,
        syncDepositEnabled: true,
        syncRedeemEnabled: true,
      })
    );

    await expect(getAeraTokenModeSupport(client, { vaultId: VAULT_ID })).resolves.toEqual({
      asyncDeposit: false,
      asyncRedeem: true,
      syncDeposit: true,
      syncRedeem: false,
    });
  });

  test('masks sync token modes while the V2 solving gate is paused', async () => {
    const reads: ObservedContractRead[] = [];
    const client = aeraV2QuoteClient(
      publicClientWithV2Reads({
        asyncDepositEnabled: false,
        asyncRedeemEnabled: true,
        syncDepositEnabled: true,
        syncRedeemEnabled: true,
        solvingPaused: true,
        onRead: (read) => reads.push(read),
      })
    );

    await expect(getAeraTokenModeSupport(client, { vaultId: VAULT_ID })).resolves.toEqual({
      asyncDeposit: false,
      asyncRedeem: true,
      syncDeposit: false,
      syncRedeem: false,
    });
    expect(reads).toContainEqual({
      address: SOLVING_GATE_ADDRESS,
      functionName: 'paused',
      args: [PROVISIONER_ADDRESS, USDC_ADDRESS],
      blockNumber: undefined,
    });
  });

  test('surfaces V2 solving gate read failures', async () => {
    const error = new Error('solving gate unavailable');
    const client = aeraV2QuoteClient(
      publicClientWithV2Reads({ solvingGateReadError: error })
    );

    await expect(getAeraTokenModeSupport(client, { vaultId: VAULT_ID })).rejects.toBe(error);
  });

  test('treats an enabled zero-address V2 solving gate as open', async () => {
    const reads: ObservedContractRead[] = [];
    const client = aeraV2QuoteClient(
      publicClientWithV2Reads({
        asyncDepositEnabled: false,
        asyncRedeemEnabled: true,
        syncDepositEnabled: true,
        syncRedeemEnabled: true,
        solvingGateAddress: zeroAddress,
        onRead: (read) => reads.push(read),
      })
    );

    await expect(getAeraTokenModeSupport(client, { vaultId: VAULT_ID })).resolves.toEqual({
      asyncDeposit: false,
      asyncRedeem: true,
      syncDeposit: true,
      syncRedeem: true,
    });
    expect(reads.some((read) => read.functionName === 'paused')).toBe(false);
  });

  test('explicit async builds do not read the V2 solving gate', async () => {
    const reads: ObservedContractRead[] = [];
    const client = aeraV2WalletClient(
      publicClientWithV2Reads({
        solvingGateReadError: new Error('solving gate unavailable'),
        onRead: (read) => reads.push(read),
      })
    );

    await expect(
      getDepositTx(client, {
        vaultId: VAULT_ID,
        amount: 2_000n,
        depositMode: 'async',
      })
    ).resolves.toMatchObject([{ tx: { type: 'requestDeposit' } }]);
    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        shares: 100n,
        depositMode: 'async',
      })
    ).resolves.toMatchObject([{ tx: { type: 'requestRedeem' } }]);

    expect(
      reads.some(
        (read) =>
          read.functionName === 'SOLVING_GATE_ENABLED' ||
          read.functionName === 'solvingGate' ||
          read.functionName === 'paused'
      )
    ).toBe(false);
  });

  test('explicit async builds still validate async token modes without gate reads', async () => {
    const reads: ObservedContractRead[] = [];
    const client = aeraV2WalletClient(
      publicClientWithV2Reads({
        asyncDepositEnabled: false,
        asyncRedeemEnabled: false,
        solvingGateReadError: new Error('solving gate unavailable'),
        onRead: (read) => reads.push(read),
      })
    );

    await expect(
      getDepositTx(client, {
        vaultId: VAULT_ID,
        amount: 2_000n,
        depositMode: 'async',
      })
    ).rejects.toMatchObject({
      name: UnsupportedDepositModeError.name,
      requested: 'async',
    });
    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        shares: 100n,
        depositMode: 'async',
      })
    ).rejects.toMatchObject({
      name: UnsupportedDepositModeError.name,
      requested: 'async',
    });

    expect(
      reads.some(
        (read) =>
          read.functionName === 'SOLVING_GATE_ENABLED' ||
          read.functionName === 'solvingGate' ||
          read.functionName === 'paused'
      )
    ).toBe(false);
  });

  test('rejects sync withdraw quotes when the fee calculator is not V2', async () => {
    const client = aeraV2QuoteClient(
      publicClientWithV2Reads({
        feeCalculatorAddress: '0x00000000000000000000000000000000000000f2',
        feeCalculatorVersion: '1.0',
      })
    );

    await expect(
      getSyncWithdrawQuote(client, {
        vaultId: VAULT_ID,
        amount: 100n,
      })
    ).rejects.toThrow('Aera: sync redeem requires a V2 price and fee calculator');
  });

  test('rejects sync withdraw transactions when the fee calculator is not V2', async () => {
    const client = aeraV2WalletClient(
      publicClientWithV2Reads({
        feeCalculatorAddress: '0x00000000000000000000000000000000000000f2',
        feeCalculatorVersion: '1.0',
      })
    );

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: 100n,
        depositMode: 'sync',
      })
    ).rejects.toThrow('Aera: sync redeem requires a V2 price and fee calculator');
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
    const client = aeraV2WalletClient(publicClientWithV2Reads({ allowance: 0n }));

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

  test('decodes V2 provisioner revert selectors from the shipped ABI', () => {
    const syncRedeemErrorNames = [
      'Aera__MaxUnitsInExceeded',
      'Aera__MinTokensOutNotMet',
      'Aera__PriceAndFeeCalculatorVaultPaused',
      'Aera__PullFundsSubmitDataNotSet',
      'Aera__SolvingPaused',
      'Aera__SyncRedeemDisabled',
      'Aera__SyncRedeemEpochCapExceeded',
      'Aera__SyncRedeemMaxPriceAgeExceeded',
      'Aera__TokensZero',
      'Aera__UnitsLocked',
      'Aera__UnitsZero',
    ] as const;

    for (const errorName of syncRedeemErrorNames) {
      const decoded = decodeErrorResult({
        abi: provisionerV2Abi,
        data: toFunctionSelector(`${errorName}()`),
      });
      expect(decoded.errorName).toBe(errorName);
    }
  });

  test('pins V2 sync withdraw bounds from the supplied quote', async () => {
    const client = aeraV2WalletClient(publicClientWithV2Reads());

    const [withdraw] = await getWithdrawTx(client, {
      vaultId: VAULT_ID,
      amount: 100n,
      depositMode: 'sync',
      syncWithdrawQuote: syncWithdrawQuoteBounds(),
    });

    expect(withdraw.tx.type).toBe('withdraw');
    expect(withdraw.tx.args[1]).toBe(100n);
    expect(withdraw.tx.args[2]).toBe(123n);
  });

  test('treats supplied sync quote bounds as a sync withdraw request', async () => {
    const client = aeraV2WalletClient(publicClientWithV2Reads());

    const [withdraw] = await getWithdrawTx(client, {
      vaultId: VAULT_ID,
      amount: 100n,
      syncWithdrawQuote: syncWithdrawQuoteBounds(),
    });

    expect(withdraw.tx.type).toBe('withdraw');
    expect(withdraw.tx.args[1]).toBe(100n);
    expect(withdraw.tx.args[2]).toBe(123n);
  });

  test('inherits generated quote slippage when building a sync withdraw transaction', async () => {
    const client = aeraV2WalletClient(publicClientWithV2Reads());
    const quote = await getSyncWithdrawQuote(client, {
      vaultId: VAULT_ID,
      amount: 100n,
      account: privateKeyToAccount(TEST_PRIVATE_KEY).address,
      slippageBps: 50,
    });

    const [withdraw] = await getWithdrawTx(client, {
      vaultId: VAULT_ID,
      amount: 100n,
      syncWithdrawQuote: quote,
    });

    expect(withdraw.tx.type).toBe('withdraw');
    expect(withdraw.tx.args[1]).toBe(quote.tokensOut);
    expect(withdraw.tx.args[2]).toBe(quote.maxUnitsIn);

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: 100n,
        slippageBps: 51,
        syncWithdrawQuote: quote,
      })
    ).rejects.toBeInstanceOf(InvalidWithdrawParamsError);
  });

  test('builds sync redeem transactions from generated quote bounds', async () => {
    const quoteClient = aeraV2WalletClient(
      publicClientWithV2Reads({ syncRedeemMultiplier: 9_500 })
    );
    const quote = await getSyncWithdrawQuote(quoteClient, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      account: privateKeyToAccount(TEST_PRIVATE_KEY).address,
      slippageBps: 100,
    });
    const buildClient = aeraV2WalletClient(
      publicClientWithV2Reads({ syncRedeemMultiplier: 5_000 })
    );

    const [redeem] = await getWithdrawTx(buildClient, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      syncWithdrawQuote: quote,
    });

    expect(redeem.tx.type).toBe('redeem');
    expect(redeem.tx.args[1]).toBe(quote.shares);
    expect(redeem.tx.args[2]).toBe(quote.minTokensOut);
  });

  test('rejects sync quote bounds for async withdraw requests', async () => {
    const client = aeraV2WalletClient(publicClientWithV2Reads());

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: 100n,
        depositMode: 'async',
        syncWithdrawQuote: syncWithdrawQuoteBounds(),
      })
    ).rejects.toBeInstanceOf(InvalidWithdrawParamsError);
  });

  test('does not silently fall back to async when supplied sync quote bounds are unsupported', async () => {
    const client = aeraV2WalletClient(
      publicClientWithV2Reads({
        asyncRedeemEnabled: true,
        syncRedeemEnabled: false,
      })
    );

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: 100n,
        syncWithdrawQuote: syncWithdrawQuoteBounds(),
      })
    ).rejects.toThrow('sync operations (available: async)');
  });

  test('rejects sync quote bounds whose exact amount differs from the transaction', async () => {
    const client = aeraV2WalletClient(publicClientWithV2Reads());

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: 101n,
        syncWithdrawQuote: syncWithdrawQuoteBounds({
          context: { request: { mode: 'amount', amount: 101n } },
        }),
      })
    ).rejects.toBeInstanceOf(InvalidWithdrawParamsError);
  });

  test('rejects sync quote bounds whose exact shares differ from the transaction', async () => {
    const client = aeraV2WalletClient(publicClientWithV2Reads());

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        shares: 1_001n,
        syncWithdrawQuote: syncWithdrawQuoteBounds({
          kind: 'redeem',
          shares: 1_000n,
          minTokensOut: 950n,
          context: { request: { mode: 'shares', shares: 1_001n } },
        }),
      })
    ).rejects.toBeInstanceOf(InvalidWithdrawParamsError);
  });

  test('accepts sync quote bounds produced at an earlier block', async () => {
    const client = aeraV2WalletClient(publicClientWithV2Reads({ blockNumber: 124n }));

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: 100n,
        syncWithdrawQuote: syncWithdrawQuoteBounds(),
      })
    ).resolves.toMatchObject([{ tx: { type: 'withdraw' } }]);
  });

  test.each([
    ['vault', { vaultId: V2_VAULT_ID }],
    ['chain', { chainId: 1 }],
    ['token', { tokenAddress: RECEIVER }],
  ] satisfies [string, Partial<SyncWithdrawQuoteContext>][])(
    'rejects sync quote bounds from a different %s',
    async (_field, context) => {
      const client = aeraV2WalletClient(publicClientWithV2Reads());

      await expect(
        getWithdrawTx(client, {
          vaultId: VAULT_ID,
          amount: 100n,
          depositMode: 'sync',
          syncWithdrawQuote: syncWithdrawQuoteBounds({ context }),
        })
      ).rejects.toBeInstanceOf(InvalidWithdrawParamsError);
    }
  );

  test('rejects account-scoped sync quote bounds produced for a different wallet', async () => {
    const client = aeraV2WalletClient(publicClientWithV2Reads());

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: 100n,
        depositMode: 'sync',
        syncWithdrawQuote: syncWithdrawQuoteBounds({
          context: { account: RECEIVER },
        }),
      })
    ).rejects.toBeInstanceOf(InvalidWithdrawParamsError);
  });

  test('quotes a sync redeem by shares with rate split, slippage, and capacity', async () => {
    const client = aeraV2QuoteClient(publicClientWithV2Reads());

    const quote = await getSyncWithdrawQuote(client, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      account: RECEIVER,
      slippageBps: 0,
    });

    expect(quote.kind).toBe('redeem');
    expect(quote.shares).toBe(1_000n);
    expect(quote.tokensOut).toBe(950n); // 1000 * 9500/10000
    expect(quote.minTokensOut).toBe(950n); // slippage 0
    expect(quote.maxUnitsIn).toBe(1_000n);
    expect(quote.rate).toEqual({
      baseMultiplierBps: 9_500n,
      dynamicPremiumBps: 0n,
      effectiveMultiplierBps: 9_500n,
    });
    expect(quote.capacity.remainingNumeraire).toBe(1_000_000n);
    expect(quote.capacity.remainingTokens).toBe(1_000_000n);
    expect(quote.capacity.requestNumeraire).toBe(950n);
    expect(quote.capacity.exceedsCapacity).toBe(false);
    expect(quote.unitsLockedUntil).toBe(0n);
  });

  test('quotes a sync withdraw with exact token out and slippage-bounded shares', async () => {
    const client = aeraV2QuoteClient(publicClientWithV2Reads());

    const quote = await getSyncWithdrawQuote(client, {
      vaultId: VAULT_ID,
      amount: 100n,
      account: RECEIVER,
      slippageBps: 100,
    });

    expect(quote.kind).toBe('withdraw');
    expect(quote.tokensOut).toBe(100n);
    expect(quote.minTokensOut).toBe(100n);
    expect(quote.shares).toBe(106n); // ceil(100 * 10000/9500)
    expect(quote.maxUnitsIn).toBe(108n); // ceil(106 * 10100/10000)
  });

  test('quotes sync withdraws from a single block snapshot', async () => {
    const quoteBlockNumber = 47_000_123n;
    const reads: ObservedContractRead[] = [];
    const multicalls: { functionNames: string[]; blockNumber?: bigint }[] = [];
    const client = aeraV2QuoteClient(
      publicClientWithV2Reads({
        blockNumber: quoteBlockNumber,
        provisionerAddress: '0x0000000000000000000000000000000000000a01',
        feeCalculatorAddress: '0x0000000000000000000000000000000000000f01',
        onRead: (read) => reads.push(read),
        onMulticall: (call) => multicalls.push(call),
      })
    );

    await getSyncWithdrawQuote(client, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      account: RECEIVER,
      slippageBps: 0,
    });

    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((read) => read.blockNumber === quoteBlockNumber)).toBe(true);
    expect(reads).toContainEqual({
      address: SOLVING_GATE_ADDRESS,
      functionName: 'paused',
      args: ['0x0000000000000000000000000000000000000a01', USDC_ADDRESS],
      blockNumber: quoteBlockNumber,
    });
    expect(multicalls.length).toBeGreaterThan(0);
    expect(multicalls.every((call) => call.blockNumber === quoteBlockNumber)).toBe(true);
  });

  test('computes price-age dynamic premium with equality freshness and ceil rounding', async () => {
    const boundaryClient = aeraV2QuoteClient(
      publicClientWithV2Reads({
        anchorTimestamp: 100n,
        blockTimestamp: 200n,
        maxPriceAge: 100n,
        maxDynamicPremiumBps: 4_999n,
      })
    );

    await expect(
      getSyncWithdrawQuote(boundaryClient, {
        vaultId: VAULT_ID,
        shares: 1_000n,
        account: RECEIVER,
        slippageBps: 0,
      })
    ).resolves.toMatchObject({
      rate: {
        baseMultiplierBps: 9_500n,
        dynamicPremiumBps: 4_999n,
        effectiveMultiplierBps: 4_501n,
      },
    });

    const roundingClient = aeraV2QuoteClient(
      publicClientWithV2Reads({
        anchorTimestamp: 199n,
        blockTimestamp: 200n,
        maxPriceAge: 3n,
        maxDynamicPremiumBps: 2n,
      })
    );

    const quote = await getSyncWithdrawQuote(roundingClient, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      account: RECEIVER,
      slippageBps: 0,
    });

    expect(quote.rate.dynamicPremiumBps).toBe(1n);
    expect(quote.rate.effectiveMultiplierBps).toBe(9_499n);
  });

  test('uses the sync redeem multiplier tuple index for quotes', async () => {
    const client = aeraV2QuoteClient(
      publicClientWithV2Reads({
        asyncRedeemMultiplier: 8_100,
        syncDepositMultiplier: 8_200,
        syncRedeemMultiplier: 8_300,
      })
    );

    const quote = await getSyncWithdrawQuote(client, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      account: RECEIVER,
      slippageBps: 0,
    });

    expect(quote.tokensOut).toBe(830n);
    expect(quote.rate.baseMultiplierBps).toBe(8_300n);
  });

  test('accounts sync redeem capacity from token output numeraire and allows equality', async () => {
    const client = aeraV2QuoteClient(
      publicClientWithV2Reads({
        epochCapNumeraire: 1_900n,
        tokenToNumeraireMultiplier: 2n,
      })
    );

    const quote = await getSyncWithdrawQuote(client, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      account: RECEIVER,
      slippageBps: 0,
    });

    expect(quote.tokensOut).toBe(950n);
    expect(quote.capacity.requestNumeraire).toBe(1_900n);
    expect(quote.capacity.remainingNumeraire).toBe(1_900n);
    expect(quote.capacity.exceedsCapacity).toBe(false);

    const exceededClient = aeraV2QuoteClient(
      publicClientWithV2Reads({
        epochCapNumeraire: 1_899n,
        tokenToNumeraireMultiplier: 2n,
      })
    );

    await expect(
      getSyncWithdrawQuote(exceededClient, {
        vaultId: VAULT_ID,
        shares: 1_000n,
        account: RECEIVER,
        slippageBps: 0,
      })
    ).resolves.toMatchObject({
      capacity: {
        requestNumeraire: 1_900n,
        remainingNumeraire: 1_899n,
        exceedsCapacity: true,
      },
    });
  });

  test('flags when a sync redeem exceeds remaining epoch capacity', async () => {
    const client = aeraV2QuoteClient(publicClientWithV2Reads({ epochCapNumeraire: 500n }));

    const quote = await getSyncWithdrawQuote(client, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      account: RECEIVER,
      slippageBps: 0,
    });

    expect(quote.tokensOut).toBe(950n);
    expect(quote.capacity.remainingNumeraire).toBe(500n);
    expect(quote.capacity.exceedsCapacity).toBe(true);
  });

  test('treats zero-cap epoch state as instant unavailable', async () => {
    const client = aeraV2QuoteClient(
      publicClientWithV2Reads({
        epochStartTvlNumeraire: 0n,
        epochCapNumeraire: 0n,
      })
    );

    const quote = await getSyncWithdrawQuote(client, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      account: RECEIVER,
      slippageBps: 0,
    });

    expect(quote.capacity.remainingNumeraire).toBe(0n);
    expect(quote.capacity.exceedsCapacity).toBe(true);
  });

  test('surfaces a units lock and rejects a stale-price sync quote', async () => {
    const lockedClient = aeraV2QuoteClient(publicClientWithV2Reads({ unitsRefundableUntil: 999n }));
    const locked = await getSyncWithdrawQuote(lockedClient, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      account: RECEIVER,
      slippageBps: 0,
    });
    expect(locked.unitsLockedUntil).toBe(999n);

    const staleClient = aeraV2QuoteClient(
      publicClientWithV2Reads({ blockTimestamp: 1_000n, anchorTimestamp: 100n, maxPriceAge: 100n })
    );
    await expect(
      getSyncWithdrawQuote(staleClient, {
        vaultId: VAULT_ID,
        shares: 1_000n,
        account: RECEIVER,
        slippageBps: 0,
      })
    ).rejects.toBeInstanceOf(StalePriceError);
  });

  test('rejects full-balance transaction builds when quoted account differs from wallet', async () => {
    const walletAccount = privateKeyToAccount(TEST_PRIVATE_KEY).address;
    const quotedAccount = RECEIVER;
    let balanceOfReads = 0;
    const publicClient = publicClientWithV2Reads();
    const guardedPublicClient = {
      ...publicClient,
      readContract: async (params: Parameters<typeof publicClient.readContract>[0]) => {
        if (params.functionName === 'balanceOf') {
          balanceOfReads += 1;
        }
        return publicClient.readContract(params);
      },
    } as PublicClient;
    const client = aeraV2WalletClient(guardedPublicClient);

    expect(quotedAccount.toLowerCase()).not.toBe(walletAccount.toLowerCase());
    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        account: quotedAccount,
        entireAmount: true,
        depositMode: 'sync',
      })
    ).rejects.toMatchObject({
      name: AccountMismatchError.name,
      expected: walletAccount,
      received: quotedAccount,
    });
    expect(balanceOfReads).toBe(0);
  });

  test('builds full-balance transactions from the wallet account when no explicit account is passed', async () => {
    const client = aeraV2WalletClient(publicClientWithV2Reads());

    const [redeem] = await getWithdrawTx(client, {
      vaultId: VAULT_ID,
      entireAmount: true,
      depositMode: 'sync',
    });

    expect(redeem.tx.type).toBe('redeem');
    expect(redeem.tx.account).toBe(privateKeyToAccount(TEST_PRIVATE_KEY).address);
  });

  test('rejects stale full-balance sync quote shares', async () => {
    const walletAccount = privateKeyToAccount(TEST_PRIVATE_KEY).address;
    const client = aeraV2WalletClient(publicClientWithV2Reads({ balanceOf: 1_000n }));

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        entireAmount: true,
        depositMode: 'sync',
        syncWithdrawQuote: syncWithdrawQuoteBounds({
          kind: 'redeem',
          shares: 999n,
          minTokensOut: 949n,
          context: {
            account: walletAccount,
            request: { mode: 'entireAmount', account: walletAccount },
          },
        }),
      })
    ).rejects.toBeInstanceOf(InvalidWithdrawParamsError);
  });

  test('quotes explicit sync withdraw modes without an account and skips units-lock reads', async () => {
    const client = aeraV2QuoteClient(publicClientWithV2Reads({ unitsRefundableUntil: 999n }));

    const byAmount = await getSyncWithdrawQuote(client, {
      vaultId: VAULT_ID,
      amount: 100n,
      slippageBps: 0,
    });

    expect(byAmount.kind).toBe('withdraw');
    expect(byAmount.unitsLockedUntil).toBeUndefined();

    const byShares = await getSyncWithdrawQuote(client, {
      vaultId: VAULT_ID,
      shares: 1_000n,
      slippageBps: 0,
    });

    expect(byShares.kind).toBe('redeem');
    expect(byShares.unitsLockedUntil).toBeUndefined();
  });

  test('rejects entire-amount sync quotes without an explicit account at runtime', async () => {
    const client = aeraV2QuoteClient(publicClientWithV2Reads());

    await expect(
      getSyncWithdrawQuote(client, {
        vaultId: VAULT_ID,
        entireAmount: true,
      } as unknown as SyncWithdrawQuoteParams)
    ).rejects.toMatchObject({
      name: AccountRequiredError.name,
      message:
        'No account specified. Pass the required account, or configure a wallet when building transactions.',
    });
  });

  test('rejects ambiguous sync quote sizing params at runtime', async () => {
    const client = aeraV2QuoteClient(publicClientWithV2Reads());

    await expect(
      getSyncWithdrawQuote(client, {
        vaultId: VAULT_ID,
        amount: 100n,
        shares: 1_000n,
      } as unknown as SyncWithdrawQuoteParams)
    ).rejects.toBeInstanceOf(InvalidWithdrawParamsError);
  });

  test('rejects ambiguous withdraw transaction sizing params at runtime', async () => {
    const client = aeraV2WalletClient(publicClientWithV2Reads());

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: 100n,
        shares: 1_000n,
      } as unknown as EvmWithdrawParams)
    ).rejects.toBeInstanceOf(InvalidWithdrawParamsError);

    await expect(
      getWithdrawTx(client, {
        vaultId: VAULT_ID,
        amount: 100n,
        entireAmount: true,
      } as unknown as EvmWithdrawParams)
    ).rejects.toBeInstanceOf(InvalidWithdrawParamsError);
  });

  test('rejects sync quote and transaction builds that would submit zero bounds', async () => {
    const quoteClient = aeraV2QuoteClient(publicClientWithV2Reads());

    await expect(
      getSyncWithdrawQuote(quoteClient, {
        vaultId: VAULT_ID,
        shares: 1_000n,
        account: RECEIVER,
        slippageBps: 10_001,
      })
    ).rejects.toBeInstanceOf(InvalidSlippageBPSError);

    await expect(
      getSyncWithdrawQuote(quoteClient, {
        vaultId: VAULT_ID,
        shares: 1_000n,
        account: RECEIVER,
        slippageBps: 10_000,
      })
    ).rejects.toBeInstanceOf(InvalidSyncWithdrawBoundError);

    await expect(
      getSyncWithdrawQuote(quoteClient, {
        vaultId: VAULT_ID,
        amount: 0n,
        account: RECEIVER,
        slippageBps: 0,
      })
    ).rejects.toBeInstanceOf(InvalidSyncWithdrawBoundError);

    const txClient = aeraV2WalletClient(publicClientWithV2Reads());

    await expect(
      getWithdrawTx(txClient, {
        vaultId: VAULT_ID,
        shares: 1_000n,
        depositMode: 'sync',
        slippageBps: 10_000,
      })
    ).rejects.toBeInstanceOf(InvalidSyncWithdrawBoundError);

    await expect(
      getWithdrawTx(txClient, {
        vaultId: VAULT_ID,
        amount: 0n,
        depositMode: 'sync',
        slippageBps: 0,
      })
    ).rejects.toBeInstanceOf(InvalidSyncWithdrawBoundError);
  });

  test('rejects V2 sync withdraw and redeem quotes when sync redeem price is stale', async () => {
    const client = aeraV2WalletClient(
      publicClientWithV2Reads({
        anchorTimestamp: 100n,
        blockTimestamp: 211n,
        maxDynamicPremiumBps: 4_999n,
        maxPriceAge: 100n,
      })
    );

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

  test('rejects sync quotes when sync redeem is disabled and reports async availability', async () => {
    const client = aeraV2QuoteClient(
      publicClientWithV2Reads({
        asyncRedeemEnabled: true,
        syncRedeemEnabled: false,
      })
    );

    await expect(
      getSyncWithdrawQuote(client, {
        vaultId: VAULT_ID,
        shares: 1_000n,
        account: RECEIVER,
      })
    ).rejects.toThrow('sync operations (available: async)');
  });

  test('rejects sync quotes and quoted builds while the solving gate is paused', async () => {
    const publicClient = publicClientWithV2Reads({
      asyncRedeemEnabled: true,
      syncRedeemEnabled: true,
      solvingPaused: true,
    });

    await expect(
      getSyncWithdrawQuote(aeraV2QuoteClient(publicClient), {
        vaultId: VAULT_ID,
        amount: 100n,
      })
    ).rejects.toThrow('sync operations (available: async)');

    await expect(
      getWithdrawTx(aeraV2WalletClient(publicClient), {
        vaultId: VAULT_ID,
        amount: 100n,
        syncWithdrawQuote: syncWithdrawQuoteBounds(),
      })
    ).rejects.toThrow('sync operations (available: async)');
  });

  test('resolves withdraw mode from live redeem support without silent fallback', async () => {
    const asyncOnly = aeraV2WalletClient(
      publicClientWithV2Reads({
        asyncRedeemEnabled: true,
        syncRedeemEnabled: false,
      })
    );

    await expect(
      getWithdrawTx(asyncOnly, {
        vaultId: VAULT_ID,
        shares: 1_000n,
      })
    ).resolves.toMatchObject([{ tx: { type: 'requestRedeem' } }]);

    const syncOnly = aeraV2WalletClient(
      publicClientWithV2Reads({
        asyncRedeemEnabled: false,
        syncRedeemEnabled: true,
      })
    );

    await expect(
      getWithdrawTx(syncOnly, {
        vaultId: VAULT_ID,
        amount: 100n,
        slippageBps: 0,
      })
    ).resolves.toMatchObject([{ tx: { type: 'withdraw' } }]);

    const noModes = aeraV2WalletClient(
      publicClientWithV2Reads({
        asyncRedeemEnabled: false,
        syncRedeemEnabled: false,
      })
    );

    await expect(
      getWithdrawTx(noModes, {
        vaultId: VAULT_ID,
        amount: 100n,
      })
    ).rejects.toThrow('async operations (available: none)');
  });

  test('passes async provisioner solver tip and max price age overrides', async () => {
    const client = aeraV2WalletClient(publicClientWithV2Reads());

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
    const client = aeraV2WalletClient(
      publicClientWithV2Reads({
        asyncDepositMultiplier: 9_000,
        asyncRedeemMultiplier: 8_000,
      })
    );

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

      const redeemQuote = await getSyncWithdrawQuote(client, {
        vaultId: V2_VAULT_ID,
        shares: units,
        account: account.address,
        slippageBps: 100,
      });
      expect(redeemQuote.kind).toBe('redeem');
      expect(redeemQuote.shares).toBe(units);
      expect(redeemQuote.capacity.exceedsCapacity).toBe(false);

      // No vault-unit approval needed for sync redeem — units are burned directly
      const redeemSteps = await getWithdrawTx(client, {
        vaultId: V2_VAULT_ID,
        shares: units,
        slippageBps: 100,
        syncWithdrawQuote: redeemQuote,
      });
      expect(redeemSteps).toHaveLength(1);
      expect(redeemSteps[0].tx.type).toBe('redeem');
      expect(redeemSteps[0].tx.args[1]).toBe(redeemQuote.shares);
      expect(redeemSteps[0].tx.args[2]).toBe(redeemQuote.minTokensOut);
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
      expect(tokensOut).toBeGreaterThanOrEqual(redeemQuote.minTokensOut);

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

      const withdrawQuote = await getSyncWithdrawQuote(client, {
        vaultId: V2_VAULT_ID,
        amount: WITHDRAW_AMOUNT,
        account: account.address,
        slippageBps: 100,
      });
      expect(withdrawQuote.kind).toBe('withdraw');
      expect(withdrawQuote.tokensOut).toBe(WITHDRAW_AMOUNT);
      expect(withdrawQuote.capacity.exceedsCapacity).toBe(false);

      // Sync withdraw by exact token needs no vault-unit approval
      const withdrawSteps = await getWithdrawTx(client, {
        vaultId: V2_VAULT_ID,
        amount: WITHDRAW_AMOUNT,
        slippageBps: 100,
        syncWithdrawQuote: withdrawQuote,
      });
      expect(withdrawSteps).toHaveLength(1);
      expect(withdrawSteps[0].tx.type).toBe('withdraw');
      expect(withdrawSteps[0].tx.args[1]).toBe(withdrawQuote.tokensOut);
      expect(withdrawSteps[0].tx.args[2]).toBe(withdrawQuote.maxUnitsIn);
      expect(withdrawSteps[0].tx.args[3]).toBe(account.address);

      const withdrawReceipt = await sendTransactionAndWait(testClient, {
        to: withdrawSteps[0].payload.to,
        data: withdrawSteps[0].payload.data,
        account: account.address,
      });

      const redeemedEvents = parseEventLogs({
        abi: provisionerV2Abi,
        eventName: 'Redeemed',
        logs: withdrawReceipt.logs,
      });
      expect(redeemedEvents).toHaveLength(1);
      expect(redeemedEvents[0].args.tokensOut).toBe(withdrawQuote.tokensOut);
      expect(redeemedEvents[0].args.unitsIn).toBeLessThanOrEqual(withdrawQuote.maxUnitsIn);

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
