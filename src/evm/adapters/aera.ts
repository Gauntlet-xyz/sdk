import { erc20Abi } from '../abis/erc20';
import {
  getMultiDepositorVault,
  applySlippageDown,
  applySlippageUp,
  resolveContractVersion,
  type AeraRuntimeContracts,
} from '../aeraContracts';
import { convertTokenToUnits, convertUnitsToToken } from '../aeraContracts/priceAndFeeCalculator';
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
  tokenAddress: Address
) => {
  const vaultContract = getMultiDepositorVault(publicClient, vaultAddress);
  if (vaultContract === undefined) return;

  const calculatorAddress = await vaultContract.read.feeCalculator();
  if (!calculatorAddress) return;
  const calculatorVersion = await resolveContractVersion(publicClient, calculatorAddress);

  const unitsAmount = await convertTokenToUnits(
    publicClient,
    calculatorAddress,
    calculatorVersion,
    vaultAddress,
    tokenAddress,
    tokenAmount
  );

  return unitsAmount;
};

export const convertUnitsToTokenAmount = async (
  publicClient: PublicClient,
  unitsAmount: bigint,
  vaultAddress: Address,
  tokenAddress: Address
) => {
  const vaultContract = getMultiDepositorVault(publicClient, vaultAddress);
  if (vaultContract === undefined) return;

  const calculatorAddress = await vaultContract.read.feeCalculator();
  if (!calculatorAddress) return;
  const calculatorVersion = await resolveContractVersion(publicClient, calculatorAddress);

  return convertUnitsToToken(
    publicClient,
    calculatorAddress,
    calculatorVersion,
    vaultAddress,
    tokenAddress,
    unitsAmount
  );
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
  runtime,
  vault,
  token,
  tokensIn,
  isAsync,
}: {
  publicClient: PublicClient;
  runtime: AeraRuntimeContracts;
  vault: Address;
  token: Address;
  tokensIn: bigint;
  isAsync: boolean;
}): Promise<bigint> {
  if (runtime.provisioner.version === ContractVersion.V2) {
    return isAsync
      ? provisionerV2.getAsyncDepositUnitsOut(
          publicClient,
          runtime.provisioner.address,
          runtime.feeCalculator.address,
          runtime.feeCalculator.version,
          vault,
          token,
          tokensIn
        )
      : provisionerV2.getSyncDepositUnitsOut(
          publicClient,
          runtime.provisioner.address,
          runtime.feeCalculator.address,
          runtime.feeCalculator.version,
          vault,
          token,
          tokensIn
        );
  }

  return provisionerV1.getAsyncDepositUnitsOut(
    publicClient,
    runtime.provisioner.address,
    runtime.feeCalculator.address,
    runtime.feeCalculator.version,
    vault,
    token,
    tokensIn
  );
}

function getAsyncRedeemTokenOut(
  publicClient: PublicClient,
  runtime: AeraRuntimeContracts,
  vault: Address,
  token: Address,
  unitsIn: bigint
): Promise<bigint> {
  return runtime.provisioner.version === ContractVersion.V2
    ? provisionerV2.getAsyncRedeemTokenOut(
        publicClient,
        runtime.provisioner.address,
        runtime.feeCalculator.address,
        runtime.feeCalculator.version,
        vault,
        token,
        unitsIn
      )
    : provisionerV1.getAsyncRedeemTokenOut(
        publicClient,
        runtime.provisioner.address,
        runtime.feeCalculator.address,
        runtime.feeCalculator.version,
        vault,
        token,
        unitsIn
      );
}

function getAsyncWithdrawUnitsIn(
  publicClient: PublicClient,
  runtime: AeraRuntimeContracts,
  vault: Address,
  token: Address,
  tokensOut: bigint
): Promise<bigint> {
  return runtime.provisioner.version === ContractVersion.V2
    ? provisionerV2.getAsyncWithdrawUnitsIn(
        publicClient,
        runtime.provisioner.address,
        runtime.feeCalculator.address,
        runtime.feeCalculator.version,
        vault,
        token,
        tokensOut
      )
    : provisionerV1.getAsyncWithdrawUnitsIn(
        publicClient,
        runtime.provisioner.address,
        runtime.feeCalculator.address,
        runtime.feeCalculator.version,
        vault,
        token,
        tokensOut
      );
}

function requireAeraRuntime(runtime: AeraRuntimeContracts | undefined): AeraRuntimeContracts {
  if (!runtime) {
    throw new UnsupportedFeatureError('Aera: runtime contracts were not resolved');
  }

  return runtime;
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
      aeraRuntime,
    } = params;

    const runtime = requireAeraRuntime(aeraRuntime);
    const provisionerAddress = runtime.provisioner.address;
    const isContractV2 = runtime.provisioner.version === ContractVersion.V2;
    if (receiver !== account && !isContractV2) {
      throw new UnsupportedFeatureError('Aera: separate receiver address on V1');
    }

    if (!isAsync && !isContractV2) {
      throw new UnsupportedFeatureError('Aera: sync operations on V1');
    }

    const tokensInForUnits = isAsync ? subtractSolverTip(amount, solverTip) : amount;
    const vaultUnits = await getDepositUnitsOut({
      publicClient,
      runtime,
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
                provisionerAddress,
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
                provisionerAddress,
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
            provisionerAddress,
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
      aeraRuntime,
    } = params;

    const runtime = requireAeraRuntime(aeraRuntime);
    const provisionerAddress = runtime.provisioner.address;
    const isContractV2 = runtime.provisioner.version === ContractVersion.V2;
    if (receiver !== account && !isContractV2) {
      throw new UnsupportedFeatureError('Aera: separate receiver address on V1');
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
            provisionerAddress,
            runtime.feeCalculator.address,
            runtime.feeCalculator.version,
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
            provisionerAddress,
            runtime.feeCalculator.address,
            runtime.feeCalculator.version,
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
          runtime,
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
        runtime,
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
        spender: provisionerAddress,
        amount: shares,
      });

      if (!sufficient) {
        steps.push(
          this.buildApproval({
            token: vault.vaultAddress,
            spender: provisionerAddress,
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
                provisionerAddress,
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
                provisionerAddress,
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
            provisionerAddress,
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
          provisionerAddress,
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
