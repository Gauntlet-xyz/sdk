import { GauntletSDKError } from '../errors';

export class GauntletApiError extends GauntletSDKError {
  readonly status: number;
  readonly path: string;
  /** Machine-readable code from the API error envelope (e.g. `NOT_FOUND`), when present. */
  readonly code?: string;

  constructor(params: { status: number; path: string; message: string; code?: string }) {
    super(
      `Gauntlet API request to "${params.path}" failed with ${params.status}: ${params.message}`
    );
    this.name = 'GauntletApiError';
    this.status = params.status;
    this.path = params.path;
    this.code = params.code;
  }
}

export class InvalidDecimalError extends GauntletSDKError {
  readonly value: string;

  constructor(value: string) {
    super(`Value "${value}" is not a valid decimal string`);
    this.name = 'InvalidDecimalError';
    this.value = value;
  }
}

export class DecimalPrecisionError extends GauntletSDKError {
  readonly value: string;
  readonly decimals: number;

  constructor(value: string, decimals: number) {
    super(
      `Decimal "${value}" has more fractional digits than the token's ${decimals} decimals; converting would lose precision`
    );
    this.name = 'DecimalPrecisionError';
    this.value = value;
    this.decimals = decimals;
  }
}

export class InvalidCaipIdError extends GauntletSDKError {
  readonly id: string;

  constructor(id: string) {
    super(`"${id}" is not a valid CAIP-10 vault id (expected "{chainId}:{address}")`);
    this.name = 'InvalidCaipIdError';
    this.id = id;
  }
}

export class SettlementTimeoutError extends GauntletSDKError {
  readonly requestHash: string;
  readonly timeoutMs: number;

  constructor(requestHash: string, timeoutMs: number) {
    super(`Request "${requestHash}" did not settle within ${timeoutMs}ms`);
    this.name = 'SettlementTimeoutError';
    this.requestHash = requestHash;
    this.timeoutMs = timeoutMs;
  }
}
