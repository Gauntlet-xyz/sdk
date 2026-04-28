import type { Address } from 'viem';

export interface TokenInfo {
  symbol: string;
  address: Address;
  decimals: number;
}

export interface EvmVaultDeployment {
  chain: 'evm';
  chainId: number;
  vaultAddress: Address;
  /** Present for Aera multi-depositor vaults; absent for single-depositor and Morpho */
  provisionerAddress?: Address;
  vaultType: 'single-depositor' | 'multi-depositor';
  depositMode: 'sync' | 'async' | 'both';
  supplyToken: TokenInfo[];
}

/** Union of all supported chain deployment types. Narrow on `chain` to access chain-specific fields. */
export type VaultDeployment = EvmVaultDeployment;

export interface VaultInfo {
  vaultId: string;
  name: string;
  protocol: 'aera' | 'morpho';
  strategy: string;
  deployments: VaultDeployment[];
}

export interface VaultManifest {
  version: string;
  vaults: VaultInfo[];
}
