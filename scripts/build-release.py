#!/usr/bin/env python3
"""Build an immutable-source dashboard image and record its verified local provenance."""
import argparse
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile


def command(arguments, cwd, timeout=120):
    return subprocess.check_output(arguments, cwd=cwd, timeout=timeout).decode().strip()


def valid_digest(value):
    return isinstance(value, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value)


def inspect_runtime(image_id, probe, cwd):
    container = command([
        "docker", "create", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--memory", "128m", "--cpus", "0.5",
        "--pids-limit", "64", "--entrypoint", "node", image_id,
        "--input-type=module", "-e", probe,
    ], cwd)
    if not re.fullmatch(r"[a-f0-9]{64}", container):
        raise RuntimeError("Docker did not return an owned container ID")
    try:
        return json.loads(command(["docker", "start", "--attach", container], cwd, timeout=60))
    finally:
        # Only this immutable container ID is removed. An observation failure is
        # not proof of absence; do not certify the release if cleanup is unclear.
        for _ in range(3):
            try:
                subprocess.run(["docker", "rm", "--force", container], cwd=cwd,
                               capture_output=True, timeout=20, check=False)
                result = subprocess.run(
                    ["docker", "container", "inspect", "--format", "{{.Id}}", container],
                    cwd=cwd, capture_output=True, text=True, timeout=15, check=False,
                )
            except subprocess.TimeoutExpired:
                continue
            if result.returncode and any(
                marker in result.stderr for marker in
                (f"No such container: {container}", f"No such object: {container}")
            ):
                break
        else:
            raise RuntimeError("owned runtime-probe cleanup was not verified")


