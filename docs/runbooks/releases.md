# Releases and tags

A release names a reviewed `main` revision so operators and users can see what changed.
It is separate from deployment: a tag does not prove that an image was built or rolled
out. Follow the [deployment runbook](deploy-production.md) to ship a tagged revision.

## Tag policy

| Tag | Use | Rules |
|---|---|---|
| `vMAJOR.MINOR.PATCH` | Application release | Annotated, on a `main` commit, created after the release PR merges |
| `docs-media-YYYYMMDD` | Immutable references to retired documentation media | Never moved; not a release |

- Use the `v` prefix only for releases. Never move, delete or re-point a pushed release
  tag; correct a bad release with a new patch release.
- Version numbers follow Semantic Versioning for this application:
  - **MAJOR**: an incompatible `/api/*` response or parameter change, a removed route, a
    configuration or schema change that needs manual operator steps.
  - **MINOR**: a new user-visible feature, page, endpoint or backward-compatible option.
  - **PATCH**: fixes only, with no new behavior to learn.
- `v1.0.0` was tagged retroactively on `714fc3b`, the revision deployed on 2026-11-08.
  Earlier history has no release tags.

## Cut a release

1. On a branch from current `main`, move the `## [Unreleased]` entries of
   [CHANGELOG.md](../../CHANGELOG.md) under `## [X.Y.Z] - YYYY-MM-DD` and leave an empty
   `## [Unreleased]` above it. The changelog stays the complete English record.
2. Set the version in both packages:

   ```bash
   (cd dashboard/web && npm version X.Y.Z --no-git-tag-version)
   (cd dashboard/server && npm version X.Y.Z --no-git-tag-version)
   ```

3. Add the release at the top of `RELEASES` in `dashboard/web/src/releaseNotes.js`: the
   user-facing subset in Korean UI copy, with where to find each feature, an app route
   when one exists, and PR numbers. Write it for users, not reviewers; omit CI-only and
   internal changes. The image build context is `dashboard/`, so the root changelog is
   not packaged and these notes are what `/changelog` shows.
4. Run the web tests. `releaseNotes.test.js` fails unless the latest note, both
   `package.json`/`package-lock.json` versions and the newest changelog heading match.
5. Merge the release PR through the normal review, then tag the merge commit and publish
   the notes:

   ```bash
   git fetch origin
   SHA=$(git rev-parse origin/main)       # the release PR merge commit
   git tag -a vX.Y.Z "$SHA" -m "vX.Y.Z"
   git push origin vX.Y.Z
   awk '/^## \[X.Y.Z\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md > notes.md
   gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file notes.md
   ```

   Confirm `origin/main` is still the release merge commit before tagging; otherwise tag
   that commit explicitly.

## Deploying a release

Build from the tag (`git checkout vX.Y.Z`) and record the tag with the image tag, digest
and revision in the deployment record. Image tags stay timestamp tags. Deploying an
untagged `main` revision is allowed; its `/changelog` then shows the latest release the
build contains, not changes merged after it. The installation probe reports the image
revision.

## Limits

The in-app notes are curated summaries. They do not replace the changelog, the API
reference or the contracts in [AGENTS.md](../../AGENTS.md), and a listed feature can still
be disabled by installation configuration (for example optional daily insights).
