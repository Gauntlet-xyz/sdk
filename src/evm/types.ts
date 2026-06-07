import type { Address } from 'viem';

export interface TokenInfo {
  symbol: string;
  address: Address;
  decimals: number;
}

export const ContractVersion = {
  V1: 'v1',
  V2: 'v2',
} as const;

export type ContractVersion = (typeof ContractVersion)[keyof typeof ContractVersion];

export interface EvmVaultDeployment {
  chain: 'evm';
  chainId: number;
  vaultAddress: Address;
  vaultType: 'single-depositor' | 'multi-depositor';
  supplyToken: TokenInfo[];
  /** Number of days before an async request deadline expires. Defaults to 3. */
  expirationDays?: number;
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
