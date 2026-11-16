#!/usr/bin/env bash
# Static contract of the release image workflow: it builds through the inspected release
# helper from an annotated main tag, on a GitHub-hosted runner, and never replaces assets.

RI_WF=.github/workflows/release-images.yml
RI_SRC="$(grep -v '^\s*#' "$RI_WF" 2>/dev/null || true)"

assert_file_exists "release image workflow exists" "$RI_WF"
assert_grep_match "runs on the GitHub-hosted ARM runner" 'runs-on: ubuntu-24.04-arm' "$RI_SRC"
assert_grep_no_match "never on the self-hosted runners" 'claude-code-usage-dashboard' "$RI_SRC"
assert_grep_no_match "every action is pinned to a commit SHA" 'uses: (?![^@\s]+@[0-9a-f]{40}(\s|$))' "$RI_SRC"
assert_grep_match "workflow token defaults to read" '^  contents: read' "$RI_SRC"
assert_grep_match "builds through the inspected release helper" 'scripts/build-release\.py --image "ccdash-dashboard:\$TAG"' "$RI_SRC"
assert_grep_no_match "no build cache enters a release image" '\-\-cache-(from|to)' "$RI_SRC"
assert_grep_match "requires an annotated tag" 'git cat-file -t "refs/tags/\$TAG"' "$RI_SRC"
assert_grep_match "requires the tag on main" 'merge-base --is-ancestor' "$RI_SRC"
assert_grep_match "workflow sets run defaults" '^defaults:$' "$RI_SRC"
assert_grep_match "steps run with bash (-eo pipefail)" '^    shell: bash$' "$RI_SRC"
RI_PACKAGE="$(sed -n '/name: Package the image archive/,/^      - /p' "$RI_WF")"
RI_ORDER="$(printf '%s\n' "$RI_PACKAGE" | awk '/set -o pipefail/ && !p {p=NR} /docker save .*\| gzip/ && !d {d=NR} END {print (p && d && p < d) ? "ok" : "missing"}')"
assert_eq "the export pipeline fails closed" "ok" "$RI_ORDER"
assert_grep_match "the archive is checked before checksums" 'gzip -t "dist/\$archive"' "$RI_PACKAGE"
assert_grep_match "publishes checksums" 'sha256sum' "$RI_SRC"
assert_grep_match "attests the archive" 'actions/attest-build-provenance' "$RI_SRC"
assert_grep_match "attests only runs whose ref is the tag" "github\.ref == format\('refs/tags/\{0\}'" "$RI_SRC"
assert_grep_match "the attestation step is gated" "^      - if: env\.ATTEST == 'true'$" "$RI_SRC"
assert_grep_match "an attested run's commit is the tag commit" '"\$GITHUB_SHA" = "\$\(git rev-parse "\$TAG\^\{commit\}"\)"' "$RI_SRC"
assert_grep_no_match "existing assets are never replaced" '\-\-clobber' "$RI_SRC"
assert_grep_no_match "the private build record is not published" 'cp .*ccdash-release\.json|dist/ccdash-release' "$RI_SRC"
