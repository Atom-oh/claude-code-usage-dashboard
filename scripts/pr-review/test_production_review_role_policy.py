"""Production CI must select the complete, fail-closed specialist protocol."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ProductionWorkflowTests(unittest.TestCase):
    def test_workflow_runs_required_specialists_and_collects_all_paths(self):
        source = (ROOT / ".github/workflows/pr-review.yml").read_text()
        self.assertRegex(source, r'(?m)^  ROLE_REVIEW: "1"$')
        start = source.index("      - name: Get PR diff")
        end = source.index("      - name: Build lens prompts", start)
        collection = source[start:end]
        self.assertIn("--no-renames", collection)
        self.assertIn("--no-ext-diff", collection)
        self.assertIn("--no-textconv", collection)
        self.assertNotIn(":(glob,exclude)", collection)
        self.assertNotIn("checkout", "\n".join(
            line for line in collection.splitlines() if not line.lstrip().startswith("#")
        ))


if __name__ == "__main__":
    unittest.main()
