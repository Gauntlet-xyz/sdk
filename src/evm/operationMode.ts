import { UnsupportedDepositModeError } from '../errors';

export type OperationMode = 'sync' | 'async';

export interface OperationModeSupport {
  sync: boolean;
  async: boolean;
}

function formatAvailableModes(support: OperationModeSupport): string {
  if (support.async && support.sync) return 'both';
  if (support.async) return 'async';
  if (support.sync) return 'sync';
  return 'none';
}

export function parseOperationMode(
  vaultId: string,
  requested: string | undefined
): OperationMode | undefined {
  if (requested === undefined || requested === 'sync' || requested === 'async') {
    return requested;
  }

  throw new UnsupportedDepositModeError(vaultId, requested, 'sync, async');
}

export function resolveOperationMode(
  vaultId: string,
  requested: OperationMode | undefined,
  support: OperationModeSupport
): OperationMode {
  const available = formatAvailableModes(support);

  if (requested === 'sync') {
    if (!support.sync) throw new UnsupportedDepositModeError(vaultId, 'sync', available);
    return 'sync';
  }

  if (requested === 'async') {
    if (!support.async) throw new UnsupportedDepositModeError(vaultId, 'async', available);
    return 'async';
  }

  if (support.async) return 'async';
  if (support.sync) return 'sync';

  throw new UnsupportedDepositModeError(vaultId, 'async', available);
}

export function resolveSyncOnlyOperationMode(
  vaultId: string,
  requested: OperationMode | undefined
): OperationMode {
  if (requested === 'async') {
    throw new UnsupportedDepositModeError(vaultId, 'async', 'sync');
  }

  return 'sync';
}
