# Packaged install, phase 1: smaller dashboard image and OCB receiver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink the dashboard image by bundling the server and flattening away the Node base's package managers, and add a minimal OpenTelemetry Collector Builder (OCB) receiver image, both verified against current production behavior without changing production.

**Architecture:** The server is bundled with esbuild into three standalone ESM entries placed where today's source files sit, so every `import.meta.url`-relative path and every external entrypoint (`node server/index.js`, `node server/backupHealth.js`, `import("/app/server/clickhouse.js")`) keeps working with no `node_modules` in the image. The runtime stage copies the cleaned Node base filesystem into `FROM scratch`, so files deleted from the base actually leave the image while the single pinned `NODE_IMAGE` digest (and `build-release.py --base-image`) stays the only base input. The receiver is an OCB distribution containing exactly the components `central.yaml` uses, built from a digest-pinned Go image into a `scratch` image that runs as 10001:10001.

**Tech Stack:** Node 24 / esbuild 0.28.2, Docker buildx (linux/arm64), OCB `go.opentelemetry.io/collector/cmd/builder` v0.163.0 with Go 1.26, Python 3 `unittest` (no third-party packages), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-15-packaged-install-design.md` (Phasing step 1). The other phasing steps get their own plans: 2 schema modes, 3 Helm chart, 4 `ccdash-dev`, 5 public Terraform, 6 release workflow and `push-images.sh`, 7 production cut-over, 8 end-to-end install.

**Deviation from the spec, for review:** the spec says the runtime "starts from plain Alpine and copies only the Node binary". This plan instead flattens the cleaned official Node base into `scratch`. It reaches the same result: npm/Yarn/headers leave the image and only Node, the OS packages, and the APK database remain. It also keeps one base digest instead of two, so the `--base-image` pull-through-cache path, the `libstdc++`/musl pairing and the OpenSSL package pins stay exactly as verified today. If you want plain Alpine anyway, Task 3 is the only task that changes.

## Global Constraints

- Images are `linux/arm64` only.
- Base images are pulled by digest from `public.ecr.aws/docker/library/...`. No `docker.io` or `ghcr.io` reference appears in either Dockerfile.
- The dashboard pins stay unchanged: Node 24.22.1 and its OpenSSL 3.5.9, OS `zlib=1.4-r0`, and `libcrypto3`/`libssl3` 3.5.9-r0 (`dashboard/verify-runtime.mjs`). The dashboard runs as UID 1000 (`node`).
- The receiver's `dist.version` equals `dashboard/collector/release.json` `version` (0.163.1). Component modules, providers and build tags are copied verbatim from upstream `opentelemetry-collector-releases` tag `v0.163.1` `distributions/otelcol-contrib/manifest.yaml`:
  - components at v0.163.0;
  - `envprovider` and `fileprovider` at v1.69.0;
  - `build_tags: "grpcnotrace"`;
  - builder v0.163.0, whose `go.mod` declares `go 1.26.0`.
- The receiver runs as `USER 10001:10001`, matching `infra/device_ingest.tf` `run_as_user`/`run_as_group`.
- Notices stay `complete: true` with `unresolved: []`, and every package that ends up in the bundle has a notice entry.
- External entrypoints keep working:
  - `node server/index.js` (Dockerfile `CMD`);
  - `node server/backupHealth.js` (`infra/backup-monitor.tf:199`);
  - `import("/app/server/clickhouse.js")` (`docs/runbooks/deploy-production.md`, `verify_reader_session`).
- No production change in this phase. `infra/` (including `device_receiver_image`), `release-images.yml` and the deploy runbook's build/publish steps stay as they are.
- Each change PR adds a CHANGELOG `[Unreleased]` entry. Engineering docs are concise English.

## Review Focus

1. **Missing price snapshot.** `priceCatalog.js` reads `./awsPriceSnapshot.json` relative to `import.meta.url` and treats a missing file as silent ENOENT. If the bundle forgets the file, list prices drop to code defaults and nothing reports it. Task 1's smoke test asserts that `/api/config` reports `pricing.priceList.source === "snapshot"` with the committed `fetchedAt`.
2. **`require` of a Node builtin from a bundled CommonJS dependency.** Inside an ESM bundle this only fails when the code path runs ("Dynamic require of … is not supported"). Task 1 imports the bundled `clickhouse.js` and calls `ping()` against a closed port. It expects a false result or a connection error, never a dynamic-require error.
3. **The backup monitor CronJob runs the bundled `backupHealth.js`.** It must run its own `main`, not the server, and must fail closed when it has no service account. Task 1 asserts the `MONITOR_FAILED` output and the absence of module-resolution errors.
4. **Flattening changes filesystem modes.** `/tmp` must keep mode 1777 and `/home/node` must stay owned by UID 1000. Task 3 adds both checks to `verify-runtime.mjs`, which runs inside the built image.
5. **The receiver container in production's security context.** Production runs it with a read-only root filesystem and UID 10001, and reads secrets through the `${file:…}` provider. Task 5 runs `validate` in the image with `--read-only --user 10001:10001` and the mounted token and password files. It then runs the existing ClickHouse end-to-end test against the extracted binary.

---

### Task 1: Bundle the server with esbuild

**Files:**
- Modify: `dashboard/server/package.json`: add devDependency `"esbuild": "0.28.2"` (exact) and script `"bundle": "node scripts/bundle.mjs"`. Bump nothing else.
- Modify: `dashboard/server/package-lock.json` (via `npm install --save-dev --save-exact esbuild@0.28.2`).
- Create: `dashboard/server/scripts/bundle.mjs`
- Modify: `dashboard/server/teamDirectoryParams.js:3-6`
- Test: `dashboard/server/bundle.test.js`

**Interfaces:**
- Produces: `export async function bundleServer({ outdir }: { outdir: string }): Promise<{ entries: string[], metafile: object }>`
  - It writes `index.js`, `backupHealth.js`, `clickhouse.js` and `meta.json` (the esbuild metafile) into `outdir`, which must not already exist.
  - `entries` is `["backupHealth.js", "clickhouse.js", "index.js"]`.
  - CLI: `node scripts/bundle.mjs OUTDIR`. It exits 1 if OUTDIR exists or esbuild reports any warning not in `ALLOWED_WARNINGS`.
- Produces: `meta.json` input paths relative to `dashboard/server` (esbuild `absWorkingDir` = the server directory). Task 2 consumes them.

- [ ] **Step 1: Write the failing tests in `bundle.test.js`**
  - Build once in `before()` into `mkdtempSync(path.join(tmpdir(), "ccdash-bundle-"))/out`. Copy `package.json` and `awsPriceSnapshot.json` next to the bundle, as the Dockerfile will.
  - `test("bundle emits exactly the three runtime entries and a metafile")`: `readdirSync(out).sort()` deep-equals `["awsPriceSnapshot.json", "backupHealth.js", "clickhouse.js", "index.js", "meta.json", "package.json"]`.
  - `test("the server bundle excludes CLI entry modules")`: find the `metafile.outputs` entry whose `entryPoint === "index.js"`, because output keys are paths relative to the server directory. Its `inputs` keys contain neither `backupHealth.js` nor `compareCodexCost.js`.
  - `test("the server bundle boots, answers /healthz and reads its price snapshot")`:
    - Spawn `node out/index.js` with env `{ AUTH_ALLOW_INSECURE: "1", CH_URL: "http://127.0.0.1:1", AWS_PRICE_LIST: "off", PORT: <free port>, PATH }`. Pass only those keys; inherit no `BASIC_AUTH_*` or `INSIGHTS_ENABLED`.
    - Wait up to 15 s for `GET /healthz` to return 200 with a boolean `ok`.
    - `GET /api/config` must return `pricing.priceList.source === "snapshot"` and `fetchedAt` equal to `JSON.parse(awsPriceSnapshot.json).fetchedAt`.
    - Kill the child in `finally`.
  - `test("the runbook can import the bundled clickhouse module and its client loads")`:
    - Spawn `node --input-type=module -e` with env `CH_URL=http://127.0.0.1:1`.
    - The script imports `out/clickhouse.js`, asserts `typeof query === "function"`, and awaits `ping()` inside a try block.
    - It prints `JSON.stringify({ ok, error: err?.message ?? null })`.
    - Assert the exit code is 0, and that the output parses with `!/Dynamic require|ERR_MODULE_NOT_FOUND|Cannot find/.test(error ?? "")`.
  - `test("the backup monitor bundle runs its own main and fails closed without a service account")`:
    - Spawn `node out/backupHealth.js` with env `{ PATH }` and a 15 s timeout.
    - Assert exit code 1 and that stderr contains `"reason":"MONITOR_FAILED"`.
    - Assert that the output matches neither `ERR_MODULE_NOT_FOUND` nor `dashboard listening`.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `cd dashboard/server && node --test bundle.test.js`
  Expected: FAIL, cannot find `./scripts/bundle.mjs`.

