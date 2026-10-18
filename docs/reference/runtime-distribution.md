# Runtime distribution contract

[Dockerfile](../../dashboard/Dockerfile) pins one official Node 24 image index for all
build stages. Refresh it through a reviewed change and verify its supported ARM64
platform and actual Node/system package versions. The final image removes npm, npx,
Yarn and Corepack after dependency installation; locked server dependencies, Node,
OS packages/metadata, readiness tooling and distribution notices remain.
The entrypoint uses Node directly. Removing build tools does not establish that the
remaining packages are free of vulnerabilities.

## Source and actual-image verification

[build-release.py](../../scripts/build-release.py) requires clean committed source and
a unique image tag. Only Git-archived dashboard files enter the build context; ignored
local credentials are excluded. The packaged application license must equal the
committed repository license. Both local and publication builds load the ARM64 image
and check Linux/ARM64, its build config digest, nonroot user and full revision label/env.

The committed [verify-runtime.mjs](../../dashboard/verify-runtime.mjs) is evaluated
inside that immutable image ID using Node builtins. It checks UID 1000, Node 24 and an
available OpenSSL version, the runtime revision, absent package managers/frontend
modules/collectors, license hash, complete nonempty notices, both committed lock
hashes and the installed server lock. It does not import app modules, read credentials
or contact a database. These checks do not establish auth/health behavior, CVE
applicability, base-image licensing completeness or a customer license grant.

The temporary probe container has no network, a read-only filesystem, no capabilities
and bounded CPU/memory/PIDs. Cleanup addresses its immutable container ID; unverified
absence fails the operation. A failed pre-publication check prevents upload.

## Publication identity and record

`--push` uploads the same locally verified image. The registry index/manifest is then
read back; exactly one Linux ARM64 child must resolve to the verified image config ID.
A registry mismatch fails without a successful provenance record; publication may
already have occurred, so inspect that unique tag before any retry or rollout.

The new private JSON record preserves full revision, archived-source SHA-256, both
lock hashes, local image/config ID, immutable build digest, actual runtime versions,
notices/license hashes and completion time. Publication records additionally preserve
the registry digest and ARM64 manifest digest. A local index digest is not proof of a
published child manifest or an Inspector scan result.

[CI](../../.github/workflows/ci.yml) builds and runs this inspection on ARM64 emulation
without registry publication. Native release acceptance still requires latest-HEAD
review, actual image/edge/auth checks and the other [product acceptance](../product-readiness.md)
rows. [Enhanced ECR scanning](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning-enhanced.html)
reports OS and language-package findings; query the exact published ARM64 manifest,
preserve its active findings and verify scan status before production rollout.
The [deployment runbook](../runbooks/deploy-production.md) owns publication/rollout.
