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
from html.parser import HTMLParser

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
        expected = {name for name in MEDIA.PATHS if name.startswith("site/")}
        self.assertEqual(len(self.calls), len(expected))
        self.assertEqual(
            {path.relative_to(self.root).as_posix() for path in self.root.rglob("*") if path.is_file()},
            expected,
        )
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

    def test_long_tour_limits_are_explicit_and_do_not_relax_other_media(self):
        for name, limit in MEDIA.FILE_SIZE_LIMITS.items():
            candidate = copy.deepcopy(self.manifest)
            entry = next(item for item in candidate["files"] if item["path"] == name)
            entry["bytes"] = limit
            MEDIA.validate_manifest(candidate)
            entry["bytes"] = limit + 1
            with self.assertRaises(ValueError):
                MEDIA.validate_manifest(candidate)
        candidate = copy.deepcopy(self.manifest)
        entry = next(item for item in candidate["files"] if item["path"] not in MEDIA.FILE_SIZE_LIMITS)
        entry["bytes"] = MEDIA.MAX_FILE_BYTES + 1
        with self.assertRaises(ValueError):
            MEDIA.validate_manifest(candidate)

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
        records.update({("site/assets/" + item["path"]): item
                        for item in metadata.get("guide", {}).get("assets", [])})
        records[demo["visual_base"]["path"]] = demo["visual_base"]
        tour = metadata.get("detailed_tour", {})
        records.update({("site/assets/" + item["path"]): item for item in tour.get("files", [])})
        records.update({item["path"]: item for item in tour.get("audio_assets", [])})
        records.update({item["path"]: item for item in tour.get("runtime_assets", [])})
        for item in manifest["files"]:
            self.assertEqual(item["bytes"], records[item["path"]]["bytes"])
            self.assertEqual(item["sha256"], records[item["path"]]["sha256"])

    def test_guide_screenshots_match_the_selected_language(self):
        class Screens(HTMLParser):
            def __init__(self):
                super().__init__()
                self.images = []
                self.lightbox = None

            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                if tag == "a" and "data-lightbox" in attrs:
                    self.lightbox = attrs.get("href")
                if tag == "img":
                    self.images.append((attrs, self.lightbox))

            def handle_endtag(self, tag):
                if tag == "a":
                    self.lightbox = None

        metadata = json.loads((ROOT / "site/assets/media.json").read_text())
        records = {item["name"]: item for item in metadata["images"]}
        for locale, directory in (("en", ""), ("ko", "ko")):
            for page in ("index", "user-guide"):
                parser = Screens()
                parser.feed((ROOT / "site" / directory / f"{page}.html").read_text())
                seen = set()
                for image, lightbox in parser.images:
                    name = Path(image.get("src", "")).name
                    if not name.startswith("guide-"):
                        continue
                    self.assertTrue(name.startswith(f"guide-{locale}-"), (locale, page, name))
                    record = records[name]
                    self.assertEqual(record["locale"], locale)
                    self.assertEqual(int(image["width"]), record["width"])
                    self.assertEqual(int(image["height"]), record["height"])
                    self.assertTrue(image.get("alt"))
                    if lightbox is not None:
                        self.assertEqual(Path(lightbox).name, name)
                    seen.add(name)
                if page == "user-guide":
                    self.assertEqual(seen, {f"guide-{locale}-{view}.png"
                                            for view in MEDIA.LOCALIZED_GUIDE_VIEWS})

    def test_localized_capture_source_records_are_unique_and_current(self):
        metadata = json.loads((ROOT / "site/assets/media.json").read_text())
        records = metadata["localized_guide_2026_11_15"]["source_files"]
        paths = [entry["path"] for entry in records]
        self.assertEqual(len(paths), len(set(paths)), "duplicate capture source record")
        for entry in records:
            data = (ROOT / entry["path"]).read_bytes()
            self.assertEqual(len(data), entry["bytes"], entry["path"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), entry["sha256"], entry["path"])

    def test_delivery_cache_is_ignored_and_absent_from_tracked_tree(self):
        tracked = set(subprocess.check_output(
            ["git", "-C", str(ROOT), "ls-files"], text=True).splitlines())
        self.assertFalse(tracked & MEDIA.PATHS)
        ignored = subprocess.check_output(
            ["git", "-C", str(ROOT), "check-ignore", "--", *sorted(MEDIA.PATHS)],
            text=True).splitlines()
        self.assertEqual(set(ignored), MEDIA.PATHS)

    def test_encoded_measurements_identify_locked_files(self):
        manifest = json.loads((ROOT / MEDIA.MANIFEST).read_text())
        locked = {item["path"]: item for item in manifest["files"]}
        metadata = json.loads((ROOT / "site/assets/media.json").read_text())
        for owner in ("current_demo", "detailed_tour"):
            demo = metadata[owner]
            measurements = demo["encoded_verification"]["encodes"]
            self.assertEqual({item["format"] for item in measurements}, {"mp4", "webm"})
            for measured in measurements:
                files = [item for item in demo["files"]
                         if item["path"].endswith("." + measured["format"])]
                self.assertEqual(len(files), 1)
                pinned = locked["site/assets/" + files[0]["path"]]
                for key in ("bytes", "sha256"):
                    self.assertEqual(measured[key], pinned[key], (owner, measured["format"], key))


    def test_tour_source_records_and_delivered_captions_match_their_files(self):
        metadata = json.loads((ROOT / "site/assets/media.json").read_text())["detailed_tour"]
        for item in metadata["source_files"]:
            path = ROOT / item["path"]
            self.assertEqual(path.stat().st_size, item["bytes"], item["path"])
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item["sha256"], item["path"])
        project = ROOT / "video/product-tour"
        translation = json.loads((project / "translations.json").read_text())
        self.assertEqual(hashlib.sha256((project / "captions.en.json").read_bytes()).hexdigest(),
                         translation["captions_sha256"])
        for locale in ("en", "ko"):
            self.assertEqual((project / f"captions.{locale}.vtt").read_bytes(),
                             (ROOT / f"site/assets/video/product-tour-{locale}-20261114.vtt").read_bytes())


if __name__ == "__main__":
    unittest.main()