- [ ] **Step 3: Replace the `createRequire` deep require in `teamDirectoryParams.js`**

  Use `import formatQueryParamsModule from "@clickhouse/client/dist/common/data_formatter/format_query_params.js"; const { formatQueryParams } = formatQueryParamsModule;`. A default import of a CommonJS file works in both Node and esbuild. `createRequire` resolves at runtime and would need `node_modules` in the image. Keep the existing comment explaining why it uses the client's own formatter.

- [ ] **Step 4: Implement `bundleServer` in `scripts/bundle.mjs`**

  esbuild options:
  - `entryPoints: ["index.js", "backupHealth.js", "clickhouse.js"]`;
  - `absWorkingDir` = the server directory;
  - `bundle: true`, `platform: "node"`, `format: "esm"`, `target: "node24"`;
  - `splitting: false`, `minify: false`, `sourcemap: false`, `metafile: true`, `logLevel: "silent"`;
  - `banner.js`: `import { createRequire as __ccdashCreateRequire } from "node:module"; const require = __ccdashCreateRequire(import.meta.url);`. Bundled CommonJS needs this to `require` builtins.

  Write `meta.json`. Check `result.warnings` against an exported `ALLOWED_WARNINGS` array (start empty). Each allowed entry must carry a one-line reason.

- [ ] **Step 5: Run the bundle tests and the full server suite**

  Run: `cd dashboard/server && node --test bundle.test.js && npm test`
  Expected: PASS. The existing `teamDirectoryParams` tests still pass.

