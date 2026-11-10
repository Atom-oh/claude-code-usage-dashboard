"""Offline integrity, source pinning and safe-write checks for Pages media."""

import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("media", ROOT / "scripts/fetch-docs-media.py")
MEDIA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MEDIA)


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.data = b"verified fixture"
        self.manifest = {
            "schema_version": 1, "repository": MEDIA.REPOSITORY, "commit": "a" * 40,
            "files": [{"path": path, "bytes": len(self.data),
                       "sha256": hashlib.sha256(self.data).hexdigest()}
                      for path in sorted(MEDIA.PATHS)],
        }
        self.calls = []

    def opener(self, url, timeout):
        self.calls.append(url)
        self.assertTrue(url.startswith(
            "https://raw.githubusercontent.com/" + MEDIA.REPOSITORY + "/" + "a" * 40 + "/"))
        self.assertEqual(timeout, 60)
        return io.BytesIO(self.data)

    def test_fetch_and_verified_cache_do_not_repeat_network(self):
        MEDIA.hydrate(self.root, self.manifest, opener=self.opener)
        self.assertEqual(len(self.calls), len(MEDIA.PATHS))
        for item in self.manifest["files"]:
            target = self.root / item["path"]
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            target.chmod(0o600)
        MEDIA.hydrate(self.root, self.manifest, offline=True)
        self.assertEqual(len(self.calls), len(MEDIA.PATHS))
        for item in self.manifest["files"]:
            self.assertEqual((self.root / item["path"]).stat().st_mode & 0o777, 0o644)

    def test_site_only_keeps_runtime_out_of_pages(self):
        MEDIA.hydrate(self.root, self.manifest, site_only=True, opener=self.opener)
        self.assertEqual(len(self.calls), 8)
        self.assertFalse((self.root / "video").exists())

    def test_corrupt_download_preserves_existing_file(self):
        first = self.manifest["files"][0]
        target = self.root / first["path"]
        target.parent.mkdir(parents=True)
        target.write_bytes(b"old cache")
        for bad in (b"x" * len(self.data), self.data[:-1], self.data + b"x"):
            with self.assertRaisesRegex(ValueError, "mismatch"):
                MEDIA.hydrate(self.root, self.manifest,
                              opener=lambda *args, **kwargs: io.BytesIO(bad))
            self.assertEqual(target.read_bytes(), b"old cache")
        self.assertEqual(list(target.parent.iterdir()), [target])

    def test_offline_rejects_missing_and_corrupt_cache(self):
        with self.assertRaisesRegex(ValueError, "cached media"):
            MEDIA.hydrate(self.root, self.manifest, offline=True)
        MEDIA.hydrate(self.root, self.manifest, opener=self.opener)
        (self.root / self.manifest["files"][0]["path"]).write_bytes(b"x")
        with self.assertRaisesRegex(ValueError, "cached media"):
            MEDIA.hydrate(self.root, self.manifest, offline=True)

    def test_manifest_rejects_unpinned_sources_and_unsafe_inventory(self):
        mutations = [
            lambda m: m.update(commit="main"),
            lambda m: m.update(commit=123),
            lambda m: m.update(repository="other/repo"),
            lambda m: m["files"][0].update(path="../escape"),
            lambda m: m["files"][0].update(bytes=MEDIA.MAX_FILE_BYTES + 1),
            lambda m: m["files"][0].update(sha256="x" * 64),
            lambda m: m["files"][0].update(sha256=123),
            lambda m: m["files"].pop(),
            lambda m: m["files"].__setitem__(0, copy.deepcopy(m["files"][1])),
        ]
        for mutate in mutations:
            candidate = copy.deepcopy(self.manifest)
            mutate(candidate)
            with self.assertRaises(ValueError):
                MEDIA.hydrate(self.root, candidate, opener=self.opener)
        self.assertEqual(self.calls, [])
        with self.assertRaises(ValueError):
            MEDIA.validate_manifest([])

    def test_symlinks_are_rejected_before_any_download(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "site").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlinks"):
            MEDIA.hydrate(self.root, self.manifest, opener=self.opener)
        self.assertEqual(self.calls, [])
        self.assertEqual(list(outside.iterdir()), [])

    def test_checked_in_lock_agrees_with_site_provenance(self):
        manifest = json.loads((ROOT / MEDIA.MANIFEST).read_text())
        MEDIA.validate_manifest(manifest)
        metadata = json.loads((ROOT / "site/assets/media.json").read_text())
        records = {("site/assets/" + item["path"]): item for item in metadata["images"]}
        demo = metadata["current_demo"]
        records.update({("site/assets/" + item["path"]): item for item in demo["files"]})
        records.update({item["path"]: item for item in demo["runtime_assets"]})
        records.update({item["path"]: item for item in demo["audio_assets"]})
        records[demo["visual_base"]["path"]] = demo["visual_base"]
        for item in manifest["files"]:
            self.assertEqual(item["bytes"], records[item["path"]]["bytes"])
            self.assertEqual(item["sha256"], records[item["path"]]["sha256"])

    def test_delivery_cache_is_ignored_and_absent_from_tracked_tree(self):
        tracked = set(subprocess.check_output(
            ["git", "-C", str(ROOT), "ls-files"], text=True).splitlines())
        self.assertFalse(tracked & MEDIA.PATHS)
        ignored = subprocess.check_output(
            ["git", "-C", str(ROOT), "check-ignore", "--", *sorted(MEDIA.PATHS)],
            text=True).splitlines()
        self.assertEqual(set(ignored), MEDIA.PATHS)


if __name__ == "__main__":
    unittest.main()
