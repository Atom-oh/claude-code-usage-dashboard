# Distribution notices

[collect-notices.mjs](../../dashboard/collect-notices.mjs) inventories installed production
dependencies from both locked application packages. Docker runs it in an isolated build
stage and ships `THIRD_PARTY_NOTICES.txt` and `.json` in `/app/notices`; the final runtime
does not include frontend `node_modules` or the collector. The application license is
separate, in `/app/APPLICATION_LICENSE`, and tested against the canonical
[repository LICENSE](../../LICENSE).

## Source and coverage

Each record preserves package/version, component, declared license, complete discovered
license/NOTICE texts, their kind and SHA-256 hashes. Nested vendor notices are retained.
NOTICE-only packages remain unresolved; attribution cannot replace license terms or suppress
README/catalog fallback collection. Source files such as `license.js` do not qualify. Development
dependencies and absent optional platform packages are omitted; missing required packages
and installed-versus-lockfile version differences fail collection.

This is a conservative production dependency inventory, not a proof of every bundled
module's inclusion. Runtime package manifests and frontend build dependencies do not
replace base-image/system-software licensing obligations.

Some published packages omit a license file:

- Exact reviewed AWS SDK packages use the same declared Apache-2.0 license text from the
  installed `@aws-sdk/core` package in the identical publisher repository.
- `express-basic-auth@1.2.1` declares MIT but ships no complete license or copyright notice.
  Its exact publisher declaration/author and fixed source commit are preserved beside
  standard MIT text from a pinned official SPDX catalog. Copyright placeholders remain
  unfilled; no owner/year or additional grant is invented.

[provenance.json](../../dashboard/notices/provenance.json) binds the reviewed declarations
and standard source/hash. Unrecognized missing license texts/declarations and unlicensed
dependencies yield an incomplete report and nonzero build exit. Dependency changes require
reviewing these bindings; collection never fetches license texts during image builds.
`complete` means the stated inventory has declarations and texts, not a legal-compliance
opinion or a customer license grant. Customer use still requires the owner's written terms.

## Operator check

After separate `npm ci` installs, from the repository root:

```bash
node dashboard/collect-notices.mjs dashboard /tmp/dashboard-notices
```

The output directory must be new. Preserve the image's notices with the source revision,
lockfile hashes and image digest in the private acceptance packet. Extract them with
`docker cp` from the verified image/container; local generated files are not proof of what
an existing image contains. An unresolved report cannot close distribution acceptance.