- [ ] **Step 6: Commit**

  ```bash
  git add dashboard/server/package.json dashboard/server/package-lock.json dashboard/server/scripts/bundle.mjs dashboard/server/teamDirectoryParams.js dashboard/server/bundle.test.js
  git commit -m "build(server): bundle the runtime entries with esbuild"
  ```

### Task 2: Prove the notices cover the bundle

**Files:**
- Modify: `dashboard/collect-notices.mjs`
- Test: `dashboard/collect-notices.test.mjs`

**Interfaces:**
- Consumes: Task 1's `meta.json`, whose `inputs` keys are paths relative to `dashboard/server`.
- Produces: `export function bundleCoverage(serverRoot: string, metafile: object, report: { packages: {name, version}[] }): { bundled: string[], missing: string[] }`. Both lists hold sorted `name@version` strings.
- Produces: CLI `node collect-notices.mjs DASHBOARD_ROOT NEW_OUTPUT_DIRECTORY [--bundle-metafile PATH]`.
  - With the flag, it writes `bundledPackages` (the sorted list) into `THIRD_PARTY_NOTICES.json`.
  - It sets `complete: false` and pushes `{ package, reason: "bundled_without_notice" }` to `unresolved` for each missing entry, so the existing exit code and `verify-runtime.mjs` check reject it.

