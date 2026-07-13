# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn build        # tsc compile to dist/
yarn dev          # tsc --watch
yarn test         # vitest run (all tests under tests/)
yarn test:watch   # vitest watch mode
yarn lint         # eslint src/
yarn typecheck    # tsc --noEmit
yarn clean        # remove dist/ and .turbo/
```

Run a single test file:
```bash
yarn test tests/aera.ts
```

Tests require an RPC endpoint. Set `ALCHEMY_API_KEY` or `FORK_URL_<chainId>` (e.g. `FORK_URL_8453` for Base) before running fork tests. Tests use Anvil under the hood — each test suite forks a live chain at a pinned block number.

## Docs Parity

Before calling any task complete, check that the public docs still match the SDK's actual surface and behavior:
- `<repo-root>/gauntlet-docs/sdk/` (`overview.mdx`, `installation.mdx`, `reference.mdx`, `examples.mdx`) — Mintlify docs synced to the public `Gauntlet-xyz/gauntlet-docs` repo
- `README.md` in this package

If exports, signatures, options, error types, or documented behavior changed, update the docs in the same PR.

## Architecture

The SDK is a pure TypeScript ESM library (no framework). It compiles to `dist/` and ships two entry points:
- `@gauntlet-xyz/sdk` — main entry (re-exports everything below plus `GauntletClient`)
- `@gauntlet-xyz/sdk/evm` — EVM-only exports without the client

### GauntletClient (`src/client.ts`)

The root config object passed into every SDK function. Holds:
- `evmClients`: `Record<chainId, PublicClient>` — one viem public client per chain
- `wallet`: optional viem `WalletClient` — required for deposit/withdraw
- `attributionMode`: controls how Gauntlet attribution bytes are appended to calldata (`PUBLIC` / `ENCODED` / `PRIVATE`)
- `_manifest`: in-memory `VaultManifest` — defaults to the bundled `manifest/vaults.json`; override with `client.setManifest()`

### Vault Manifest (`manifest/vaults.json`, `src/evm/types.ts`)

Static JSON registry of all supported vaults. Each `VaultInfo` has:
- `vaultId`, `name`, `protocol` (`'aera'` | `'morpho'`), `strategy`
- `deployments: VaultDeployment[]` — currently only `EvmVaultDeployment` (narrowed by `chain: 'evm'`)

`VaultId` enum in `src/evm/vaults.ts` lists well-known vault IDs as constants.

### Protocol Adapters (`src/evm/adapters/`)

Each protocol has an adapter implementing `EvmProtocolAdapter`:
- `buildDeposit()` / `buildWithdraw()` — returns `EvmTxStep[]` (unsigned tx descriptors with ABI + args)
- `checkAllowance()` / `buildApproval()` — ERC-20 allowance helpers

Current adapters: `aera.ts`, `morpho.ts`. `index.ts` selects adapter by `protocol` string.

### Transaction Flow

`getDepositTx` / `getWithdrawTx` (top-level functions):
1. Resolve vault from manifest by `vaultId`
2. For Aera vaults: call `resolveAeraRuntimeContracts()` to read `provisioner` and `feeCalculator` addresses from the vault contract on-chain; detect V1 vs V2 by calling `version()` (ZeroData error → V1)
3. Resolve `OperationMode` (`sync` | `async`) from vault capabilities and caller preference
4. Check ERC-20 allowance; prepend approval step if needed
5. Delegate to protocol adapter for the actual tx steps
6. Each `EvmTxStep` is passed through `encodeTransactionWithAttribution()` in `src/attribution/index.ts` which ABI-encodes the call and appends attribution bytes to the calldata

### Attribution (`src/attribution/`)

- `PUBLIC` mode: appends ERC-8021 builder code suffix from `builderCode` config (or nothing if unset)
- `ENCODED` and `PRIVATE` modes are declared but throw `UnimplementedFeatureError`
- The encoding follows ERC-8021: `encodeBuilderCode()` in `src/attribution/erc8021.ts`

### Aera Runtime (`src/evm/aeraContracts.ts`, `src/evm/aeraContracts/`)

- `resolveAeraRuntimeContracts()` reads `provisioner` and `feeCalculator` from the vault contract
- `resolveContractVersion()` calls `version()` on-chain and caches results in a module-level `Map`; falls back to V1 on ZeroData/revert
- `priceAndFeeCalculator.ts` exposes price/unit conversion utilities (`convertTokenToUnits`, `convertUnitsToToken`, `getVaultState`, `isVaultPaused`, etc.) used by the frontend and external integrators

### Tests (`tests/`)

Fork tests using `@viem/anvil`. `tests/utils.ts` provides `setupAnvil()` / `withAnvil()` helpers that fork from Alchemy or a fallback RPC. Tests are not parallelized (`fileParallelism: false`) because each forks its own Anvil instance. Each test file pins a `FORK_BLOCK` constant — update it if adding tests for vaults deployed after that block.
