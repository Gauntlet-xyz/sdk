import { ChainId } from './client';

export class GauntletSDKError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GauntletSDKError';
  }
}

export class VaultNotFoundError extends GauntletSDKError {
  readonly vaultId: string;
  readonly chainId?: ChainId;

  constructor(vaultId: string, chainId?: ChainId) {
    const msg = chainId
      ? `Vault "${vaultId}" not found on chainId "${chainId}"`
      : `Vault "${vaultId}" not found`;
    super(msg);
    this.name = 'VaultNotFoundError';
    this.vaultId = vaultId;
    this.chainId = chainId;
  }
}

export class UnsupportedAssetError extends GauntletSDKError {
  readonly asset: string;
  readonly vaultId: string;

  constructor(asset: string, vaultId: string) {
    super(`Asset "${asset}" is not supported by vault "${vaultId}"`);
    this.name = 'UnsupportedAssetError';
    this.asset = asset;
    this.vaultId = vaultId;
  }
}

export class ChainMismatchError extends GauntletSDKError {
  readonly expected: string;
  readonly received: string;

  constructor(expected: string, received: string) {
    super(`Chain mismatch: expected "${expected}", received "${received}"`);
    this.name = 'ChainMismatchError';
    this.expected = expected;
    this.received = received;
  }
}

export class UnsupportedDepositModeError extends GauntletSDKError {
  readonly vaultId: string;
  readonly requested: 'sync' | 'async';
  readonly available: string;

  constructor(vaultId: string, requested: 'sync' | 'async', available: string) {
    super(`Vault "${vaultId}" does not support ${requested} deposits (available: ${available})`);
    this.name = 'UnsupportedDepositModeError';
    this.vaultId = vaultId;
    this.requested = requested;
    this.available = available;
  }
}

export class RpcNotConfiguredError extends GauntletSDKError {
  readonly chainId: ChainId;

  constructor(chainId: ChainId) {
    super(`No client configured for chainId "${chainId}"`);
    this.name = 'RpcNotConfiguredError';
    this.chainId = chainId;
  }
}

export class AccountRequiredError extends GauntletSDKError {
  constructor() {
    super('No account specified. Provide a wallet in the client config.');
    this.name = 'AccountRequiredError';
  }
}

export class UnsupportedProtocolError extends GauntletSDKError {
  readonly protocol: string;

  constructor(protocol: string) {
    super(`Unsupported protocol: "${protocol}"`);
    this.name = 'UnsupportedProtocolError';
    this.protocol = protocol;
  }
}

export class InvalidWithdrawParamsError extends GauntletSDKError {
  constructor() {
    super('Withdraw requires exactly one of: shares, amount, or all');
    this.name = 'InvalidWithdrawParamsError';
  }
}

export class UnimplementedFeatureError extends GauntletSDKError {
  readonly feature: string;

  constructor(feature: string) {
    super(`Feature not yet implemented: "${feature}"`);
    this.name = 'UnimplementedFeatureError';
    this.feature = feature;
  }
}

export class UnsupportedFeatureError extends GauntletSDKError {
  readonly feature: string;

  constructor(feature: string) {
    super(`Feature not supported: "${feature}"`);
    this.name = 'UnimplementedFeatureError';
    this.feature = feature;
  }
}

export class UnitConversionError extends GauntletSDKError {
  readonly vaultAddress: string;

  constructor(vaultAddress: string) {
    super(`Failed to convert token units for vault "${vaultAddress}": fee calculator unavailable`);
    this.name = 'UnitConversionError';
    this.vaultAddress = vaultAddress;
  }
}

export class InvalidSlippageBPSError extends GauntletSDKError {
  readonly slippage: number;

  constructor(slippage: number) {
    super(`Slippage not in range of 10000-0; argumet passed: ${slippage}`);
    this.name = 'IncorrectArgument';
    this.slippage = slippage;
  }
}
