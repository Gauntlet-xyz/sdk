import type {
  EvmProtocolAdapter,
  EvmTxStep,
  AdapterDepositParams,
  AdapterWithdrawParams,
  AllowanceParams,
  ApprovalParams,
} from './types';
import { erc20Abi } from '../abis/erc20';
import { erc4626Abi } from '../abis/erc4626';
import { InvalidWithdrawParamsError } from '../../errors';

export const morphoAdapter: EvmProtocolAdapter = {
  async buildDeposit(params: AdapterDepositParams): Promise<EvmTxStep[]> {
    const { vault, amount, receiver, account } = params;

    return [
      {
        type: 'deposit',
        address: vault.vaultAddress,
        abi: erc4626Abi,
        functionName: 'deposit',
        args: [amount, receiver],
        account,
      },
    ];
  },

  async buildWithdraw(params: AdapterWithdrawParams): Promise<EvmTxStep[]> {
    const { vault, receiver, account, publicClient } = params;

    let shares: bigint;

    if ('entireAmount' in params && params.entireAmount) {
      shares = await publicClient.readContract({
        address: vault.vaultAddress,
        abi: erc4626Abi,
        functionName: 'balanceOf',
        args: [account],
      });
    } else if ('amount' in params && params.amount != null) {
      return [
        {
          type: 'withdraw',
          address: vault.vaultAddress,
          abi: erc4626Abi,
          functionName: 'withdraw',
          args: [params.amount, receiver, account],
          account,
        },
      ];
    } else if ('shares' in params && params.shares != null) {
      shares = params.shares;
    } else {
      throw new InvalidWithdrawParamsError();
    }

    return [
      {
        type: 'redeem',
        address: vault.vaultAddress,
        abi: erc4626Abi,
        functionName: 'redeem',
        args: [shares, receiver, account],
        account,
      },
    ];
  },

  async checkAllowance(params: AllowanceParams) {
    const { publicClient, token, owner, spender, amount } = params;
    const current = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    });

    return { sufficient: current >= amount, current };
  },

  buildApproval(params: ApprovalParams): EvmTxStep {
    return {
      type: 'approve',
      address: params.token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [params.spender, params.amount],
      account: params.account,
    };
  },
};