- [ ] **Step 1: Write the failing tests**
  - `test("bundle coverage maps scoped and nested node_modules inputs to installed versions")`:
    - In a temp server root, create the inputs `node_modules/a/package.json` (a@1.0.0), `node_modules/@s/b/package.json` (@s/b@2.0.0) and `node_modules/a/node_modules/c/package.json` (c@3.0.0).
    - The metafile inputs are `node_modules/a/index.js`, `node_modules/@s/b/dist/x.js`, `node_modules/a/node_modules/c/lib/y.js` and `index.js`.
    - Expect `bundled` to deep-equal `["@s/b@2.0.0", "a@1.0.0", "c@3.0.0"]`.
  - `test("application source inputs are not third-party packages")`: inputs of only `index.js` and `scripts/x.js` produce `bundled: []`.
  - `test("a bundled package absent from the notices is reported missing")`: with a report lacking `c@3.0.0`, expect `missing` to deep-equal `["c@3.0.0"]`.
  - `test("the CLI marks notices incomplete when the bundle has an un-noticed package")`: run `main` with `--bundle-metafile` over such a fixture. Expect exit code 1, and expect the written JSON to have `complete: false` and an `unresolved` reason of `"bundled_without_notice"`.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `cd dashboard/server && node --test ../collect-notices.test.mjs`
  Expected: FAIL, `bundleCoverage` is not exported.

- [ ] **Step 3: Implement `bundleCoverage`, then the `--bundle-metafile` flag in `main()`**

  The package root is the input path cut after its last `node_modules/<name>` segment, or after `node_modules/@scope/<name>` for scoped packages. Read `name@version` from that directory's `package.json`. Reject absolute paths and `..` segments the same way `collectNotices` does.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `cd dashboard/server && npm test`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add dashboard/collect-notices.mjs dashboard/collect-notices.test.mjs
  git commit -m "build(notices): fail when a bundled package has no notice"
  ```

### Task 3: Flattened runtime image without `node_modules`

**Files:**
- Modify: `dashboard/Dockerfile`
- Modify: `dashboard/verify-runtime.mjs`
- Test: `dashboard/server/runtimeImage.test.js`
- Modify: `docs/reference/runtime-distribution.md` (first two sections: bundled server, flattened base, no runtime `node_modules`)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Changed`: smaller dashboard image; the server ships as a bundle; no behavior change)

**Interfaces:**
- Consumes: Task 1's `node scripts/bundle.mjs OUTDIR` and Task 2's `--bundle-metafile`.
- Produces: in the image, `/app/server/{index.js,backupHealth.js,clickhouse.js,package.json,package-lock.json,awsPriceSnapshot.json}` exist, and `/app/server/node_modules` does not.
- Produces: `export const REQUIRED_SERVER_ENTRIES = ["backupHealth.js", "clickhouse.js", "index.js"]` in `verify-runtime.mjs`. `verifyRuntime()` returns an added `serverEntries: { [name]: sha256 }` field.

- [ ] **Step 1: Write the failing tests in `runtimeImage.test.js`**
  - Extend `fixture()`:
    - write the three entries under `app/server/`;
    - create `tmp` with `chmodSync(…, 0o1777)`;
    - create `home/node`.
    - Pass `homeOwner: 1000` through the options, because a fixture cannot `chown`. `verifyRuntime` takes `homeOwner = lstatSync(home/node).uid` as an injectable default.
  - `test("runtime inspection requires each bundled server entry")`: deleting each of `REQUIRED_SERVER_ENTRIES` in turn throws `/server bundle entry/`.
  - `test("runtime inspection rejects installed server node_modules")`: creating `app/server/node_modules` throws `/unexpected build artifact: app\/server\/node_modules/`.
  - `test("runtime inspection keeps /tmp sticky and the node home owned by the runtime user")`: mode `0o777` on `tmp` throws `/\/tmp mode/`, and `homeOwner: 0` throws `/node home owner/`.
  - Replace the FROM-line assertion in `test("official Node base pin agrees with the runtime inspector")`:
    - every `FROM` is `${NODE_IMAGE}` / `node-base` / `server-deps`, except exactly one `FROM scratch AS runtime`;
    - the Dockerfile contains `COPY --from=runtime-root / /`.
  - Point the zlib test at the `runtime-root` stage text.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `cd dashboard/server && node --test runtimeImage.test.js`
  Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement the `verify-runtime.mjs` checks**

  The new checks:
  - entries are regular, non-empty files, with their hashes returned;
  - `app/server/node_modules` and `app/server/scripts` are added to the `absent` list;
  - `(lstatSync(tmp).mode & 0o7777) === 0o1777`;
  - `homeOwner === 1000`.

