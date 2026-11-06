# Package Publishing Governance

These settings form part of the release boundary.
Repository administrators must configure them outside Git.
The workflow checks the required settings before publication.

## Direct sync and main

The monorepo sync pushes directly to SDK `main` through the sync App.
The release verifier does not require a branch ruleset, pull request approvals, or code owner approval.
It does not read the GitHub branch rules API.
Repository rules must permit the sync App to push directly.

Do not require pull requests or approval counts on SDK `main` without an explicit bypass for the sync App.
Required status checks must also permit the sync App to push before validation runs.
The release workflow validates every push to `main`, including source-only syncs.
Those checks run after the push; they do not prevent that push.

Treat repository write access and the sync App credentials as release authority.
Limit that access to trusted maintainers and the sync App.
Direct writers can change source code and release controls without a pull request review.
Deployment approval remains required before publication.

`.github/CODEOWNERS` suggests `@rdaq` and `@paul-vijender` for optional pull request reviews.
The sync preserves that file and the release controls under `.github`.

## Release environment

Configure the `npm-publish` environment as follows:

1. Add the release maintainers as required reviewers.
2. Enable prevention of self-review.
3. Select explicit deployment branches and tags.
4. Add exactly one branch rule named `main`.
5. Add no tag rule or wildcard branch rule.
6. Disable administrator bypass where the repository plan supports that control.
7. Store no long-lived npm publication token.

Do not use the "protected branches only" option.
GitHub permits every branch under that option when no branches have protection.
The verifier requires an explicit `main` branch rule instead.
An unreadable or incomplete policy response stops publication.
See [GitHub environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

## npm trusted publisher

Configure these exact values in npm:

| Field | Value |
| --- | --- |
| Owner | `Gauntlet-xyz` |
| Repository | `sdk` |
| Workflow filename | `npm-publish-package.yml` |
| Environment | `npm-publish` |

The environment field is required for this policy.
Without it, a modified branch workflow could request an OIDC token outside the protected environment.
Revoke obsolete publication tokens and remove unused trusted publishers.
Confirm the environment binding through npm package settings before the next release.
GitHub Actions cannot inspect that npm setting through its repository token.
