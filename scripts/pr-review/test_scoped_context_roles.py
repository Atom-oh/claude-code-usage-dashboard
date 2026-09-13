"""Retain BASE module context and existing context budgets during activation."""

import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent


class ScopedContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        scripts = self.root / "scripts/pr-review"
        scripts.mkdir(parents=True)
        for name in ("build-prompts.py", "prepare_context_roles.py"):
            shutil.copyfile(HERE / name, scripts / name)
        for name, text in {
            "AGENTS.md": "Root BASE contract.",
            "dashboard/server/AGENTS.md": "BASE query and counter invariants.",
            "dashboard/web/AGENTS.md": "BASE React rendering contract.",
        }.items():
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(text)
        self.git("init", "-q")
        self.git("config", "user.name", "Context test")
        self.git("config", "user.email", "context@example.invalid")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").strip()
        spec = importlib.util.spec_from_file_location("scoped_context_test", scripts / "prepare_context_roles.py")
        self.adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.adapter)

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], text=True)

    def test_server_diff_receives_base_module_contract_not_candidate_text(self):
        file = self.root / "dashboard/server/AGENTS.md"
        file.write_text("UNTRUSTED candidate instructions.")
        self.git("add", ".")
        self.git("commit", "-qm", "candidate")
        head = self.git("rev-parse", "HEAD").strip()
        context, manifest, cap = self.adapter.prepare(head, self.base, ["dashboard/server/app.py"], "", 24000)
        self.assertIn("BASE query and counter invariants", context)
        self.assertNotIn("UNTRUSTED", context)
        self.assertEqual(20000, cap)
        self.assertIn("dashboard/server/AGENTS.md", [x["path"] for x in manifest["files"]])

    def test_candidate_oversized_module_guide_blocks_before_activation(self):
        (self.root / "dashboard/web/AGENTS.md").write_text("x" * 20001)
        self.git("add", ".")
        self.git("commit", "-qm", "oversized candidate")
        with self.assertRaisesRegex(ValueError, "budget"):
            self.adapter.prepare(self.git("rev-parse", "HEAD").strip(), self.base,
                                 ["dashboard/web/app.tsx"], "", 24000)

    def test_working_tree_context_builder_cannot_replace_base_code(self):
        (self.root / "scripts/pr-review/build-prompts.py").write_text("raise RuntimeError('untrusted')\n")
        with self.assertRaisesRegex(ValueError, "trusted base"):
            self.adapter.prepare(self.base, self.base, ["dashboard/server/app.py"], "", 24000)