- [ ] **Step 4: Restructure the Dockerfile**

  Keep the existing comments that still apply, and keep `HEALTHCHECK`/`CMD` unchanged. The stages:
  - `server-build` (from `node-base`):
    - `WORKDIR /app/server`, then copy the package files;
    - `npm ci` (with dev dependencies), then `COPY server/ ./`;
    - `RUN node scripts/bundle.mjs /app/server-bundle`.
  - `server-deps` (from `node-base`): production `npm ci --omit=dev --prefix server` only. It exists for the notice inventory and no longer copies the server source or `web/dist`.
  - `notices-build`:
    - `COPY --from=server-build /app/server-bundle/meta.json /tmp/bundle-meta.json`;
    - run `collect-notices.mjs /app /tmp/distribution-notices --bundle-metafile /tmp/bundle-meta.json`.
  - `runtime-root` (from `node-base`): today's `apk add --no-cache 'zlib=1.4-r0'` and package-manager removal `RUN` block, unchanged.
  - `runtime`:
    - `FROM scratch AS runtime`, then `COPY --from=runtime-root / /`;
    - `ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin NODE_VERSION=24.22.1`, then `WORKDIR /app`;
    - copy the three bundle entries from `server-build`, and copy `server/package.json`, `server/package-lock.json` and `server/awsPriceSnapshot.json` from the context into `./server/`;
    - copy `web/dist`, notices, collector packages and `APPLICATION_LICENSE`;
    - `ARG APP_REVISION`, `ENV APP_REVISION`, the revision `LABEL`, `ENV PORT=8080`, `EXPOSE`, `USER node`.

- [ ] **Step 5: Run the unit tests**

  Run: `cd dashboard/server && npm test`
  Expected: PASS.

- [ ] **Step 6: Commit, then build and inspect the real image from the clean commit**

  `build-release.py` refuses a dirty tree. Run it in the clean task worktree, not the main checkout, which holds untracked files.

  ```bash
  git add dashboard/Dockerfile dashboard/verify-runtime.mjs dashboard/server/runtimeImage.test.js docs/reference/runtime-distribution.md CHANGELOG.md
  git commit -m "build(image): ship the bundled server on a flattened Node base"
  python3 scripts/build-release.py --image ccdash-local:phase1-$(git rev-parse --short HEAD) \
    --record "$TMPDIR/ccdash-phase1-record.json" > "$TMPDIR/ccdash-phase1-build.log" 2>&1; echo "exit=$?"
  ```

  Expected: `exit=0`, and the record's `runtime` holds `serverEntries` with three hashes and `packageManagersAbsent: true`.

  Then:
  - `docker image inspect --format '{{.Size}}'` must report less than the 195 MB baseline (`20261115-025552`).
  - `docker save … | gzip -n -9 | wc -c` must report less than 69 MB.
  - `docker run --rm --network none --entrypoint stat <image> -c '%a %u' /tmp /home/node` must print `1777 0` and `2755 1000`.

  Record the measured sizes in the PR description, not in docs.

### Task 4: OCB receiver build definition

**Files:**
- Create: `collector-build/manifest.yaml`
- Create: `collector-build/Dockerfile`
- Create: `collector-build/README.md` (purpose, version rule, local build command, and the note that production keeps the upstream image until phase 7)
- Test: `collector-build/tests/test_receiver_build.py`
- Modify: `.github/workflows/ci.yml` `device-collector` job: add `python3 -m unittest discover -s collector-build/tests -p 'test_*.py'`. The binary tests skip there.

**Interfaces:**
- Produces: image entrypoint `/otelcol-ccdash-receiver` with `CMD ["--config=/etc/otelcol/config.yaml"]`. Production's existing `args` stay valid.
- Produces: `COMPONENT_TYPES` in the test module, a dict from module basename to component type:
  `bearertokenauthextension→bearertokenauth`, `healthcheckextension→health_check`, `otlpreceiver→otlp`, `batchprocessor→batch`, `memorylimiterprocessor→memory_limiter`, `filterprocessor→filter`, `resourceprocessor→resource`, `transformprocessor→transform`, `clickhouseexporter→clickhouse`. Task 5 reuses it.

