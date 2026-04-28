import { erc20Abi } from '../abis/erc20';
import {
  requestDepositTxRequest,
  requestRedeemTxRequest,
  getMultiDepositorVault,
  getPriceAndFeeCalculator,
} from '../aeraContracts';
import {
  InvalidWithdrawParamsError,
  UnimplementedFeatureError,
  UnitConversionError,
  UnsupportedFeatureError,
} from '../../errors';
import type {
  EvmProtocolAdapter,
  EvmTxStep,
  AdapterDepositParams,
  AdapterWithdrawParams,
  AllowanceParams,
  ApprovalParams,
} from './types';
import { PublicClient, type Address } from 'viem';
import { multiDepositorVaultAbi } from '../abis/multiDepositorVault';

const SECOND = 1;
const MINUTE = SECOND * 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;

export const getAeraV3VaultUnits = async (
  publicClient: PublicClient,
  tokenUnits: bigint,
  vaultAddress: Address,
  tokenAddress: Address
) => {
  const vaultContract = getMultiDepositorVault(publicClient, vaultAddress);

  if (vaultContract === undefined) return;

  const calculatorAddress = await vaultContract.read.feeCalculator();

  if (!calculatorAddress) return;

  const calculatorContract = getPriceAndFeeCalculator(publicClient, calculatorAddress);

  const vaultUnits = await calculatorContract.read.convertTokenToUnits([
    vaultAddress,
    tokenAddress,
    tokenUnits,
  ]);

  return vaultUnits;
};

export const getAeraV3TokenUnits = async (
  publicClient: PublicClient,
  vaultUnits: bigint,
  vaultAddress: Address,
  tokenAddress: Address
) => {
  const vaultContract = getMultiDepositorVault(publicClient, vaultAddress);
  if (vaultContract === undefined) return;

  const calculatorAddress = await vaultContract.read.feeCalculator();
  if (!calculatorAddress) return;

  const calculatorContract = getPriceAndFeeCalculator(publicClient, calculatorAddress);

  return calculatorContract.read.convertUnitsToToken([vaultAddress, tokenAddress, vaultUnits]);
};

export const aeraAdapter: EvmProtocolAdapter = {
  async buildDeposit(params: AdapterDepositParams): Promise<EvmTxStep[]> {
    const { vault, receiver, amount, account, publicClient, asset, async: isAsync, slippageBps = 100 } = params;

    if (receiver !== account) {
      throw new UnsupportedFeatureError('Aera: separate receiver address');
    }

    if (!vault.provisionerAddress) {
      // Not implemented because untested and clients won't need in V1
      throw new UnimplementedFeatureError('Aera: single depositor vaults');
      // single-depositor vault
      /*return [
        {
          type: 'deposit',
          // SDK only supports single asset deposit
          ...depositTxRequest(vault.vaultAddress, [{ asset: asset.address, amount }], account),
        },
      ];*/
    }

    if (isAsync) {
      const vaultUnits = await getAeraV3VaultUnits(
        publicClient,
        amount,
        vault.vaultAddress,
        asset.address
      );

      if (vaultUnits === undefined) {
        throw new UnitConversionError(vault.vaultAddress);
      }

      const deadline = BigInt(Math.ceil(new Date().getTime() / 1000) + DAY * 3);
      // Request deposit
      return [
        {
          type: 'requestDeposit',
          ...requestDepositTxRequest(
            vault.provisionerAddress,
            asset.address,
            amount,
            (vaultUnits * BigInt(10000 - slippageBps)) / 10000n, // minUnitsOut
            0n, // solvertip
            deadline,
            BigInt(DAY * 10),
            false,
            account
          ),
        },
      ];
    }

    throw new UnimplementedFeatureError('Aera Sync Operations');
  },

  async buildWithdraw(params: AdapterWithdrawParams): Promise<EvmTxStep[]> {
    const { vault, receiver, account, asset, publicClient, async: isAsync, slippageBps = 100 } = params;

    if (receiver !== account) {
      throw new UnsupportedFeatureError('Aera: separate receiver address');
    }

    let shares: bigint;
    let amount: bigint | undefined;

    if ('entireAmount' in params && params.entireAmount) {
      shares = await publicClient.readContract({
        address: vault.vaultAddress,
        abi: multiDepositorVaultAbi,
        functionName: 'balanceOf',
        args: [account],
      });
      amount = await getAeraV3TokenUnits(publicClient, shares, vault.vaultAddress, asset.address);
    } else if ('amount' in params && params.amount != null) {
      const tempShares = await getAeraV3VaultUnits(
        publicClient,
        params.amount,
        vault.vaultAddress,
        asset.address
      );
      amount = params.amount;
      if (tempShares === undefined) {
        throw new UnitConversionError(vault.vaultAddress);
      }
      shares = tempShares;
    } else if ('shares' in params && params.shares != null) {
      shares = params.shares;
      amount = await getAeraV3TokenUnits(publicClient, shares, vault.vaultAddress, asset.address);
    } else {
      throw new InvalidWithdrawParamsError();
    }

    if (!vault.provisionerAddress) {
      // Not implemented because untested and clients won't need in V1
      throw new UnimplementedFeatureError('Aera: single depositor vaults');
      //single-depositer vault
      // TODO shares or amount ??
      /*return [
        {
          type: 'withdraw',
          // SDK only supports single asset deposit
          ...withdrawTxRequest(
            vault.vaultAddress,
            [{ asset: asset.address, amount: shares }],
            account
          ),
        },
      ];*/
    }

    const { sufficient } = await this.checkAllowance({
      publicClient,
      token: vault.vaultAddress,
      owner: account,
      spender: vault.provisionerAddress,
      amount: shares,
    });

    const steps: EvmTxStep[] = [];

    if (!sufficient) {
      steps.push(
        this.buildApproval({
          token: vault.vaultAddress,
          spender: vault.provisionerAddress,
          amount: shares,
          account,
        })
      );
    }

    if (isAsync) {
      // Request redeem
      const deadline = BigInt(Math.ceil(new Date().getTime() / 1000) + DAY * 3);
      if (amount === undefined) {
        throw new UnitConversionError(vault.vaultAddress);
      }
      return [
        ...steps,
        {
          type: 'requestRedeem',
          ...requestRedeemTxRequest(
            vault.provisionerAddress,
            asset.address,
            shares,
            (amount * BigInt(10000 - slippageBps)) / 10000n, // minUnitsOut
            0n, // solvertip
            deadline,
            BigInt(DAY * 10),
            false,
            account
          ),
        },
      ];
    }

    throw new UnimplementedFeatureError('Aera Sync Operations');
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
