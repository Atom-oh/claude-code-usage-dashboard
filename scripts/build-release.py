#!/usr/bin/env python3
"""Build an immutable-source dashboard image and record its verified local provenance."""
import argparse
import datetime
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile


def command(arguments, cwd):
    return subprocess.check_output(arguments, cwd=cwd).decode().strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Unique image name/tag; never latest.")
    parser.add_argument("--push", action="store_true", help="Push using already-configured registry credentials.")
    parser.add_argument("--record", type=Path, required=True, help="Private output JSON record outside the source build context.")
    args = parser.parse_args()
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
                      "--push" if args.push else "--load", str(context_root / "dashboard")]
        subprocess.run(invocation, cwd=root, check=True)
        build_metadata = json.loads(metadata.read_text())
        record = {"revision": revision, "image": args.image, "platform": "linux/arm64",
                  "source": "git-archive", "pushed": args.push,
                  "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "digest": build_metadata.get("containerimage.digest")}
        if not args.push:
            image = json.loads(command(["docker", "image", "inspect", args.image], root))[0]
            if image["Architecture"] != "arm64" or image["Config"]["Labels"].get("org.opencontainers.image.revision") != revision:
                raise RuntimeError("built image architecture or revision does not match source")
            if "APP_REVISION=" + revision not in image["Config"].get("Env", []):
                raise RuntimeError("runtime release identifier missing")
            record["localImageId"] = image["Id"]
        if not record["digest"]:
            raise RuntimeError("build did not report an immutable image digest")
        args.record.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(args.record, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(record, output, indent=2)
            output.write("\n")
        print(json.dumps({"revision": revision, "image": args.image, "digest": record["digest"],
                          "platform": record["platform"], "record": str(args.record)}))


if __name__ == "__main__":
    main()