def registry_identity(image, local_image_id, cwd):
    descriptor = json.loads(command([
        "docker", "buildx", "imagetools", "inspect", image,
        "--format", "{{json .Manifest}}",
    ], cwd))
    digest = descriptor.get("digest")
    if not valid_digest(digest):
        raise RuntimeError("registry did not return an immutable image digest")
    manifests = descriptor.get("manifests")
    if manifests is not None:
        platforms = [
            row for row in manifests
            if row.get("platform", {}).get("os") == "linux"
            and row.get("platform", {}).get("architecture") == "arm64"
        ]
        if len(platforms) != 1:
            raise RuntimeError("registry image does not have exactly one ARM64 manifest")
        manifest_digest = platforms[0].get("digest")
    else:
        manifest_digest = digest
    if not valid_digest(manifest_digest):
        raise RuntimeError("registry ARM64 manifest digest is invalid")
    repository = image.rsplit(":", 1)[0]
    manifest = json.loads(command([
        "docker", "buildx", "imagetools", "inspect", "--raw",
        f"{repository}@{manifest_digest}",
    ], cwd))
    if manifest.get("config", {}).get("digest") != local_image_id:
        raise RuntimeError("published image config differs from the verified local image")
    return digest, manifest_digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Unique image name/tag; never latest.")
    parser.add_argument("--push", action="store_true",
                        help="Push the locally verified image using configured registry credentials.")
    parser.add_argument("--expected-image-id",
                        help="Approved local config digest; required for --push, checked before upload.")
    parser.add_argument("--record", type=Path, required=True, help="Private output JSON record outside the source build context.")
    args = parser.parse_args()
    if (args.push or args.expected_image_id is not None) and not valid_digest(args.expected_image_id):
        parser.error("--push requires a valid --expected-image-id from the approved local record")
    if not re.fullmatch(r"[a-z0-9][a-z0-9./:_-]+", args.image) or ":" not in args.image.rsplit("/", 1)[-1] or args.image.endswith(":latest"):
        parser.error("--image must be an explicit unique name/tag, not latest")
    if args.record.exists():
        parser.error("--record must be a new private output file")
    root = Path(__file__).resolve().parents[1]
    if command(["git", "status", "--porcelain"], root):
        parser.error("release source must be clean; use an isolated checkout for other work")
    revision = command(["git", "rev-parse", "HEAD"], root)
    if not re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", revision):
        parser.error("release source is not a full Git revision")
    archived = subprocess.check_output(["git", "archive", "--format=tar", revision, "dashboard/"], cwd=root)
    def committed(name):
        return subprocess.check_output(["git", "show", f"{revision}:{name}"], cwd=root)

    license_text = committed("LICENSE")
    if committed("dashboard/APPLICATION_LICENSE") != license_text:
        raise RuntimeError("packaged application license differs from repository LICENSE")
    expected = {
        "expectedRevision": revision,
        "expectedLicenseSha256": hashlib.sha256(license_text).hexdigest(),
        "expectedLockfiles": {
            component: hashlib.sha256(
                committed(f"dashboard/{component}/package-lock.json")
            ).hexdigest() for component in ("server", "web")
        },
    }
    probe_source = committed("dashboard/verify-runtime.mjs").decode()
    probe = probe_source + "\nconsole.log(JSON.stringify(verifyRuntime(" + json.dumps(expected) + ")));\n"
    with tempfile.TemporaryDirectory(prefix="ccdash-release-") as directory:
        context_root = Path(directory)
        # Only committed source enters the context; ignored .env/local credentials never do.
        with tarfile.open(fileobj=io.BytesIO(archived)) as archive:
            for member in archive.getmembers():
                if (member.name != "dashboard" and not member.name.startswith("dashboard/")) or member.name.startswith("/") or ".." in Path(member.name).parts:
                    raise RuntimeError("invalid archived build path")
                if not member.isdir() and not member.isfile():
                    raise RuntimeError("release context accepts only regular files and directories")
                destination = context_root / member.name
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as incoming, destination.open("xb") as output:
                        shutil.copyfileobj(incoming, output)
                    destination.chmod(member.mode & 0o777)
        metadata = context_root / "metadata.json"
        invocation = ["docker", "buildx", "build", "--platform", "linux/arm64",
                      "--build-arg", "APP_REVISION=" + revision, "--label",
                      "org.opencontainers.image.revision=" + revision,
                      "--metadata-file", str(metadata), "-t", args.image,
                      "--load", str(context_root / "dashboard")]
        subprocess.run(invocation, cwd=root, check=True)
        build_metadata = json.loads(metadata.read_text())
        record = {"revision": revision, "image": args.image, "platform": "linux/arm64",
                  "source": "git-archive", "pushed": args.push,
                  "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "sourceArchiveSha256": hashlib.sha256(archived).hexdigest(),
                  "lockfileSha256": expected["expectedLockfiles"],
                  "digest": build_metadata.get("containerimage.digest")}
        if not valid_digest(record["digest"]):
            raise RuntimeError("build did not report an immutable image digest")
        image = json.loads(command(["docker", "image", "inspect", args.image], root))[0]
        config = image.get("Config", {})
        image_id = image.get("Id")
        if not valid_digest(image_id) or image_id != build_metadata.get("containerimage.config.digest"):
            raise RuntimeError("loaded image differs from the build config digest")
        if args.expected_image_id and image_id != args.expected_image_id:
            raise RuntimeError("built image differs from the approved image ID")
        if image.get("Os") != "linux" or image.get("Architecture") != "arm64" or \
                config.get("Labels", {}).get("org.opencontainers.image.revision") != revision:
            raise RuntimeError("built image architecture or revision does not match source")
        if config.get("User") != "node":
            raise RuntimeError("runtime must use the nonroot Node user")
        if "APP_REVISION=" + revision not in config.get("Env", []):
            raise RuntimeError("runtime release identifier missing")
        record["localImageId"] = image_id
        record["runtime"] = inspect_runtime(image_id, probe, root)
        if args.push:
            if json.loads(command(["docker", "image", "inspect", args.image], root))[0]["Id"] != image_id:
                raise RuntimeError("image tag changed after local verification")
            subprocess.run(["docker", "push", args.image], cwd=root, check=True)
            record["localBuildDigest"] = record["digest"]
            record["digest"], record["arm64ManifestDigest"] = registry_identity(args.image, image_id, root)
        record["completedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        args.record.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(args.record, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(record, output, indent=2)
            output.write("\n")
        print(json.dumps({"revision": revision, "image": args.image, "digest": record["digest"],
                          "platform": record["platform"], "record": str(args.record)}))


if __name__ == "__main__":
    main()
