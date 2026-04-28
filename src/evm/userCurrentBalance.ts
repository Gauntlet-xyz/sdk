import { parseAbi, type Address } from 'viem';
import type { GauntletClient } from '../client';
import type { EvmVaultDeployment } from './types';
import { ChainMismatchError, UnsupportedProtocolError, VaultNotFoundError } from '../errors';
import { getMultiDepositorVault, getPriceAndFeeCalculator } from './aeraContracts';

// Inline as-const ABI items give viem full type inference for args and return types.
const DEPOSIT_REQUESTED_ABI = [
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

const REDEEM_REQUESTED_ABI = [
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

// ABI for provisioner state queries
const provisionerStateAbi = parseAbi([
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

const CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
};

// Approximate 3-day block lookback per chain based on avg block time
const BLOCKS_3_DAYS: Record<number, bigint> = {
  1: 21_600n,
  8453: 129_600n,
  42161: 1_036_800n,
  10: 129_600n,
};
const DEFAULT_BLOCKS_3_DAYS = 129_600n;

// Many RPC providers cap eth_getLogs to 10,000 blocks per request.
const LOG_PAGE_SIZE = 9_999n;

async function queryDeploymentBalance(
  client: GauntletClient,
  deployment: EvmVaultDeployment,
  address: Address
): Promise<UserCurrentBalance> {
  const publicClient = client.getPublicClient(deployment.chainId);
  const token = deployment.supplyToken[0];
  const provisionerAddress = deployment.provisionerAddress!;

  const vaultContract = getMultiDepositorVault(publicClient, deployment.vaultAddress);
  const [units, feeCalculatorAddress] = await Promise.all([
    vaultContract.read.balanceOf([address]),
    vaultContract.read.feeCalculator(),
  ]);

  const feeCalc = getPriceAndFeeCalculator(publicClient, feeCalculatorAddress);
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
        publicClient.getContractEvents({
          address: provisionerAddress,
          abi: DEPOSIT_REQUESTED_ABI,
          eventName: 'DepositRequested',
          args: { user: address },
          fromBlock: from,
          toBlock: to,
        })
      )
    ),
    Promise.all(
      chunks.map(([from, to]) =>
        publicClient.getContractEvents({
          address: provisionerAddress,
          abi: REDEEM_REQUESTED_ABI,
          eventName: 'RedeemRequested',
          args: { user: address },
          fromBlock: from,
          toBlock: to,
        })
      )
    ),
  ]);

  const depositLogs = depositPages.flat().filter((log) => log.args.depositRequestHash != null);
  const redeemLogs = redeemPages.flat().filter((log) => log.args.redeemRequestHash != null);

  // Check which requests are still pending on-chain via a single multicall
  const pendingChecks = await publicClient.multicall({
    contracts: [
      ...depositLogs.map((log) => ({
        address: provisionerAddress,
        abi: provisionerStateAbi,
        functionName: 'asyncDepositHashes' as const,
        args: [log.args.depositRequestHash!] as const,
      })),
      ...redeemLogs.map((log) => ({
        address: provisionerAddress,
        abi: provisionerStateAbi,
        functionName: 'asyncRedeemHashes' as const,
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
