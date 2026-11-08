"""Exercise immutable preparation, real subprocesses, aggregation and synthesis."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parent
FAKE = r'''#!/usr/bin/env python3
import json,os,pathlib,sys
root = pathlib.Path(ROOT)
argv = sys.argv[1:]
name = pathlib.Path(sys.argv[0]).name
if name == "gh":
    print((root / "base-sha").read_text().strip())
    raise SystemExit(0)
stdin = sys.stdin.read()
with (root / "calls.jsonl").open("a") as stream:
    stream.write(json.dumps({"name": name, "args": argv, "stdin": stdin,
                             "home": os.environ.get("HOME"), "cwd": str(pathlib.Path.cwd())}) + "\n")
if name == "kiro-cli" and argv[0] == "settings":
    assert stdin == ""
    assert os.environ["HOME"] == str(pathlib.Path.cwd())
    assert not any(key.startswith("AWS_") or key in ("GH_TOKEN", "GITHUB_TOKEN")
                   for key in os.environ)
    setting = pathlib.Path.home() / ".kiro/fake-settings.json"
    if (root / "kiro-setting-failure").exists():
        print("Settings unavailable", file=sys.stderr)
        raise SystemExit(9)
    if argv == ["settings", "chat.disableMarkdownRendering", "true"]:
        setting.write_text("true")
    else:
        assert argv == ["settings", "chat.disableMarkdownRendering", "--format", "json"]
        print(setting.read_text() if setting.exists() else "false")
    raise SystemExit(0)
if name == "kiro-cli" and argv[1].startswith("Kiro startup safety check."):
    assert stdin == ""
    print("NO_TOOLS")
    raise SystemExit(0)
if name == "claude" and argv[1].startswith("You chair"):
    print("The supplied candidate remains a concrete regression.\nVERDICT: FAIL")
    raise SystemExit(0)
if name == "claude" and argv[1].startswith("Produce a bounded AWS"):
    assert argv[argv.index("--tools") + 1] == "" and "--setting-sources" in argv
    if (root / "summary-failure").exists():
        raise SystemExit(9)
    sys.path.insert(0, str(root / "repo/scripts/pr-review"))
    from aws_summary import units
    plan = json.loads((root / "work/role-plan.json").read_text())
    raw = (root / "work/roles/kiro-fable.diff").read_text()
    entries = []
    for unit in units(raw):
        lines = unit["source"].splitlines()
        number = next((i for i, line in enumerate(lines, 1)
                       if line.startswith(("+", "-"))), 1)
        entries.append({"id": unit["id"], "sha256": unit["sha256"],
                        "summary": "Changed AWS resource configuration.",
                        "evidence": [{"line": number, "excerpt": lines[number - 1][:80]}]})
    print(json.dumps({"head_sha": plan["head_sha"],
                     "source_sha256": plan["roles"]["kiro-fable"]["diff_sha256"],
                     "complete": True, "entries": entries, "uncertainties": []}))
    raise SystemExit(0)
model = argv[argv.index("--model") + 1]
if name == "kiro-cli":
    assert model == "claude-opus-5-5"
    tag = next(tag for tag in ("kiro-fable", "kiro-sol")
               if f"Review tag: {tag}\n" in stdin)
else:
    tag = {"global.openai.gpt-6-astra":"codex",
           "global.anthropic.claude-fable-5-1":"claude-self"}[model]
plan = json.loads((root / "work/role-plan.json").read_text())
role = plan["roles"][tag]
paths = role["paths"]
response = {"head_sha":plan["head_sha"],"role":role["role"],"scope_complete":True,
            "reviewed_paths":paths,"checks":[{"path":paths[0],"evidence":"Checked changed behavior."}],
            "findings":[],"uncertainties":[]}
if name == "kiro-cli" and (root / "literal-evidence").exists():
    response["checks"][0]["evidence"] = (root / "literal-evidence").read_text()
if (root / "major").exists() and tag == "codex":
    response["findings"] = [{"severity":"MAJOR","path":paths[0],"condition":"When the branch runs",
                            "evidence":"The changed return value loses state."}]
body = json.dumps(response)
if name == "kiro-cli":
    setting = pathlib.Path.home() / ".kiro/fake-settings.json"
    literal = setting.exists() and setting.read_text() == "true"
    if (root / "fenced-kiro").exists():
        body = "```json\n" + body + "\n```" if literal else "json\n" + body
    elif not literal:
        # Recorded native behavior: inline-code delimiters disappear in Markdown.
        body = body.replace("`", "")
if (root / "invalid-inner").exists() and tag == "codex":
    body = "Unrequested prose\n" + body
if (root / "duplicate-final").exists() and tag == "codex":
    body += "\n" + body
if (root / "trailing-final").exists() and tag == "codex":
    body += "\nTrailing prose."
if name == "codex" and "--json" in argv:
    print(json.dumps({"type":"turn.started"}))
    if (root / "progress").exists():
        print(json.dumps({"type":"item.completed","item":{
            "id":"progress","type":"agent_message","text":"I am checking the changed code."}}))
    if (root / "tool-echo").exists():
        print(json.dumps({"type":"item.completed","item":{
            "id":"tool","type":"command_execution","command":"cat README.md",
            "aggregated_output":"Monthly request limit reached\n"+json.dumps(response),
            "exit_code":0,"status":"completed"}}))
    if (root / "native-error").exists():
        print(json.dumps({"type":"error","message":"[warn] failed to set model: Method not found"}))
    if (root / "recovered-error").exists():
        print(json.dumps({"type":"error","message":"Reconnecting... stream disconnected before completion"}))
    print(json.dumps({"type":"item.completed","item":{
        "id":"reply","type":"agent_message","text":body}}))
    print(json.dumps({"type":"turn.completed","usage":{
        "input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}))
    if "--output-last-message" in argv:
        pathlib.Path(argv[argv.index("--output-last-message")+1]).write_text(body)
else:
    if (root / "tool-echo").exists() and tag == "codex":
        print("Monthly request limit reached", file=sys.stderr)
    print(body)
if (root / "failure").exists() and tag == "codex":
    raise SystemExit(9)
'''


class EndToEndRoleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.work = self.root / "work"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("codex", "kiro-cli", "claude", "gh"):
            executable = self.bin / name
            executable.write_text(FAKE.replace("ROOT", repr(str(self.root))))
            executable.chmod(0o755)
        target = self.repo / "scripts/pr-review"
        target.mkdir(parents=True)
        for source in SOURCE.iterdir():
            if source.is_file() and source.suffix in (".py", ".sh"):
                shutil.copy2(source, target / source.name)
        self.assertTrue((target / "lib.sh").exists(), "Repository scrubbers must be available")
        (self.repo / "AGENTS.md").write_text("Trusted project context: preserve data and auth.\n")
        (self.repo / "CLAUDE.md").write_text("Project source instructions.\n")
        (target / "role-input-scope.json").write_text(json.dumps({
            "schema_version": 1, "basenames": ["package-lock.json"],
            "extensions": [".png"], "directories": [], "prefixes": [],
        }))
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Review tests")
        self.git("config", "user.email", "tests@example.invalid")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").strip()
        (self.root / "base-sha").write_text(self.base)
        self.git("remote", "add", "origin", str(self.repo))
        self.environment = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.environment.update(
            BASE_SHA=self.base, GH_REPO="example/project", PANEL_RETRIES="1",
            PANEL_TIMEOUT="10", KIRO_PREFLIGHT_TIMEOUT="10",
        )
        self.environment.pop("GITHUB_ENV", None)
        self.environment.pop("ROLE_REVIEW", None)

    def git(self, *arguments):
        return subprocess.check_output(["git", *arguments], cwd=self.repo, text=True)

    def run_pipeline(self, path, content=b"export const result = 1;\n", extra_changes=None):
        changed = self.repo / path
        changed.parent.mkdir(parents=True, exist_ok=True)
        changed.write_bytes(content)
        for extra_path, extra_content in (extra_changes or {}).items():
            extra = self.repo / extra_path
            extra.parent.mkdir(parents=True, exist_ok=True)
            extra.write_bytes(extra_content)
        self.git("add", ".")
        self.git("commit", "-qm", "change")
        self.environment["HEAD_SHA"] = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-q", "--detach", self.base)
        result = subprocess.run([
            "bash", "scripts/pr-review/run-specialists.sh", "unused", "unused", str(self.work),
        ], cwd=self.repo, env=self.environment, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        result = subprocess.run([
            "python3", "scripts/pr-review/synthesize_roles.py",
            "--work", str(self.work), "--output", str(self.work / "review.md"),
        ], cwd=self.repo, env=self.environment, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.root / "calls.jsonl"
        return [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []

    def use_production_scope(self):
        target = self.repo / "scripts/pr-review/role-input-scope.json"
        target.write_bytes((SOURCE / "role-input-scope.json").read_bytes())
        self.git("add", str(target.relative_to(self.repo)))
        self.git("commit", "-qm", "production review scope")
        self.base = self.git("rev-parse", "HEAD").strip()
        (self.root / "base-sha").write_text(self.base)
        self.environment["BASE_SHA"] = self.base

    def test_production_lockfile_change_receives_independent_reviews(self):
        self.use_production_scope()
        calls = self.run_pipeline("dashboard/server/package-lock.json", b'{"version": "1.2.3"}\n')
        self.assertTrue({"codex", "claude"}.issubset({call["name"] for call in calls}))
        source = json.loads((self.work / "role-source.json").read_text())
        self.assertEqual(source["excluded_paths"], [])
        self.assertIn("dashboard/server/package-lock.json", source["scope_paths"])
        self.assertIn('"version": "1.2.3"', (self.work / "role-diff.txt").read_text())
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_production_oversized_lockfile_is_blocked_without_model_calls(self):
        self.use_production_scope()
        calls = self.run_pipeline("dashboard/server/package-lock.json", b"x" * 512001 + b"\n")
        self.assertEqual(calls, [])
        self.assertIn("diff_byte_limit", (self.work / "review.md").read_text())
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_production_binary_change_is_blocked_without_model_calls(self):
        self.use_production_scope()
        calls = self.run_pipeline("assets/example.png", b"\x00\x01\x02binary")
        self.assertEqual(calls, [])
        source = json.loads((self.work / "role-source.json").read_text())
        self.assertEqual(source["excluded_paths"], [])
        self.assertIn("binary_content_not_reviewable", (self.work / "review.md").read_text())
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_frontend_uses_two_reviews_and_no_chair(self):
        calls = self.run_pipeline("frontend/components/Button.tsx")
        self.assertEqual(sorted(call["name"] for call in calls), ["claude", "codex"])
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_large_aws_change_uses_one_summary_and_two_bounded_v3_reviews(self):
        self.environment["PYTHONPATH"] = str(SOURCE)
        raw = b'resource "aws_vpc" "main" {}\n' + b"# long description " + b"x" * 150000 + b"\n"
        calls = self.run_pipeline("infra/network.tf", raw)
        chairs = [call for call in calls if call["name"] == "claude"
                  and call["args"][1].startswith("Produce a bounded AWS")]
        self.assertEqual(len(chairs), 1)
        self.assertIn("x" * 150000, chairs[0]["stdin"])
        for call in calls:
            if call["name"] == "kiro-cli" and call["stdin"]:
                self.assertLess(len(call["stdin"].encode()), 120000)
                self.assertIn("Changed AWS resource configuration", call["stdin"])
                self.assertNotIn("x" * 1000, call["stdin"])
            elif call["name"] in {"claude", "codex"} and call not in chairs:
                self.assertIn("x" * 150000, call["stdin"])
        self.assertIn("chair_summary", (self.work / "review.md").read_text())
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_large_aws_summary_failure_blocks_without_delivering_kiro_input(self):
        self.environment["PYTHONPATH"] = str(SOURCE)
        (self.root / "summary-failure").touch()
        calls = self.run_pipeline("infra/network.tf", b"# " + b"x" * 100000 + b"\n")
        self.assertFalse(any(call["name"] == "kiro-cli" for call in calls))
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_property_only_patch_retains_source_resource_identity(self):
        source = self.repo / "lib/arbitrary.py"
        source.parent.mkdir()
        prefix = "from aws_cdk import Stack\n\ndef unrelated():\n    pass\n\n" + "# unchanged\n" * 30
        source.write_text(prefix + "memory = 128\n")
        self.git("add", ".")
        self.git("commit", "-qm", "existing stack")
        self.base = self.git("rev-parse", "HEAD").strip()
        (self.root / "base-sha").write_text(self.base)
        self.environment["BASE_SHA"] = self.base
        calls = self.run_pipeline("lib/arbitrary.py", (prefix + "memory = 256\n").encode())
        self.assertEqual(sum(call["name"] == "kiro-cli" and bool(call["stdin"])
                             for call in calls), 2)
        self.assertNotIn("aws_cdk", (self.work / "roles/kiro-fable.diff").read_text())

    def test_aws_change_uses_four_reviews_and_two_safety_checks(self):
        calls = self.run_pipeline("infra/network.tf")
        model_calls = [call for call in calls if call["args"][0] != "settings"]
        self.assertEqual(len(model_calls), 6)
        self.assertEqual(sum(call["name"] == "kiro-cli" for call in model_calls), 4)
        kiro = [call for call in calls if call["name"] == "kiro-cli"]
        homes = {call["home"] for call in kiro}
        self.assertEqual(len(homes), 2)
        for home in homes:
            cell = [call for call in kiro if call["home"] == home]
            self.assertEqual([call["args"][0] for call in cell],
                             ["settings", "settings", "chat", "chat"])
            self.assertEqual(cell[0]["args"],
                             ["settings", "chat.disableMarkdownRendering", "true"])
            self.assertEqual(cell[1]["args"],
                             ["settings", "chat.disableMarkdownRendering", "--format", "json"])
            self.assertTrue(all(call["cwd"] == home for call in cell))
            self.assertTrue(all(call["stdin"] == "" for call in cell[:3]))
            for call in cell[2:]:
                self.assertEqual(call["args"][call["args"].index("--model") + 1],
                                 "claude-opus-5-5")
            self.assertIn("preflight-canary.txt", cell[2]["args"][1])
            self.assertIn("BEGIN DIFF ", cell[3]["stdin"])
            self.assertNotIn("BEGIN DIFF ", " ".join(cell[3]["args"]))
            self.assertEqual(cell[3]["args"][-2:], ["--agent-engine", "v3"])
            self.assertFalse(Path(home).exists())
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))
        plan = json.loads((self.work / "role-plan.json").read_text())
        self.assertEqual({plan["roles"][tag]["role"] for tag in ("kiro-fable", "kiro-sol")},
                         {"aws", "deployment"})
        self.assertTrue(all(plan["roles"][tag]["family"] == "Anthropic"
                            for tag in ("kiro-fable", "kiro-sol")))

    def test_mixed_change_passes_only_resource_patches_to_kiro_processes(self):
        calls = self.run_pipeline(
            "dashboard/server/chat.js", b'const model = "bedrock";\n',
            {"infra/network.tf": b'resource "aws_vpc" "main" {}\n'},
        )
        kiro_reviews = [call for call in calls
                        if call["name"] == "kiro-cli" and "BEGIN DIFF " in call["stdin"]]
        self.assertEqual(len(kiro_reviews), 2)
        for call in calls:
            if call["name"] == "kiro-cli" and "BEGIN DIFF " in call["stdin"]:
                self.assertIn("infra/network.tf", call["stdin"])
                self.assertNotIn("dashboard/server/chat.js", call["stdin"])
                self.assertNotIn('const model = "bedrock"', call["stdin"])
            elif call["name"] in {"codex", "claude"}:
                self.assertIn("dashboard/server/chat.js", call["stdin"])
                self.assertIn("infra/network.tf", call["stdin"])
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_large_application_change_uses_only_stdin_reviewers(self):
        calls = self.run_pipeline("dashboard/server/large.js", b"x" * 150000 + b"\n")
        self.assertEqual(sorted(call["name"] for call in calls), ["claude", "codex"])
        for call in calls:
            self.assertIn("x" * 150000, call["stdin"])
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def assert_kiro_literals_preserved(self, fenced):
        literal = 'Checked `tag` with "quotes", C:\\tmp\\probe, &quot; &amp; &lt; &#34;.'
        (self.root / "literal-evidence").write_text(literal)
        if fenced:
            (self.root / "fenced-kiro").touch()
        self.run_pipeline("infra/network.tf")
        for tag in ("kiro-fable", "kiro-sol"):
            result = json.loads((self.work / "slot" / f"{tag}-result.json").read_text())
            self.assertTrue(result["valid"], result["failure_codes"])
            self.assertEqual(result["response"]["checks"][0]["evidence"], literal)
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_raw_kiro_json_preserves_literal_review_evidence(self):
        self.assert_kiro_literals_preserved(False)

    def test_fenced_kiro_json_preserves_literal_review_evidence(self):
        self.assert_kiro_literals_preserved(True)

    def test_settings_failure_blocks_coverage_without_a_kiro_model_request(self):
        (self.root / "kiro-setting-failure").touch()
        calls = self.run_pipeline("infra/network.tf")
        kiro = [call for call in calls if call["name"] == "kiro-cli"]
        # A nonzero settings exit without a safety signal is retried once per role.
        self.assertEqual(len(kiro), 4)
        self.assertTrue(all(call["args"][0] == "settings" for call in kiro))
        for tag in ("kiro-fable", "kiro-sol"):
            self.assertTrue((self.work / "slot" / f"kiro-preflight-{tag}.flag").exists())
            result = json.loads((self.work / "slot" / f"{tag}-result.json").read_text())
            self.assertFalse(result["valid"])
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_nonzero_output_blocks_without_chair_override(self):
        (self.root / "failure").touch()
        calls = self.run_pipeline("frontend/components/Button.tsx")
        self.assertEqual(len(calls), 2)
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_major_candidate_adds_exactly_one_chair_call(self):
        (self.root / "major").touch()
        calls = self.run_pipeline("frontend/components/Button.tsx")
        self.assertEqual(len(calls), 3)
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_codex_tool_echo_does_not_block_complete_review(self):
        (self.root / "tool-echo").touch()
        calls = self.run_pipeline("frontend/components/Button.tsx")
        self.assertEqual(len(calls), 2)
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_codex_native_error_blocks_otherwise_valid_review(self):
        (self.root / "native-error").touch()
        calls = self.run_pipeline("frontend/components/Button.tsx")
        self.assertEqual(len(calls), 2)
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_codex_recovered_stream_error_keeps_complete_review(self):
        (self.root / "recovered-error").touch()
        calls = self.run_pipeline("frontend/components/Button.tsx")
        self.assertEqual(len(calls), 2)
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_codex_inner_json_validation_remains_strict(self):
        (self.root / "invalid-inner").touch()
        self.run_pipeline("frontend/components/Button.tsx")
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_codex_progress_does_not_contaminate_cli_designated_final_reply(self):
        (self.root / "progress").touch()
        calls = self.run_pipeline("frontend/components/Button.tsx")
        self.assertEqual(len(calls), 2)
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_duplicate_json_inside_codex_final_reply_remains_invalid(self):
        (self.root / "duplicate-final").touch()
        self.run_pipeline("frontend/components/Button.tsx")
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_trailing_prose_inside_codex_final_reply_remains_invalid(self):
        (self.root / "trailing-final").touch()
        self.run_pipeline("frontend/components/Button.tsx")
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_approved_asset_only_scope_skips_models_without_losing_provenance(self):
        calls = self.run_pipeline("frontend/public/icon.png")
        self.assertEqual(calls, [])
        source = json.loads((self.work / "role-source.json").read_text())
        self.assertEqual(source["excluded_paths"], ["frontend/public/icon.png"])
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_approved_lockfile_only_scope_skips_models(self):
        self.assertEqual(self.run_pipeline("frontend/package-lock.json"), [])


if __name__ == "__main__":
    unittest.main()