- [ ] **Step 1: Write the failing tests**

  Use a small line-based reader for both YAML files. Collector tests use no third-party Python packages.
  - `test_dist_tracks_release_pin`:
    - `dist.version == json.load(release.json)["version"]`;
    - `dist.name == "otelcol-ccdash-receiver"`;
    - `dist.build_tags == "grpcnotrace"`.
  - `test_components_exactly_cover_central_config`: the set of `COMPONENT_TYPES[basename]` over all manifest `gomod` lines equals the set of types `central.yaml` uses. That set is the `service.extensions` entries plus the receivers/processors/exporters keys, each with any `/name` suffix removed. Expected: `{bearertokenauth, health_check, otlp, batch, memory_limiter, filter, resource, transform, clickhouse}`.
  - `test_one_component_version_and_exact_providers`: every component gomod ends in the same `v0.163.0`, and `providers` is exactly the `envprovider` and `fileprovider` modules at `v1.69.0`.
  - `test_matches_upstream_manifest` (skip unless `CCDASH_UPSTREAM_RECEIVER_MANIFEST` names a file): every `gomod` line of ours appears verbatim in the upstream file, and the upstream `dist.version` equals ours.
  - `test_dockerfile_pins_and_runs_nonroot`:
    - `ARG GO_IMAGE=public.ecr.aws/docker/library/golang:1.26` followed by `…@sha256:<64 hex>`;
    - `go install go.opentelemetry.io/collector/cmd/builder@v0.163.0`;
    - the last `FROM` is `scratch`, with `USER 10001:10001` and `ENTRYPOINT ["/otelcol-ccdash-receiver"]`;
    - no `docker.io` or `ghcr.io` substring.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `python3 -m unittest discover -s collector-build/tests -p 'test_*.py' -v`
  Expected: FAIL, manifest not found.

- [ ] **Step 3: Write `manifest.yaml` and `Dockerfile`**

  The manifest's `dist` block:
  - `module: github.com/Atom-oh/claude-code-usage-dashboard/receiver`;
  - `name: otelcol-ccdash-receiver`;
  - `description: ccdash central OTLP receiver`;
  - `version: 0.163.1`, `output_path: ./_build`, `build_tags: "grpcnotrace"`.

  The component lines are copied from the upstream manifest named in Global Constraints. The upstream `replaces` entries concern modules outside this component set, so leave them out.

  The Dockerfile:
  - Build stage `FROM ${GO_IMAGE} AS build`. Resolve the arm64-capable digest with `docker buildx imagetools inspect public.ecr.aws/docker/library/golang:1.26-alpine`.
  - Install the builder, then `CGO_ENABLED=0 builder --config manifest.yaml`.
  - Final stage `FROM scratch`. Copy `/etc/ssl/certs/ca-certificates.crt` and the binary with `--chmod=755`. Add `USER`, `EXPOSE 4318 13133`, `ENTRYPOINT` and `CMD`.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `curl -fsSL -o "$TMPDIR/upstream-manifest.yaml" https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector-releases/v0.163.1/distributions/otelcol-contrib/manifest.yaml && CCDASH_UPSTREAM_RECEIVER_MANIFEST="$TMPDIR/upstream-manifest.yaml" python3 -m unittest discover -s collector-build/tests -p 'test_*.py' -v`
  Expected: PASS, and no test is skipped.

- [ ] **Step 5: Commit**

  ```bash
  git add collector-build/ .github/workflows/ci.yml
  git commit -m "build(receiver): define a minimal OCB receiver distribution"
  ```

### Task 5: Verify the receiver against current production behavior

