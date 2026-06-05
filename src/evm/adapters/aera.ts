import { erc20Abi } from '../abis/erc20';
import {
  getMultiDepositorVault,
  applySlippageDown,
  applySlippageUp,
  resolveContractVersion,
} from '../aeraContracts';
import * as provisionerV1 from '../aeraContracts/v1';
import * as provisionerV2 from '../aeraContracts/v2';
import {
  InvalidWithdrawParamsError,
  InvalidSolverTipError,
  UnimplementedFeatureError,
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
import type { Address, PublicClient } from 'viem';
import { multiDepositorVaultAbi } from '../abis/multiDepositorVault';
import {
  DEFAULT_BPS,
  DAY,
  DEFAULT_MAX_PRICE_AGE,
  DEFAULT_REQUEST_DEADLINE_BUFFER,
  DEFAULT_SOLVER_TIP,
} from '../../constants';
import { ContractVersion } from '../types';

export const convertTokenAmountToUnits = async (
  publicClient: PublicClient,
  tokenAmount: bigint,
  vaultAddress: Address,
  tokenAddress: Address,
  contractVersion: ContractVersion = ContractVersion.V1
) => {
  const vaultContract = getMultiDepositorVault(publicClient, vaultAddress);
  if (vaultContract === undefined) return;

  const calculatorAddress = await vaultContract.read.feeCalculator();
  if (!calculatorAddress) return;

  const calculatorContract =
    contractVersion === ContractVersion.V2
      ? provisionerV2.getPriceAndFeeCalculator(publicClient, calculatorAddress)
      : provisionerV1.getPriceAndFeeCalculator(publicClient, calculatorAddress);

  const unitsAmount = await calculatorContract.read.convertTokenToUnits([
    vaultAddress,
    tokenAddress,
    tokenAmount,
  ]);

  return unitsAmount;
};

export const convertUnitsToTokenAmount = async (
  publicClient: PublicClient,
  unitsAmount: bigint,
  vaultAddress: Address,
  tokenAddress: Address,
  contractVersion: ContractVersion = ContractVersion.V1
) => {
  const vaultContract = getMultiDepositorVault(publicClient, vaultAddress);
  if (vaultContract === undefined) return;

  const calculatorAddress = await vaultContract.read.feeCalculator();
  if (!calculatorAddress) return;

  const calculatorContract =
    contractVersion === ContractVersion.V2
      ? provisionerV2.getPriceAndFeeCalculator(publicClient, calculatorAddress)
      : provisionerV1.getPriceAndFeeCalculator(publicClient, calculatorAddress);

  return calculatorContract.read.convertUnitsToToken([vaultAddress, tokenAddress, unitsAmount]);
};

function subtractSolverTip(tokenAmount: bigint, solverTip: bigint): bigint {
  if (solverTip === 0n) return tokenAmount;
  if (solverTip >= tokenAmount) {
    throw new InvalidSolverTipError(solverTip, tokenAmount);
  }

  return tokenAmount - solverTip;
}

function getRequestDeadline(expirationDays?: number): bigint {
  const deadlineBuffer =
    expirationDays === undefined ? DEFAULT_REQUEST_DEADLINE_BUFFER : DAY * expirationDays;
  return BigInt(Math.ceil(new Date().getTime() / 1000) + deadlineBuffer);
}

async function getDepositUnitsOut({
  publicClient,
  contractVersion,
  provisioner,
  vault,
  token,
  tokensIn,
  isAsync,
}: {
  publicClient: PublicClient;
  contractVersion: ContractVersion;
  provisioner: Address;
  vault: Address;
  token: Address;
  tokensIn: bigint;
  isAsync: boolean;
}): Promise<bigint> {
  if (contractVersion === ContractVersion.V2) {
    return isAsync
      ? provisionerV2.getAsyncDepositUnitsOut(publicClient, provisioner, vault, token, tokensIn)
      : provisionerV2.getSyncDepositUnitsOut(publicClient, provisioner, vault, token, tokensIn);
  }

  return provisionerV1.getAsyncDepositUnitsOut(publicClient, provisioner, vault, token, tokensIn);
}

function getAsyncRedeemTokenOut(
  publicClient: PublicClient,
  contractVersion: ContractVersion,
  provisioner: Address,
  vault: Address,
  token: Address,
  unitsIn: bigint
): Promise<bigint> {
  return contractVersion === ContractVersion.V2
    ? provisionerV2.getAsyncRedeemTokenOut(publicClient, provisioner, vault, token, unitsIn)
    : provisionerV1.getAsyncRedeemTokenOut(publicClient, provisioner, vault, token, unitsIn);
}

function getAsyncWithdrawUnitsIn(
  publicClient: PublicClient,
  contractVersion: ContractVersion,
  provisioner: Address,
  vault: Address,
  token: Address,
  tokensOut: bigint
): Promise<bigint> {
  return contractVersion === ContractVersion.V2
    ? provisionerV2.getAsyncWithdrawUnitsIn(publicClient, provisioner, vault, token, tokensOut)
    : provisionerV1.getAsyncWithdrawUnitsIn(publicClient, provisioner, vault, token, tokensOut);
}

export const aeraAdapter: EvmProtocolAdapter = {
  async buildDeposit(params: AdapterDepositParams): Promise<EvmTxStep[]> {
    const {
      vault,
      receiver,
      amount,
      account,
      publicClient,
      asset,
      async: isAsync,
      slippageBps = DEFAULT_BPS,
      solverTip = DEFAULT_SOLVER_TIP,
      maxPriceAge = DEFAULT_MAX_PRICE_AGE,
    } = params;

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

    const contractVersion = await resolveContractVersion(publicClient, vault);
    const isContractV2 = contractVersion === ContractVersion.V2;
    if (receiver !== account && !isContractV2) {
      throw new UnsupportedFeatureError('Aera: separate receiver address on V1');
    }

    if (!isAsync && !isContractV2) {
      throw new UnsupportedFeatureError('Aera: sync operations on V1');
    }

    const tokensInForUnits = isAsync ? subtractSolverTip(amount, solverTip) : amount;
    const vaultUnits = await getDepositUnitsOut({
      publicClient,
      contractVersion,
      provisioner: vault.provisionerAddress,
      vault: vault.vaultAddress,
      token: asset.address,
      tokensIn: tokensInForUnits,
      isAsync,
    });

    const minUnitsOut = applySlippageDown(vaultUnits, slippageBps);

    if (isAsync) {
      const deadline = getRequestDeadline(vault.expirationDays);
      return [
        {
          type: 'requestDeposit',
          ...(isContractV2
            ? provisionerV2.requestDepositTxRequest(
                vault.provisionerAddress,
                asset.address,
                amount,
                minUnitsOut,
                solverTip,
                deadline,
                maxPriceAge,
                false,
                receiver,
                account
              )
            : provisionerV1.requestDepositTxRequest(
                vault.provisionerAddress,
                asset.address,
                amount,
                minUnitsOut,
                solverTip,
                deadline,
                maxPriceAge,
                false,
                account
              )),
        },
      ];
    }

    if (isContractV2) {
      return [
        {
          type: 'deposit',
          ...provisionerV2.depositTxRequest(
            vault.provisionerAddress,
            asset.address,
            amount,
            minUnitsOut,
            receiver,
            account
          ),
        },
      ];
    }

    throw new UnimplementedFeatureError('Aera Sync Operations');
  },

  async buildWithdraw(params: AdapterWithdrawParams): Promise<EvmTxStep[]> {
    const {
      vault,
      receiver,
      account,
      asset,
      publicClient,
      async: isAsync,
      slippageBps = DEFAULT_BPS,
      solverTip = DEFAULT_SOLVER_TIP,
      maxPriceAge = DEFAULT_MAX_PRICE_AGE,
    } = params;

    const contractVersion = vault.provisionerAddress
      ? await resolveContractVersion(publicClient, vault)
      : ContractVersion.V1;
    const isContractV2 = contractVersion === ContractVersion.V2;
    if (receiver !== account && !isContractV2) {
      throw new UnsupportedFeatureError('Aera: separate receiver address on V1');
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

    if (!isAsync && !isContractV2) {
      throw new UnsupportedFeatureError('Aera: sync operations on V1');
    }

    const isV2ExactTokenWithdraw =
      isContractV2 && !isAsync && 'amount' in params && params.amount != null;
    let minTokenOut: bigint;
    let maxUnitsIn: bigint;
    let shares: bigint | undefined;

    if (isContractV2 && !isAsync) {
      if ('entireAmount' in params && params.entireAmount) {
        shares = await publicClient.readContract({
          address: vault.vaultAddress,
          abi: multiDepositorVaultAbi,
          functionName: 'balanceOf',
          args: [account],
        });
      } else if ('shares' in params && params.shares != null) {
        shares = params.shares;
      } else if (!('amount' in params && params.amount != null)) {
        throw new InvalidWithdrawParamsError();
      }

      if (isV2ExactTokenWithdraw) {
        minTokenOut = applySlippageDown(params.amount, slippageBps);
        maxUnitsIn = applySlippageUp(
          await provisionerV2.getSyncWithdrawUnitsIn(
            publicClient,
            vault.provisionerAddress,
            vault.vaultAddress,
            asset.address,
            params.amount
          ),
          slippageBps
        );
      } else {
        if (shares === undefined) {
          throw new InvalidWithdrawParamsError();
        }

        minTokenOut = applySlippageDown(
          await provisionerV2.getSyncRedeemTokenOut(
            publicClient,
            vault.provisionerAddress,
            vault.vaultAddress,
            asset.address,
            shares
          ),
          slippageBps
        );
        maxUnitsIn = applySlippageUp(shares, slippageBps);
      }
    } else {
      if ('entireAmount' in params && params.entireAmount) {
        shares = await publicClient.readContract({
          address: vault.vaultAddress,
          abi: multiDepositorVaultAbi,
          functionName: 'balanceOf',
          args: [account],
        });
      } else if ('amount' in params && params.amount != null) {
        shares = await getAsyncWithdrawUnitsIn(
          publicClient,
          contractVersion,
          vault.provisionerAddress,
          vault.vaultAddress,
          asset.address,
          params.amount + solverTip
        );
      } else if ('shares' in params && params.shares != null) {
        shares = params.shares;
      } else {
        throw new InvalidWithdrawParamsError();
      }

      const tokenOutBeforeTip = await getAsyncRedeemTokenOut(
        publicClient,
        contractVersion,
        vault.provisionerAddress,
        vault.vaultAddress,
        asset.address,
        shares
      );
      minTokenOut = applySlippageDown(subtractSolverTip(tokenOutBeforeTip, solverTip), slippageBps);
      maxUnitsIn = shares;
    }

    const steps: EvmTxStep[] = [];

    if (isAsync) {
      if (shares === undefined) {
        throw new InvalidWithdrawParamsError();
      }

      // Only async requestRedeem needs a vault unit allowance: the provisioner
      // pulls units from the user. V2 sync redeem/withdraw exits through the
      // vault and burns the caller's units directly, so no approval is needed.
      const { sufficient } = await this.checkAllowance({
        publicClient,
        token: vault.vaultAddress,
        owner: account,
        spender: vault.provisionerAddress,
        amount: shares,
      });

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

      const deadline = getRequestDeadline(vault.expirationDays);

      return [
        ...steps,
        {
          type: 'requestRedeem',
          ...(isContractV2
            ? provisionerV2.requestRedeemTxRequest(
                vault.provisionerAddress,
                asset.address,
                shares,
                minTokenOut,
                solverTip,
                deadline,
                maxPriceAge,
                false,
                receiver,
                account
              )
            : provisionerV1.requestRedeemTxRequest(
                vault.provisionerAddress,
                asset.address,
                shares,
                minTokenOut,
                solverTip,
                deadline,
                maxPriceAge,
                false,
                account
              )),
        },
      ];
    }

    if ('amount' in params && params.amount != null) {
      return [
        ...steps,
        {
          type: 'withdraw',
          ...provisionerV2.withdrawTxRequest(
            vault.provisionerAddress,
            asset.address,
            params.amount,
            maxUnitsIn,
            receiver,
            account
          ),
        },
      ];
    }

    if (shares === undefined) {
      throw new InvalidWithdrawParamsError();
    }

    return [
      ...steps,
      {
        type: 'redeem',
        ...provisionerV2.redeemTxRequest(
          vault.provisionerAddress,
          asset.address,
          shares,
          minTokenOut,
          receiver,
          account
        ),
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
