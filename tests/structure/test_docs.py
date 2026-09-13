import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("doc_checker", ROOT / "scripts/check-docs.py")
DOCS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DOCS)


class DocumentationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return name

    def test_local_links_anchors_and_bridge(self):
        files = [
            self.write("AGENTS.md", "# Instructions\n"),
            self.write("CLAUDE.md", "# Claude\n\n@AGENTS.md\n"),
            self.write("docs/page.md", "# Page\n\n## Data contract\n"),
            self.write("README.md", "[Data](docs/page.md#data-contract)\n"),
        ]
        errors, summary = DOCS.check(self.root, files)
        self.assertEqual(errors, [])
        self.assertEqual(summary["local_links"], 1)

    def test_hangul_and_unlabeled_fence_are_rejected(self):
        file = self.write("README.md", "# \uac00\n\n```\nvalue\n```\n")
        errors, _ = DOCS.check(self.root, [file])
        self.assertTrue(any("English" in error for error in errors))
        self.assertTrue(any("language" in error for error in errors))

    def test_missing_target_and_anchor_are_reported(self):
        page = self.write("page.md", "# Existing\n")
        readme = self.write("README.md", "[Missing](absent.md)\n[Anchor](page.md#absent)\n")
        errors, _ = DOCS.check(self.root, [page, readme])
        self.assertEqual(len(errors), 2)

    def test_code_examples_are_not_treated_as_navigation(self):
        file = self.write("README.md", "```markdown\n[Example](not-a-real-file.md)\n```\n")
        self.assertEqual(DOCS.check(self.root, [file])[0], [])

    def test_bridge_cannot_duplicate_guidance_or_omit_its_owner(self):
        file = self.write("CLAUDE.md", "# Instructions\nRun a different policy.\n")
        errors, _ = DOCS.check(self.root, [file])
        self.assertTrue(any("thin import" in error for error in errors))

    def test_bridge_cannot_hide_extra_guidance_in_fences_or_headings(self):
        self.write("AGENTS.md", "# Instructions\n")
        for extra in ("```text\nUse another policy.\n```\n", "## Use another policy\n"):
            with self.subTest(extra=extra):
                file = self.write("CLAUDE.md", "# Claude\n\n@AGENTS.md\n\n" + extra)
                errors, _ = DOCS.check(self.root, [file])
                self.assertTrue(any("thin import" in error for error in errors))

    def test_oversized_agent_guidance_and_unclosed_fence_fail(self):
        files = [
            self.write("AGENTS.md", "x" * 6001),
            self.write("README.md", "```bash\ntrue\n"),
        ]
        self.assertEqual(len(DOCS.check(self.root, files)[0]), 2)

    def test_relative_links_cannot_leave_repository(self):
        file = self.write("README.md", "[Outside](../private.md)\n")
        self.assertTrue(any("leaves repository" in e for e in DOCS.check(self.root, [file])[0]))


if __name__ == "__main__":
    unittest.main()
