# Package Publishing Governance

This document covers the GitHub-side controls that are required in addition to the workflow implementation.

## CODEOWNERS

The repo should use a root `CODEOWNERS` file to enforce review requirements on package publishing controls.

Required owners for package publish governance changes:

- `@rdaq`
- `@paul-vijender`

These owners should cover:

- `.github/workflows/npm-publish-package.yml`
- `.github/package-publishing*.md`
- `package.json`

## Branch Protection / Rulesets

GitHub branch protection is configured outside git. Apply a ruleset that covers:

- `main`
- `version-bump/*`

Required settings:

1. Require pull requests before merge.
2. Require approvals before merge.
3. Require code owner review.
4. Require the npm publish validation workflow to pass before merge.
5. Disallow direct pushes for non-admin users.

## Version Bump PR Reviewers

For version bump pull requests, require both:

- `@rdaq`
- `@paul-vijender`

If GitHub rulesets cannot target named individuals directly, use CODEOWNERS on `package.json` and release-control files, then require code owner review in the branch ruleset.

Version bumps should be merged through PRs into `main`; that merge is the deployment trigger for npm publish.

## GitHub Environment

Protect the `npm-publish` GitHub Environment:

1. Require reviewers before deployment approval.
2. Limit environment use to `.github/workflows/npm-publish-package.yml`.
3. Do not store long-lived npm publish tokens in the environment.
4. Use the environment only as the approval boundary for live publishes.
5. Do not create alternate publish environments. The workflow hardcodes `npm-publish` to avoid bypassing protection through workflow input.