**Files:**
- Modify: `scripts/test-device-collector-sql.py`: the ClickHouse leg uses `os.environ.get("CCDASH_TEST_RECEIVER_BINARY") or binary`. The `test_runtime`/`test_privacy` fixtures keep the upstream contrib binary, because they also run the local hop and the `file` exporter.
- Modify: `collector-build/tests/test_receiver_build.py`: add the binary tests.
- Modify: `.github/workflows/ci.yml`: add a `receiver` job.
- Modify: `docs/reference/runtime-distribution.md`: a short "Receiver image" section covering what it contains, how it is verified, and that production still runs the upstream image.
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`: the OCB receiver image build, verified in CI and not yet deployed)

**Interfaces:**
- Consumes: Task 4's image entrypoint and `COMPONENT_TYPES`.

- [ ] **Step 1: Write the failing binary tests**

  Both tests skip unless `CCDASH_RECEIVER_BINARY` is set.
  - `test_binary_components_equal_manifest`:
    - Run `[$CCDASH_RECEIVER_BINARY, "components"]`.
    - Collect the `name:` values listed under `receivers`, `processors`, `exporters` and `extensions`.
    - The collected set equals the expected nine-type set, and the `connectors` list is empty.
  - `test_binary_validates_central_config`:
    - Write `central.yaml` with the token and password paths replaced by temp files, as `test-device-collector-sql.py` does.
    - Run `validate --config <file>` with env `CH_HOST=127.0.0.1 CH_PORT=9000 CH_DB=claude_code CH_USER=fixture`.
    - Expect exit 0.

- [ ] **Step 2: Build locally and run them**

  Run:

  ```bash
  docker buildx build --platform linux/arm64 --load -t ccdash-receiver:local collector-build > "$TMPDIR/receiver-build.log" 2>&1; echo "exit=$?"
  cid=$(docker create ccdash-receiver:local) && docker cp "$cid:/otelcol-ccdash-receiver" "$TMPDIR/" && docker rm "$cid"
  CCDASH_RECEIVER_BINARY="$TMPDIR/otelcol-ccdash-receiver" python3 -m unittest discover -s collector-build/tests -p 'test_*.py' -v
  CCDASH_TEST_RECEIVER_BINARY="$TMPDIR/otelcol-ccdash-receiver" python3 scripts/test-device-collector-sql.py
  ```

  Expected:
  - `exit=0`;
  - both binary tests PASS;
  - the SQL script prints its `all seven tables … passed` line.

  Record `docker image inspect --format '{{.Size}}' ccdash-receiver:local` for the PR; the upstream contrib image is 345 MB.

- [ ] **Step 3: Add the CI `receiver` job**
  - Runner: the same expression the `runtime` job uses, with `timeout-minutes: 30`.
  - A scope step like `runtime`'s. A PR builds only when it changes one of:
    - `collector-build/`;
    - `dashboard/collector/generated/central.yaml` or `dashboard/collector/release.json`;
    - `scripts/test-device-collector-sql.py` or `.github/workflows/ci.yml`.
  - Steps:
    - fetch the upstream manifest into `$RUNNER_TEMP`, then run the static tests with `CCDASH_UPSTREAM_RECEIVER_MANIFEST`;
    - `docker/setup-buildx-action@v3`, then build `ccdash-receiver:ci`;
    - a container check with production's security context:
      - `docker run --rm --network none --read-only --user 10001:10001`;
      - env `CH_HOST`/`CH_PORT`/`CH_DB`/`CH_USER`;
      - read-only mounts of the patched `central.yaml` at `/etc/otelcol/config.yaml`, a token file at `/var/run/ccdash-ingest/token` and a password file at `/var/run/ccdash-clickhouse/CH_PASSWORD`;
      - command `ccdash-receiver:ci validate --config=/etc/otelcol/config.yaml`, which must exit 0;
    - extract the binary, then run the binary tests and `test-device-collector-sql.py` with the two env vars from Step 2.

- [ ] **Step 4: Run the repository checks**

  Run: `(cd dashboard/server && npm test) && python3 -m unittest discover -s dashboard/collector/tests -p 'test_*.py' && bash tests/run-all.sh > "$TMPDIR/run-all.log" 2>&1; echo "exit=$?"`
  Expected: `exit=0`. `grep -c '✗' "$TMPDIR/run-all.log"` prints 0.

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/test-device-collector-sql.py collector-build/tests/test_receiver_build.py .github/workflows/ci.yml docs/reference/runtime-distribution.md CHANGELOG.md
  git commit -m "test(receiver): verify the OCB receiver against the ClickHouse schema in CI"
  ```
