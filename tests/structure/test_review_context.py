import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("review_prompts", ROOT / "scripts/pr-review/build-prompts.py")
PROMPTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROMPTS)


class ReviewContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        for path, content in {
            "AGENTS.md": "# Base rules\nUse reported_cost. Tests run in ci.yml.\n",
            PROMPTS.PACKAGING: "# Packaging\nBuild the web bundle into the server image.\n",
            PROMPTS.SERVER: "# Server\nCounter identity and actual API contracts.\n",
            PROMPTS.WEB: "# Web\nCSV follows visible columns. usd(0) is valid.\n",
            PROMPTS.INFRA: "# Infra\nSource configuration is not deployment proof.\n",
            PROMPTS.REVIEW: "# Review\nNever weaken no-tools or coverage gates.\n",
            PROMPTS.VIDEO: "# Video\nUse the pinned media toolchain.\n",
        }.items():
            file = self.root / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content)
        self.commit()

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-C", str(self.root), "-c", "user.name=Test",
             "-c", "user.email=test@example.invalid", *args], stderr=subprocess.DEVNULL
        ).decode().strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def test_context_comes_from_pinned_git_revision_not_worktree(self):
        snapshot = PROMPTS.Snapshot(self.root)
        original = snapshot.revision
        (self.root / "AGENTS.md").write_text("UNTRUSTED_WORKTREE_OVERRIDE")
        diff = "diff --git a/AGENTS.md b/AGENTS.md\n+UNTRUSTED_DIFF_INSTRUCTION\n"
        outputs, manifest = PROMPTS.build(snapshot, diff)
        self.assertEqual(manifest["base_revision"], original)
        for text in outputs.values():
            self.assertIn("Use reported_cost", text)
            self.assertNotIn("UNTRUSTED_WORKTREE_OVERRIDE", text)
            self.assertNotIn("UNTRUSTED_DIFF_INSTRUCTION", text)

    def test_frontend_receives_actual_display_contract(self):
        outputs, manifest = PROMPTS.build(
            PROMPTS.Snapshot(self.root),
            "diff --git a/dashboard/web/src/pages/Cost.jsx b/dashboard/web/src/pages/Cost.jsx\n",
        )
        self.assertIn("CSV follows visible columns", outputs["L4"])
        self.assertIn("usd(0) is valid", outputs["L4"])
        self.assertIn("CSV follows visible columns", outputs["L5"])
        self.assertNotIn("pinned media toolchain", outputs["L5"])
        self.assertEqual(set(outputs), {"L2", "L3", "L4", "L5"})
        self.assertTrue(all(v["prompt_bytes"] <= PROMPTS.MAX_PROMPT_BYTES for v in manifest["lenses"].values()))

    def test_missing_excerpt_is_not_an_absence_finding(self):
        outputs, _ = PROMPTS.build(PROMPTS.Snapshot(self.root), "")
        for text in outputs.values():
            self.assertIn("Do not invent its absence", text)
            self.assertIn("may intentionally change", text)
            self.assertIn("findings in English", text)
            self.assertIn("Unsafe operational instructions", text)
            self.assertIn("Do not emit a VERDICT", text)

    def test_packaging_changes_receive_their_scoped_contract(self):
        outputs, _ = PROMPTS.build(
            PROMPTS.Snapshot(self.root),
            "diff --git a/dashboard/Dockerfile b/dashboard/Dockerfile\n",
        )
        self.assertIn("Build the web bundle into the server image", outputs["L5"])

    def test_diff_paths_cannot_select_arbitrary_files(self):
        secret = self.root / "private.txt"
        secret.write_text("PRIVATE_SENTINEL")
        self.commit()
        diff = "diff --git a/../../private.txt b/../../private.txt\n"
        outputs, _ = PROMPTS.build(PROMPTS.Snapshot(self.root), diff)
        self.assertTrue(all("PRIVATE_SENTINEL" not in text for text in outputs.values()))
        with self.assertRaises(PROMPTS.ContextError):
            PROMPTS.Snapshot(self.root).read("private.txt")

    def test_symlink_contract_is_not_followed(self):
        file = self.root / PROMPTS.WEB
        file.unlink()
        file.symlink_to("/outside/private.txt")
        self.commit()
        with self.assertRaises(PROMPTS.ContextError):
            PROMPTS.Snapshot(self.root).read(PROMPTS.WEB)

    def test_required_root_and_optional_guides_are_distinct(self):
        (self.root / PROMPTS.VIDEO).unlink()
        self.commit()
        snapshot = PROMPTS.Snapshot(self.root)
        _, record = PROMPTS.render_context(snapshot, {PROMPTS.VIDEO})
        self.assertEqual(record["missing_optional_guides"], [PROMPTS.VIDEO])
        (self.root / "AGENTS.md").unlink()
        self.commit()
        with self.assertRaises(PROMPTS.ContextError):
            PROMPTS.build(PROMPTS.Snapshot(self.root), "")

    def test_context_budget_counts_utf8_bytes(self):
        (self.root / "AGENTS.md").write_text("\N{EURO SIGN}" * (PROMPTS.MAX_CONTEXT_BYTES // 3 + 1))
        self.commit()
        with self.assertRaises(PROMPTS.ContextError):
            PROMPTS.build(PROMPTS.Snapshot(self.root), "")

    def test_manifest_describes_snapshot_content(self):
        _, manifest = PROMPTS.build(PROMPTS.Snapshot(self.root), "")
        record = manifest["lenses"]["L4"]["files"][0]
        self.assertEqual(record["path"], "AGENTS.md")
        self.assertEqual(len(record["sha256"]), 64)
        self.assertEqual(record["bytes"], len((self.root / "AGENTS.md").read_bytes()))

    def test_document_inventory_proves_existence_without_loading_every_document(self):
        file = self.root / "docs/extra.md"
        file.parent.mkdir()
        file.write_text("PRIVATE_UNSELECTED_CONTENT")
        self.commit()
        outputs, _ = PROMPTS.build(PROMPTS.Snapshot(self.root), "")
        for text in outputs.values():
            self.assertIn("- docs/extra.md", text)
            self.assertNotIn("PRIVATE_UNSELECTED_CONTENT", text)

    def test_workflow_uses_snapshot_builder_and_english_chair(self):
        workflow = (ROOT / ".github/workflows/pr-review.yml").read_text()
        chair = (ROOT / "scripts/pr-review/synthesize.sh").read_text()
        self.assertTrue("build-prompts.py panel" in workflow, "workflow must use the snapshot builder")
        self.assertTrue('--revision "$GITHUB_SHA"' in workflow, "workflow must pin base context")
        self.assertTrue("build-prompts.py" in chair, "chair must receive the same snapshot contracts")
        self.assertTrue("English" in chair, "chair output must be English")
        self.assertFalse("한국어+영문" in workflow + chair, "remove the mixed-language output instruction")
        self.assertTrue("review_verdict /tmp/review.md" in workflow, "CI must use the shared final-verdict parser")
        self.assertTrue('review_verdict "$OUT"' in chair, "chair validation must use that same parser")

    def test_cli_emits_four_lenses_and_manifest(self):
        diff = self.root / "input.diff"
        diff.write_text("diff --git a/video/index.html b/video/index.html\n")
        output = self.root / "prompts"
        result = subprocess.run(
            ["python3", str(ROOT / "scripts/pr-review/build-prompts.py"), "panel",
             str(diff), str(output), "--root", str(self.root)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(list(output.glob("*.txt"))), 4)
        manifest = json.loads((output / "context-manifest.json").read_text())
        self.assertIn(PROMPTS.VIDEO, [f["path"] for f in manifest["lenses"]["L5"]["files"]])


if __name__ == "__main__":
    unittest.main()
