import { parseAbi, type Address } from 'viem';
import type { GauntletClient } from '../client';
import type { EvmVaultDeployment } from './types';
import { ChainMismatchError, UnsupportedProtocolError, VaultNotFoundError } from '../errors';
import { getMultiDepositorVault, resolveContractVersion } from './aeraContracts';
import * as provisionerV1 from './aeraContracts/v1';
import * as provisionerV2 from './aeraContracts/v2';
import { provisionerV2Abi } from './abis/provisionerV2';
import { ContractVersion } from './types';
import { BLOCKS_3_DAYS, CHAIN_NAMES, DEFAULT_BLOCKS_3_DAYS, LOG_PAGE_SIZE } from '../constants';

// Inline as-const ABI items give viem full type inference for args and return types.
const DEPOSIT_REQUESTED_V1_ABI = [
  {
    type: 'event',
    name: 'DepositRequested',
    inputs: [
      { type: 'address', name: 'user', indexed: true },
      { type: 'address', name: 'token', indexed: true },
      { type: 'uint256', name: 'tokensIn', indexed: false },
      { type: 'uint256', name: 'minUnitsOut', indexed: false },
      { type: 'uint256', name: 'solverTip', indexed: false },
      { type: 'uint256', name: 'deadline', indexed: false },
      { type: 'uint256', name: 'maxPriceAge', indexed: false },
      { type: 'bool', name: 'isFixedPrice', indexed: false },
      { type: 'bytes32', name: 'depositRequestHash', indexed: false },
    ],
  },
] as const;

const REDEEM_REQUESTED_V1_ABI = [
  {
    type: 'event',
    name: 'RedeemRequested',
    inputs: [
      { type: 'address', name: 'user', indexed: true },
      { type: 'address', name: 'token', indexed: true },
      { type: 'uint256', name: 'minTokensOut', indexed: false },
      { type: 'uint256', name: 'unitsIn', indexed: false },
      { type: 'uint256', name: 'solverTip', indexed: false },
      { type: 'uint256', name: 'deadline', indexed: false },
      { type: 'uint256', name: 'maxPriceAge', indexed: false },
      { type: 'bool', name: 'isFixedPrice', indexed: false },
      { type: 'bytes32', name: 'redeemRequestHash', indexed: false },
    ],
  },
] as const;

const provisionerV1StateAbi = parseAbi([
  'function asyncDepositHashes(bytes32 asyncDepositHash) view returns (bool exists)',
  'function asyncRedeemHashes(bytes32 asyncRedeemHash) view returns (bool exists)',
]);

export interface UserCurrentBalanceParams {
  vaultId: string;
  address: Address;
  chainId?: number;
}

export interface UserCurrentBalance {
  /** Chain identifier, e.g. "base" */
  chain: string;
  token: Address;
  decimals: number;
  /** Assets queued via async deposit, not yet earning */
  pendingDeposit: bigint;
  /** Assets actively earning in the vault */
  balance: bigint;
  /** Assets queued via async withdraw, not yet claimable */
  pendingWithdraw: bigint;
}

