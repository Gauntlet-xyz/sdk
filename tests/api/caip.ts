import { describe, expect, it } from 'vitest';
import {
  apiVaultIdFromVaultId,
  formatApiVaultId,
  parseApiVaultId,
  vaultIdFromApiVaultId,
} from '../../src/api/caip';
import { InvalidCaipIdError } from '../../src/api/errors';
import { GauntletClient } from '../../src/client';
import { ChainMismatchError, VaultNotFoundError } from '../../src/errors';
import { VaultId } from '../../src/evm/vaults';

const client = new GauntletClient({});

describe('parseApiVaultId', () => {
  it('parses the Gaia "{chainId}:{address}" format and lowercases the address', () => {
    expect(parseApiVaultId('8453:0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61')).toEqual({
      chainId: 8453,
      address: '0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61',
    });
  });

  it('accepts a full CAIP-10 eip155 prefix', () => {
    expect(parseApiVaultId('eip155:1:0xdd0f28e19C1780eb6396170735D45153D261490d').chainId).toBe(1);
  });

  it('rejects malformed ids', () => {
    for (const bad of ['', '8453', '0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61', '8453:0x123', 'base:0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61']) {
      expect(() => parseApiVaultId(bad), bad).toThrow(InvalidCaipIdError);
    }
  });
});

describe('formatApiVaultId', () => {
  it('lowercases and joins', () => {
    expect(formatApiVaultId(8453, '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61')).toBe(
      '8453:0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61'
    );
  });
});

describe('manifest resolvers', () => {
  it('resolves a manifest vault id to its API id', async () => {
    expect(await apiVaultIdFromVaultId(client, VaultId.BaseUsdcPrime)).toBe(
      '8453:0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61'
    );
  });

  it('round-trips API id back to the manifest vault id', async () => {
    const apiId = await apiVaultIdFromVaultId(client, VaultId.BaseUsdcPrime);
    expect(await vaultIdFromApiVaultId(client, apiId)).toBe(VaultId.BaseUsdcPrime);
  });

  it('resolves every manifest vault deployment back to its vault id', async () => {
    const manifest = await client.manifest;
    for (const vault of manifest.vaults) {
      for (const deployment of vault.deployments) {
        if (deployment.chain !== 'evm') continue;
        const apiId = formatApiVaultId(deployment.chainId, deployment.vaultAddress);
        expect(await vaultIdFromApiVaultId(client, apiId), apiId).toBe(vault.vaultId);
      }
    }
  });

  it('defaults multi-chain vaults to their Base deployment, matching tx-building resolution', async () => {
    const manifest = await client.manifest;
    const gtusda = manifest.vaults.find((v) => v.vaultId === VaultId.AeraUsdAlpha)!;
    const baseDeployment = gtusda.deployments.find((d) => d.chain === 'evm' && d.chainId === 8453)!;
    expect(await apiVaultIdFromVaultId(client, VaultId.AeraUsdAlpha)).toBe(
      formatApiVaultId(baseDeployment.chainId, baseDeployment.vaultAddress)
    );
  });

  it('throws on unknown vault ids and chain mismatches', async () => {
    await expect(apiVaultIdFromVaultId(client, 'not-a-vault')).rejects.toThrow(VaultNotFoundError);
    await expect(apiVaultIdFromVaultId(client, VaultId.BaseUsdcPrime, 1)).rejects.toThrow(
      ChainMismatchError
    );
    await expect(apiVaultIdFromVaultId(client, VaultId.AeraUsdAlpha, 999)).rejects.toThrow(
      VaultNotFoundError
    );
  });

  it('returns undefined for API ids outside the manifest', async () => {
    expect(
      await vaultIdFromApiVaultId(client, '8453:0x0000000000000000000000000000000000000001')
    ).toBeUndefined();
  });
});
