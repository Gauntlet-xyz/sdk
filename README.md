# @gauntlet-xyz/sdk

Official Gauntlet SDK for interacting with Gauntlet-managed vaults — deposits, withdrawals, and on-chain attribution.

## Documentation

Full documentation, guides, and API reference at **[docs.gauntlet.xyz](https://docs.gauntlet.xyz/)**.

## Installation

```bash
npm install @gauntlet-xyz/sdk viem
# or
yarn add @gauntlet-xyz/sdk viem
```

> `viem` is a required peer dependency.

## Aera contract versions

`getDepositTx`, `getWithdrawTx`, and `getUserCurrentBalance` support Aera deployments that use either the original Provisioner/PriceAndFeeCalculator contracts or ProvisionerV2/PriceAndFeeCalculatorV2.

Old Aera deployments keep their existing behavior: async deposit/redeem requests only, no separate receiver address, and old request event/hash tracking.

V2 Aera deployments may set `contractVersion: "v2"` in the vault manifest. When that metadata is absent, the SDK probes the provisioner `version()` method and falls back to old-compatible behavior if probing fails. For V2 sync deposits to a separate receiver, call `getDepositReceiverApprovalTx` with the receiver wallet first so the receiver can submit `setDepositReceiverApproval(depositor, true)`. After that receiver-side setup, the depositor can submit the transaction from `getDepositTx`.