// V2 legacy wrapper calls can emit both receiver-aware and legacy events for one request.
// Keep one row per request hash before state checks and summing pending amounts.
function dedupeByRequestHash<TLog extends { args: { [key: string]: unknown } }>(
  logs: TLog[],
  hashKey: 'depositRequestHash' | 'redeemRequestHash'
): TLog[] {
  const seen = new Set<unknown>();

  return logs.filter((log) => {
    const hash = log.args[hashKey];
    // Drop malformed events and duplicates so one pending request cannot be counted twice.
    if (hash == null || seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

async function queryDeploymentBalance(
  client: GauntletClient,
  deployment: EvmVaultDeployment,
  address: Address
): Promise<UserCurrentBalance> {
  const publicClient = client.getPublicClient(deployment.chainId);
  const token = deployment.supplyToken[0];
  const provisionerAddress = deployment.provisionerAddress!;
  const isV2 = (await resolveContractVersion(publicClient, deployment)) === ContractVersion.V2;

  const vaultContract = getMultiDepositorVault(publicClient, deployment.vaultAddress);
  const [units, feeCalculatorAddress] = await Promise.all([
    vaultContract.read.balanceOf([address]),
    vaultContract.read.feeCalculator(),
  ]);

  const feeCalc = isV2
    ? provisionerV2.getPriceAndFeeCalculator(publicClient, feeCalculatorAddress)
    : provisionerV1.getPriceAndFeeCalculator(publicClient, feeCalculatorAddress);
  const balance = await feeCalc.read.convertUnitsToToken([
    deployment.vaultAddress,
    token.address,
    units,
  ]);

  // Look back ~3 days for pending async requests
  const currentBlock = await publicClient.getBlockNumber();
  const lookback = BLOCKS_3_DAYS[deployment.chainId] ?? DEFAULT_BLOCKS_3_DAYS;
  const fromBlock = currentBlock > lookback ? currentBlock - lookback : 0n;

  // Compute block-range chunks to stay within the 10,000-block RPC limit, then fetch in parallel
  const chunks: [bigint, bigint][] = [];
  for (let cursor = fromBlock; cursor <= currentBlock; cursor += LOG_PAGE_SIZE + 1n) {
    const end = cursor + LOG_PAGE_SIZE <= currentBlock ? cursor + LOG_PAGE_SIZE : currentBlock;
    chunks.push([cursor, end]);
  }

  const [depositPages, redeemPages] = await Promise.all([
    Promise.all(
      chunks.map(([from, to]) =>
        isV2
          ? publicClient.getContractEvents({
              address: provisionerAddress,
              abi: provisionerV2Abi,
              eventName: 'DepositRequested',
              args: { receiver: address },
              fromBlock: from,
              toBlock: to,
            })
          : publicClient.getContractEvents({
              address: provisionerAddress,
              abi: DEPOSIT_REQUESTED_V1_ABI,
              eventName: 'DepositRequested',
              args: { user: address },
              fromBlock: from,
              toBlock: to,
            })
      )
    ),
    Promise.all(
      chunks.map(([from, to]) =>
        isV2
          ? publicClient.getContractEvents({
              address: provisionerAddress,
              abi: provisionerV2Abi,
              eventName: 'RedeemRequested',
              args: { user: address },
              fromBlock: from,
              toBlock: to,
            })
          : publicClient.getContractEvents({
              address: provisionerAddress,
              abi: REDEEM_REQUESTED_V1_ABI,
              eventName: 'RedeemRequested',
              args: { user: address },
              fromBlock: from,
              toBlock: to,
            })
      )
    ),
  ]);

  const depositLogs = dedupeByRequestHash(depositPages.flat(), 'depositRequestHash');
  const redeemLogs = dedupeByRequestHash(redeemPages.flat(), 'redeemRequestHash');

  // Check which requests are still pending on-chain via a single multicall
  const pendingChecks = await publicClient.multicall({
    contracts: [
      ...depositLogs.map((log) => ({
        address: provisionerAddress,
        abi: isV2 ? provisionerV2Abi : provisionerV1StateAbi,
        functionName: isV2 ? ('asyncRequestHashes' as const) : ('asyncDepositHashes' as const),
        args: [log.args.depositRequestHash!] as const,
      })),
      ...redeemLogs.map((log) => ({
        address: provisionerAddress,
        abi: isV2 ? provisionerV2Abi : provisionerV1StateAbi,
        functionName: isV2 ? ('asyncRequestHashes' as const) : ('asyncRedeemHashes' as const),
        args: [log.args.redeemRequestHash!] as const,
      })),
    ],
    allowFailure: false,
  });

  const depositChecks = pendingChecks.slice(0, depositLogs.length);
  const redeemChecks = pendingChecks.slice(depositLogs.length);

  let pendingDeposit = 0n;
  for (let i = 0; i < depositLogs.length; i++) {
    if (depositChecks[i]) {
      pendingDeposit += depositLogs[i].args.tokensIn ?? 0n;
    }
  }

  let pendingWithdrawUnits = 0n;
  for (let i = 0; i < redeemLogs.length; i++) {
    if (redeemChecks[i]) {
      pendingWithdrawUnits += redeemLogs[i].args.unitsIn ?? 0n;
    }
  }

  const pendingWithdraw =
    pendingWithdrawUnits > 0n
      ? await feeCalc.read.convertUnitsToToken([
          deployment.vaultAddress,
          token.address,
          pendingWithdrawUnits,
        ])
      : 0n;

  return {
    chain: CHAIN_NAMES[deployment.chainId] ?? `chain-${deployment.chainId}`,
    token: token.address,
    decimals: token.decimals,
    pendingDeposit,
    balance,
    pendingWithdraw,
  };
}

/**
 * Returns the current balance breakdown for a user across all EVM deployments of a vault.
 *
 * Queries the vault's on-chain state to split the user's position into three buckets:
 * - `balance` — assets actively earning inside the vault (converted from vault units to tokens).
 * - `pendingDeposit` — tokens submitted via async deposit but not yet processed by a solver.
 * - `pendingWithdraw` — vault units locked in a pending async redeem request (converted to tokens).
 *
 * Only supported for Aera multi-depositor vaults. Pending amounts are detected by scanning
 * the last ~3 days of provisioner events and cross-checking hash existence on-chain.
 *
 * @param client - A configured `GauntletClient` instance with an EVM public client for each
 *   chain the vault is deployed on.
 * @param params - Query parameters including `vaultId`, the user `address`, and an optional
 *   `chainId` to limit the query to a single deployment.
 * @returns One `UserCurrentBalance` entry per chain queried.
 *
 * @throws {VaultNotFoundError} If the vault ID is not found in the manifest.
 * @throws {UnsupportedProtocolError} If the vault is not an Aera multi-depositor vault.
 * @throws {ChainMismatchError} If `chainId` is specified but no deployment exists for that chain.
 *
 * @example
 * ```ts
 * const balances = await getUserCurrentBalance(client, {
 *   vaultId: 'baseUsdcPrime',
 *   address: '0xYourWalletAddress',
 * });
 * // [{ chain: 'base', token: '0x...', decimals: 6, balance: 100_000_000n, pendingDeposit: 0n, pendingWithdraw: 0n }]
 * ```
 */
export async function getUserCurrentBalance(
  client: GauntletClient,
  params: UserCurrentBalanceParams
): Promise<UserCurrentBalance[]> {
  const manifest = await client.manifest;
  const vaultInfo = manifest.vaults.find((v) => v.vaultId === params.vaultId);
  if (!vaultInfo) throw new VaultNotFoundError(params.vaultId);

  const evmDeployments = vaultInfo.deployments.filter(
    (d): d is EvmVaultDeployment => d.chain === 'evm' && d.provisionerAddress !== undefined
  );

  if (vaultInfo.protocol !== 'aera' || evmDeployments.length === 0) {
    throw new UnsupportedProtocolError(vaultInfo.protocol);
  }

  if (params.chainId !== undefined) {
    const deployment = evmDeployments.find((d) => d.chainId === params.chainId);
    if (!deployment) {
      throw new ChainMismatchError(
        `${params.chainId}`,
        evmDeployments.map((d) => `${d.chainId}`).join(', ')
      );
    }
    return [await queryDeploymentBalance(client, deployment, params.address)];
  }

  return Promise.all(evmDeployments.map((d) => queryDeploymentBalance(client, d, params.address)));
}
