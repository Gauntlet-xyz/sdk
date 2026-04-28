import { aeraAdapter } from './aera';
import { morphoAdapter } from './morpho';
import { UnsupportedProtocolError } from '../../errors';
import type { EvmProtocolAdapter } from './types';

export function getAdapter(protocol: string): EvmProtocolAdapter {
  switch (protocol) {
    case 'aera':
      return aeraAdapter;
    case 'morpho':
      return morphoAdapter;
    default:
      throw new UnsupportedProtocolError(protocol);
  }
}
