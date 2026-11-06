import { parseAbi, type Address } from 'viem';
import type { GauntletClient } from '../client';
import type { EvmVaultDeployment } from './types';
import {
  ChainMismatchError,
  GauntletSDKError,
  UnsupportedAssetError,
  UnsupportedProtocolError,
  VaultNotFoundError,
} from '../errors';
import { getMultiDepositorVault, resolveAeraRuntimeContracts } from './aeraContracts';
import { convertUnitsToToken } from './aeraContracts/priceAndFeeCalculator';
import { getUserUnitsRefundableUntil } from './aeraContracts/v2';
import { provisionerV2Abi } from './abis/provisionerV2';
import { ContractVersion } from './types';
import {
  BLOCKS_3_DAYS,
  CHAIN_NAMES,
  DAY,
  DEFAULT_BLOCKS_3_DAYS,
  LOG_PAGE_SIZE,
} from '../constants';

// Log chunks fetched at once per event type.
const LOG_CHUNK_CONCURRENCY = 16;

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
  /** Required for deployments that support multiple assets, ignored otherwise. */
  assetSymbol?: string;
  /**
   * Scan from this block, including expired requests that still hold escrow.
   * Requires `chainId` for a vault with more than one deployment.
   */
  fromBlock?: bigint;
}

export interface UserCurrentBalance {
  /** Block used for balances, conversions, and request state. */
  blockNumber: bigint;
  /** First block included in the request scan. Older escrow is outside this result. */
  fromBlock: bigint;
  /** Chain identifier, e.g. "base" */
  chain: string;
  /** EVM chain id of the deployment, e.g. 8453 */
  chainId: number;
  token: Address;
  decimals: number;
  /** Assets queued via async deposit, not yet earning */
  pendingDeposit: bigint;
  /** Assets actively earning in the vault */
  balance: bigint;
  /** Assets queued via async withdraw, not yet claimable */
  pendingWithdraw: bigint;
  /** Timestamp until which this account cannot redeem vault units. */
  unitsLockedUntil?: bigint;
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

/** Step back by the expected block count, and widen until the block predates the cutoff. */
async function requestScanStart(
  publicClient: ReturnType<GauntletClient['getPublicClient']>,
  chainId: number,
  blockNumber: bigint,
  days: number,
  cutoff: bigint
): Promise<bigint> {
  let span = ((BLOCKS_3_DAYS[chainId] ?? DEFAULT_BLOCKS_3_DAYS) * BigInt(days)) / 3n;
  for (;;) {
    if (span >= blockNumber) return 0n;
    const start = blockNumber - span;
    const block = await publicClient.getBlock({ blockNumber: start });
    if (block.timestamp <= cutoff) return start;
    span *= 2n;
  }
}

async function mapInBatches<T, P extends Promise<unknown>>(
  items: T[],
  size: number,
  fn: (item: T) => P
): Promise<Awaited<P>[]> {
  const results: Awaited<P>[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return results;
}

async function queryDeploymentBalance(
  client: GauntletClient,
  deployment: EvmVaultDeployment,
  params: UserCurrentBalanceParams
): Promise<UserCurrentBalance> {
  const publicClient = client.getPublicClient(deployment.chainId);
  const { address } = params;
  const token =
    deployment.supplyToken.length > 1
      ? deployment.supplyToken.find((candidate) => candidate.symbol === params.assetSymbol)
      : deployment.supplyToken[0];
  if (token === undefined)
    throw new UnsupportedAssetError(params.assetSymbol ?? 'unknown', params.vaultId);
  const snapshot = await publicClient.getBlock({ blockTag: 'latest' });
  if (snapshot.number === null) {
    throw new GauntletSDKError('The balance snapshot has no block number');
  }
  const blockNumber = snapshot.number;
  const readOptions = { blockNumber };
  const expirationDays = deployment.expirationDays ?? 3;
  if (!Number.isSafeInteger(expirationDays) || expirationDays <= 0) {
    throw new GauntletSDKError('The request expiration must be a positive integer number of days');
  }
  const scanDays = Math.max(3, expirationDays);
  const cutoff = snapshot.timestamp - BigInt(DAY) * BigInt(scanDays);
  const fromBlock =
    params.fromBlock ??
    (await requestScanStart(publicClient, deployment.chainId, blockNumber, scanDays, cutoff));
  if (fromBlock < 0n || fromBlock > blockNumber) {
    throw new GauntletSDKError('The request scan range is invalid');
  }

  const vaultContract = getMultiDepositorVault(publicClient, deployment.vaultAddress);
  const [runtime, units] = await Promise.all([
    resolveAeraRuntimeContracts(publicClient, deployment, readOptions),
    vaultContract.read.balanceOf([address], readOptions),
  ]);
  const provisionerAddress = runtime.provisioner.address;
  const isV2 = runtime.provisioner.version === ContractVersion.V2;
  const unitsLockedUntilPromise = isV2
    ? getUserUnitsRefundableUntil(publicClient, provisionerAddress, address, readOptions)
    : Promise.resolve(undefined);

  const balance = await convertUnitsToToken(
    publicClient,
    runtime.feeCalculator.address,
    runtime.feeCalculator.version,
    deployment.vaultAddress,
    token.address,
    units,
    readOptions
  );

  // Compute block-range chunks to stay within the 10,000-block RPC limit, then fetch in bounded batches
  const chunks: [bigint, bigint][] = [];
  for (let cursor = fromBlock; cursor <= blockNumber; cursor += LOG_PAGE_SIZE + 1n) {
    const end = cursor + LOG_PAGE_SIZE <= blockNumber ? cursor + LOG_PAGE_SIZE : blockNumber;
    chunks.push([cursor, end]);
  }

  // Each map keeps LOG_CHUNK_CONCURRENCY queries in flight.
  const [depositPages, redeemPages] = await Promise.all([
    mapInBatches(chunks, LOG_CHUNK_CONCURRENCY, ([from, to]) =>
      isV2
        ? publicClient.getContractEvents({
            address: provisionerAddress,
            abi: provisionerV2Abi,
            eventName: 'DepositRequested',
            args: { receiver: address, token: token.address },
            fromBlock: from,
            toBlock: to,
          })
        : publicClient.getContractEvents({
            address: provisionerAddress,
            abi: DEPOSIT_REQUESTED_V1_ABI,
            eventName: 'DepositRequested',
            args: { user: address, token: token.address },
            fromBlock: from,
            toBlock: to,
          })
    ),
    mapInBatches(chunks, LOG_CHUNK_CONCURRENCY, ([from, to]) =>
      isV2
        ? publicClient.getContractEvents({
            address: provisionerAddress,
            abi: provisionerV2Abi,
            eventName: 'RedeemRequested',
            args: { user: address, token: token.address },
            fromBlock: from,
            toBlock: to,
          })
        : publicClient.getContractEvents({
            address: provisionerAddress,
            abi: REDEEM_REQUESTED_V1_ABI,
            eventName: 'RedeemRequested',
            args: { user: address, token: token.address },
            fromBlock: from,
            toBlock: to,
          })
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
    blockNumber,
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
      ? await convertUnitsToToken(
          publicClient,
          runtime.feeCalculator.address,
          runtime.feeCalculator.version,
          deployment.vaultAddress,
          token.address,
          pendingWithdrawUnits,
          readOptions
        )
      : 0n;
  const unitsLockedUntil = await unitsLockedUntilPromise;

  return {
    blockNumber,
    fromBlock,
    chain: CHAIN_NAMES[deployment.chainId] ?? `chain-${deployment.chainId}`,
    chainId: deployment.chainId,
    token: token.address,
    decimals: token.decimals,
    pendingDeposit,
    balance,
    pendingWithdraw,
    ...(unitsLockedUntil !== undefined ? { unitsLockedUntil } : {}),
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
 * the configured request lifetime, with a minimum of three days. Set `fromBlock` (with `chainId`
 * on a multi-chain vault) for older escrow.
 * All state reads use one block. The returned range identifies the scanned history.
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
 * @throws {UnsupportedAssetError} If a multi-asset deployment gets no matching `assetSymbol`.
 *
 * @example
 * ```ts
 * const balances = await getUserCurrentBalance(client, {
 *   vaultId: 'baseUsdcPrime',
 *   address: '0xYourWalletAddress',
 * });
 * // [{ chain: 'base', chainId: 8453, token: '0x...', decimals: 6, balance: 100_000_000n, pendingDeposit: 0n, pendingWithdraw: 0n }]
 * ```
 */
export async function getUserCurrentBalance(
  client: GauntletClient,
  params: UserCurrentBalanceParams
): Promise<UserCurrentBalance[]> {
  params = { ...params };
  const manifest = await client.manifest;
  const vaultInfo = manifest.vaults.find((v) => v.vaultId === params.vaultId);
  if (!vaultInfo) throw new VaultNotFoundError(params.vaultId);

  const evmDeployments = vaultInfo.deployments.filter(
    (d): d is EvmVaultDeployment => d.chain === 'evm' && d.vaultType === 'multi-depositor'
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
    return [await queryDeploymentBalance(client, deployment, params)];
  }
  if (params.fromBlock !== undefined && evmDeployments.length > 1) {
    throw new GauntletSDKError('fromBlock requires chainId for a vault with several deployments');
  }

  return Promise.all(evmDeployments.map((d) => queryDeploymentBalance(client, d, params)));
}
