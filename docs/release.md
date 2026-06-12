# Release workflow

Croc releases are prepared locally and published by the tag-triggered GitHub workflow.

## Prepare locally

Start from a clean `main` branch.

```bash
npm run release:patch
```

Use `release:minor` or `release:major` for larger changes. The release script:

- bumps `package.json` and `package-lock.json`
- rolls `CHANGELOG.md` from `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`
- runs `npm test`
- runs `npm run check`
- runs `npm run build`
- runs `npm run pack:check`
- runs `npm run release:assets`
- commits `release vX.Y.Z`
- creates tag `vX.Y.Z`
- adds a fresh empty `## [Unreleased]` changelog section
- commits `start next changelog cycle`
- prints push commands

The script does not push. Inspect the result first.

## Publish

Push `main` and the tag when ready:

```bash
git push origin main
git push origin vX.Y.Z
```

Pushing the tag runs `.github/workflows/release-tarball.yml`, which verifies the package version matches the tag, reruns build/check/test/package validation, builds platform tarballs, extracts release notes from `CHANGELOG.md`, and creates or updates the GitHub release.

## Recovery

If a release asset build needs to be rerun without moving the tag, use the workflow dispatch input in GitHub Actions with the existing tag. Use `source_ref` only for release recovery when the source ref intentionally differs from the tag.
