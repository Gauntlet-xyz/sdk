import type { Abi, Address, Hex, PublicClient } from 'viem';
import type { TokenInfo, VaultDeployment } from '../types';

export interface EvmTxStep<TAbi extends Abi = Abi, TFunctionName extends string = string> {
  type: 'approve' | 'deposit' | 'requestDeposit' | 'redeem' | 'requestRedeem' | 'withdraw';
  address: Address;
  abi: TAbi;
  functionName: TFunctionName;
  args: readonly unknown[];
  account: Address;
  attribution?: Hex;
}

export type TxStep = EvmTxStep; // | SolanaTxStep

export interface AdapterDepositParams {
  vault: VaultDeployment;
  amount: bigint;
  receiver: Address;
  account: Address;
  async: boolean;
  /** Attribution bytes (GTLT + optional ERC-8021). Passed to adapter for future calldata embedding. */
  asset: TokenInfo;
  publicClient: PublicClient;
  /** Slippage tolerance in basis points (e.g. 100 = 1%). Defaults to 100. */
  slippageBps?: number;
}

export type AdapterWithdrawParams = {
  vault: VaultDeployment;
  receiver: Address;
  account: Address;
  async: boolean | undefined;
  asset: TokenInfo;
  publicClient: PublicClient;
  /** Slippage tolerance in basis points (e.g. 100 = 1%). Defaults to 100. */
  slippageBps?: number;
} & (
  | { shares: bigint; amount?: never; entireAmount?: never }
  | { amount: bigint; shares?: never; entireAmount?: never }
  | { entireAmount: true; shares?: never; amount?: never }
);

export interface AllowanceParams {
  publicClient: PublicClient;
  token: Address;
  owner: Address;
  spender: Address;
  amount: bigint;
}

export interface ApprovalParams {
  token: Address;
  spender: Address;
  amount: bigint;
  account: Address;
}

export interface EvmProtocolAdapter {
  buildDeposit(params: AdapterDepositParams): Promise<EvmTxStep[]>;
  buildWithdraw(params: AdapterWithdrawParams): Promise<EvmTxStep[]>;
  checkAllowance(params: AllowanceParams): Promise<{ sufficient: boolean; current: bigint }>;
  buildApproval(params: ApprovalParams): EvmTxStep;
}
