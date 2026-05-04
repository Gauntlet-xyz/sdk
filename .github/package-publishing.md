# Package Publishing

This repo publishes the SDK to npm through GitHub Actions only.

## Workflow

Use [`npm-publish-package.yml`](./workflows/npm-publish-package.yml) for package release operations.

The workflow enforces these repo-side controls:

- merged version bumps to `main` trigger real publish automatically
- `workflow_dispatch` is for packaging validation only
- manual validation can run against any selected ref
- `npm publish --dry-run` always runs before any real publish
- live publish requires that the `package.json` version value changed
- live publishes always run in the hardcoded `npm-publish` GitHub Environment
- the real publish step consumes the exact packed tarball produced by validation
- live publish uses `npm publish --provenance`
- CI upgrades npm to `>=11.5.1` before validation or publish

## Trusted Publishing Setup

Trusted Publishing is configured outside git, but it should be treated as part of this release path.

1. In npm, open the package settings and configure Trusted Publishing for this repository.
2. Bind the package to `Gauntlet-xyz/sdk`.
3. Restrict the trusted workflow to `.github/workflows/npm-publish-package.yml`.
4. Verify the package can be published without any long-lived `NPM_TOKEN`.
5. Run a dry-run in GitHub Actions first, then merge a PR that changes the `package.json` version on `main`.
6. After publish, verify the release shows npm provenance and links back to the GitHub Actions run.

## Package Readiness

Before the package is allowed onto the public release path:

- it must not be marked `private`
- it must define a `build` script
- its `files`, entrypoints, and output paths must match the packed tarball contents

## Operational Notes

- Use `workflow_dispatch` for packaging and release validation without publishing.
- Use PR merge to `main` with a version bump to trigger real publish.
- Keep the `npm-publish` GitHub Environment protected. That environment is the approval boundary for live release.
