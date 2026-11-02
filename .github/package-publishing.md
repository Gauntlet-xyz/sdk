# Package Publishing

The SDK publishes through GitHub Actions and npm trusted publishing.

## Release path

1. Open a pull request with a stable version increase in `package.json`.
2. Update the release lockfile when package dependencies change.
3. Review the validation result and merge the pull request into `main`.
4. Approve the `npm-publish` deployment after checking its commit and artifact.
5. Check npm provenance after publication.

The workflow resolves the source to a full commit SHA before it builds the package.
It compares the version with the commit before the push.
Publication also requires a version above the current npm `latest` tag.
Live releases use stable versions and the `latest` tag only.
Rollbacks, unchanged versions, and prereleases cannot move that tag.

Pull requests and manual dispatches only validate packages.
They do not run the publication job.
The validation jobs have no OIDC permission.
Manual inputs enter the process through environment variables.
The workflow accepts no shell commands in a ref or dist-tag.
Dist-tags contain lowercase letters, digits, and hyphens.
Use `origin/branch`, a tag, or a full SHA for a manual ref.
The selected ref must contain the release controls and a matching release lockfile.

## Dependency and artifact checks

The release files live under `.github/release` because the monorepo sync preserves `.github`.
The sync preserves `package.json` but replaces other files at the repository root.
Do not move the release lockfile or release tests to that root.

The workflow uses Node 22.23.4 and npm 11.6.0.
It verifies the npm archive against a committed SHA-512 integrity value before installation.
Every external Action uses a full commit SHA.

The workflow copies `.github/release/package-lock.json` to the root before `npm ci --ignore-scripts`.
Dependency installation cannot run lifecycle scripts.
Only the explicit build and package export tests run afterward.
Packing and publication also disable lifecycle scripts.
Unpublished versions also pass `npm publish --dry-run` before publication.
Published versions receive archive validation only because npm rejects their publication dry-run.
The workflow reports that distinction explicitly.

Validation packs the package once and publishes only that archive.
It checks the package name, version, registry, access, manifests, and exported files.
The packed manifests must match the manifest from the selected source commit.
The packed exports must match the build outputs.
The publish job checks the archive's SHA-256 against the validation job output.
It also checks the package identity and manifest again before publication.
The publish job installs no project dependencies and runs no build scripts.

## Update the release lockfile

Use the pinned npm version to update the lockfile:

```sh
cp .github/release/package-lock.json package-lock.json
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
mv package-lock.json .github/release/package-lock.json
node --test .github/release/release.test.mjs
```

Review the resulting dependency versions, integrity values, and registry URLs.
A lockfile mismatch stops `npm ci`.

## Required external controls

Apply the settings in [Package Publishing Governance](./package-publishing-governance.md) before the next release.
The live verifier reads GitHub settings and stops publication when required review or branch controls are absent.
A pull request cannot apply npm settings or GitHub environment protection.

Bind npm trusted publishing to `Gauntlet-xyz/sdk`, `npm-publish-package.yml`, and environment `npm-publish`.
The environment binding prevents a modified branch workflow from omitting the protected environment.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for the configuration fields.
Do not store a long-lived npm publication token.
