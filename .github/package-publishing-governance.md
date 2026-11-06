# Package Publishing Governance

These settings form part of the release boundary.
Repository administrators must configure them outside Git.
The workflow checks the required settings before publication.

## Code owners and main

`.github/CODEOWNERS` assigns review to `@rdaq` and `@paul-vijender`.
That location survives the monorepo sync.
GitHub accepts one listed owner's approval as the code owner review.
It does not require both listed owners automatically.

Create an active branch ruleset for `main` with these requirements:

1. Require a pull request for every change.
2. Require at least one approval.
3. Require code owner review.
4. Dismiss approvals after a new push.
5. Require the `Validate release artifact` check.
6. Block force pushes and branch deletion.
7. Remove bypass grants that permit unreviewed source or workflow changes.

The live verifier checks active ruleset requirements for approval count, code owners, and stale approvals.
The ruleset must enforce those requirements; a disabled or evaluation-only ruleset does not satisfy the check.
See [GitHub rules for a branch](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch).

The current monorepo sync pushes directly to `main`.
These rules must reject an unreviewed sync push.
Move that sync to a reviewed pull request before enabling automatic updates under this policy.
Do not grant the sync App a review bypass.

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
