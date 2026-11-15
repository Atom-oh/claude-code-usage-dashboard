"""Tie the saved browser verification to the exact guide HTML it exercised."""

import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class LocalizedGuideEvidenceTests(unittest.TestCase):
    def test_browser_evidence_matches_all_current_guide_pages(self):
        names = ("index", "user-guide", "installation", "architecture", "api", "operations", "credits")
        paths = []
        for prefix in ("", "ko/", "ja/", "zh/", "es/"):
            for name in names:
                paths.append("assets/credits.html" if not prefix and name == "credits"
                             else f"{prefix}{name}.html")
        records = []
        for name in sorted(paths):
            digest = hashlib.sha256((ROOT / "site" / name).read_bytes()).hexdigest()
            records.append(f"{name}:{digest}")
        evidence = json.loads((ROOT / "scripts/docs-capture/localized-browser-evidence.json").read_text())
        self.assertEqual(evidence["siteHtmlSha256"], hashlib.sha256("\n".join(records).encode()).hexdigest())
        script = (ROOT / "scripts/docs-capture/verify-localized-guides.mjs").read_bytes()
        self.assertEqual(evidence["scriptSha256"], hashlib.sha256(script).hexdigest())
        self.assertEqual((evidence["pages"], evidence["viewers"], evidence["videos"]), (70, 10, 10))
        self.assertEqual(evidence["errors"], [])


if __name__ == "__main__":
    unittest.main()
