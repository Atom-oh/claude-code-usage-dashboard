"""Paid-generation failure and cache checks; all provider/process calls are mocked."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tour_audio", Path(__file__).with_name("prepare-audio.py"))
AUDIO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIO)


class AudioGenerationTests(unittest.TestCase):
    def test_matching_receipt_wins_over_an_obsolete_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "clip.mp3"
            receipt = target.with_suffix(".receipt.json")
            target.write_bytes(b"new normalized speech")
            current = {"source_sha256": "current", "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
            receipt.write_text(json.dumps(current))
            old = {"source_sha256": "previous", "sha256": "old", "marks": [{"segment": 0}]}
            self.assertEqual(AUDIO.cached_clip(target, receipt, old, "current"), current)
            self.assertIsNone(AUDIO.cached_clip(target, receipt, old, "different"))

    def test_complete_matching_metadata_avoids_repeating_marks(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "clip.mp3"
            receipt = target.with_suffix(".receipt.json")
            target.write_bytes(b"speech")
            current = {"source_sha256": "same", "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
            receipt.write_text(json.dumps(current))
            complete = {**current, "marks": [{"segment": 0, "time_seconds": 0.1}]}
            self.assertEqual(AUDIO.cached_clip(target, receipt, complete, "same"), complete)
            receipt.write_text("invalid partial JSON")
            self.assertEqual(AUDIO.cached_clip(target, receipt, complete, "same"), complete)

    def test_failed_marks_stop_later_scenes_and_retry_only_the_marks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = {"speech_rate": "100%", "voice": "Seoyeon", "engine": "neural",
                      "region": "ap-northeast-2", "sample_rate": 24000, "provider": "Amazon Polly",
                      "scenes": [{"id": "first", "segments": ["first"]},
                                 {"id": "second", "segments": ["second"]}]}
            (root / "script.json").write_text(json.dumps(script))
            (root / "audio.json").write_text(json.dumps({"clips": [
                {"id": "first", "source_sha256": "obsolete", "sha256": "obsolete"}]}))
            calls = []

            def run(command, **_kwargs):
                if command[0] == "aws":
                    speech = Path(command[command.index("--text") + 1].removeprefix("file://")).read_text()
                    output_format = command[command.index("--output-format") + 1]
                    calls.append(("first" if "first" in speech else "second", output_format))
                    if output_format == "json":
                        raise RuntimeError("speech marks failed")
                    Path(command[-1]).write_bytes(b"synthesized speech")
                elif command[0] == "ffmpeg":
                    Path(command[-1]).write_bytes(b"normalized speech")
                else:
                    self.fail("Unexpected process: " + command[0])

            with patch.object(AUDIO, "ROOT", root), patch.object(AUDIO.shutil, "which", return_value="mock"), \
                    patch.object(AUDIO, "probe", return_value=1.0), patch.object(AUDIO.subprocess, "run", side_effect=run):
                with self.assertRaisesRegex(RuntimeError, "speech marks failed"):
                    AUDIO.main()
                self.assertEqual(calls, [("first", "mp3"), ("first", "json")])
                self.assertTrue((root / "audio/first.receipt.json").is_file())
                calls.clear()
                with self.assertRaisesRegex(RuntimeError, "speech marks failed"):
                    AUDIO.main()
                self.assertEqual(calls, [("first", "json")])


if __name__ == "__main__":
    unittest.main()
