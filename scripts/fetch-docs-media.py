#!/usr/bin/env python3
"""Hydrate verified documentation media from an immutable public Git snapshot."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import tempfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "video/docs-demo/media.lock.json"
REPOSITORY = "Atom-oh/claude-code-usage-dashboard"
PATHS = frozenset({
    "site/assets/img/guide-analytics.png",
    "site/assets/img/guide-collector-devices.png",
    "site/assets/img/guide-collector.png",
    "site/assets/img/guide-cost-summary.png",
    "site/assets/img/guide-cost.png",
    "site/assets/img/guide-economics.png",
    "site/assets/img/guide-executive-charts.png",
    "site/assets/img/guide-executive.png",
    "site/assets/img/guide-installation.png",
    "site/assets/img/guide-mcp.png",
    "site/assets/img/guide-overview-trend.png",
    "site/assets/img/guide-overview.png",
    "site/assets/img/guide-plugins.png",
    "site/assets/img/guide-reliability.png",
    "site/assets/img/guide-skills.png",
    "site/assets/img/guide-task-call-reported.png",
    "site/assets/img/guide-task-call.png",
    "site/assets/img/guide-task-context.png",
    "site/assets/img/guide-task-list.png",
    "site/assets/img/guide-task-trace.png",
    "site/assets/img/guide-tools.png",
    "site/assets/img/guide-trends-charts.png",
    "site/assets/img/guide-trends.png",
    "site/assets/img/guide-unit-cost.png",
    "site/assets/img/guide-usage.png",
    "site/assets/img/guide-user-detail.png",
    "site/assets/img/guide-users.png",
    "site/assets/diagrams/system.html",
    "site/assets/diagrams/system.svg",
    "site/assets/fonts/PretendardVariable.woff2",
    "site/assets/img/docs-demo-en-poster.jpg",
    "site/assets/img/task-trace.png",
    "site/assets/img/task-trace-en.png",
    "site/assets/img/task-trace-model-en.png",
    "site/assets/img/task-trace-model-table-en.png",
    "site/assets/img/task-trace-overview-en.png",
    "site/assets/img/time-range-en.png",
    "site/assets/img/user-tasks-en.png",
    "site/assets/img/task-list-en.png",
    "site/assets/img/task-lanes-en.png",
    "site/assets/img/task-environment-en.png",
    "site/assets/img/call-detail-en.png",
    "site/assets/img/unit-cost-en.png",
    "site/assets/img/collector-setup-en.png",
    "site/assets/video/dashboard-demo-en-20261114.mp4",
    "site/assets/video/dashboard-demo-en-20261114.webm",
    "video/docs-demo/runtime/NotoSans.ttf",
    "video/docs-demo/runtime/gsap.min.js",
    "video/docs-demo/remotion/public/visual-base.mp4",
    "video/docs-demo/remotion/public/follow.mp3",
    "video/docs-demo/remotion/public/build.mp3",
    "video/docs-demo/remotion/public/lanes.mp3",
    "video/docs-demo/remotion/public/call.mp3",
    "video/docs-demo/remotion/public/model.mp3",
    "video/docs-demo/remotion/public/hosting.mp3",
    "video/docs-demo/remotion/public/background.wav",
})
MAX_FILE_BYTES = 8_000_000


def validate_manifest(manifest):
    if (not isinstance(manifest, dict) or manifest.get("schema_version") != 1
            or manifest.get("repository") != REPOSITORY
            or not isinstance(manifest.get("commit"), str)
            or not re.fullmatch(r"[0-9a-f]{40}", manifest.get("commit", ""))):
        raise ValueError("invalid media snapshot identity")
    files = manifest.get("files")
    if not isinstance(files, list) or len(files) != len(PATHS):
        raise ValueError("incomplete media inventory")
    names = []
    for item in files:
        if (not isinstance(item, dict) or item.get("path") not in PATHS
                or type(item.get("bytes")) is not int
                or not 0 < item["bytes"] <= MAX_FILE_BYTES
                or not isinstance(item.get("sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", ""))):
            raise ValueError("invalid media entry")
        names.append(item["path"])
    if set(names) != PATHS:
        raise ValueError("duplicate or missing media path")


def destination(root, name):
    root = root.resolve()
    target = root / name
    for part in (target, *target.parents):
        if part == root:
            break
        if part.is_symlink():
            raise ValueError("media paths must not contain symlinks")
    if not target.resolve().is_relative_to(root):
        raise ValueError("media path escapes repository")
    return target


def matches(target, item):
    if not target.is_file() or target.stat().st_size != item["bytes"]:
        return False
    return hashlib.sha256(target.read_bytes()).hexdigest() == item["sha256"]


def hydrate(root, manifest, site_only=False, offline=False, opener=urlopen):
    validate_manifest(manifest)
    selected = [item for item in manifest["files"]
                if not site_only or item["path"].startswith("site/")]
    # Validate every destination before making network requests or writing files.
    targets = [(item, destination(root, item["path"])) for item in selected]
    for item, target in targets:
        if matches(target, item):
            target.chmod(0o644)
            print("Verified " + item["path"])
            continue
        if offline:
            raise ValueError("missing or invalid cached media: " + item["path"])
        url = (f"https://raw.githubusercontent.com/{REPOSITORY}/"
               f"{manifest['commit']}/{item['path']}")
        with opener(url, timeout=60) as response:
            data = response.read(item["bytes"] + 1)
        if (len(data) != item["bytes"]
                or hashlib.sha256(data).hexdigest() != item["sha256"]):
            raise ValueError("media size or SHA256 mismatch: " + item["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data)
            temporary.chmod(0o644)
            temporary.replace(target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        print("Fetched " + item["path"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-only", action="store_true",
                        help="fetch site media without the render runtime")
    parser.add_argument("--offline", action="store_true",
                        help="verify cached files without network access")
    args = parser.parse_args()
    try:
        manifest = json.loads((ROOT / MANIFEST).read_text())
        hydrate(ROOT, manifest, args.site_only, args.offline)
    except (ValueError, OSError) as error:
        parser.exit(1, "Documentation media: " + str(error) + "\n")


if __name__ == "__main__":
    main()
