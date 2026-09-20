"""Exercise the shell service guard without running installation or systemd."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class TelemetryShellTests(unittest.TestCase):
    def scenario(self, state, start_fails=False, stays_down=False):
        with tempfile.TemporaryDirectory(prefix="telemetry-shell-") as directory:
            temp = Path(directory)
            commands = {
                "systemctl": """#!/bin/bash
printf '%s\\n' "$*" >> "$CASE_DIR/queries"
if [[ "$1" == show ]]; then
  [[ "$CASE_STATE" != inaccessible ]] || { echo 'Failed to connect to bus' >&2; exit 1; }
  if [[ "$CASE_STATE" == missing ]]; then
    printf 'LoadState=not-found\\nActiveState=inactive\\n'
  else
    printf 'LoadState=loaded\\nActiveState=%s\\n' "$CASE_STATE"
  fi
elif [[ "$1" == is-active ]]; then
  [[ "$CASE_STATE" == active || ( -f "$CASE_DIR/started" && "$CASE_STAYS_DOWN" == 0 ) ]]
else
  exit 2
fi
""",
                "sudo": """#!/bin/bash
printf '%s\\n' "$*" >> "$CASE_DIR/privileged"
[[ "$CASE_START_FAILS" == 0 ]] || { echo 'fixture start failure' >&2; exit 1; }
touch "$CASE_DIR/started"
""",
                "sleep": "#!/bin/bash\nexit 0\n",
                "journalctl": "#!/bin/bash\nexit 0\n",
            }
            for name, text in commands.items():
                path = temp / name
                path.write_text(text)
                path.chmod(0o700)
            env = {**os.environ, "PATH": f"{temp}:{os.environ['PATH']}",
                   "CASE_DIR": str(temp), "CASE_STATE": state,
                   "CASE_START_FAILS": str(int(start_fails)), "CASE_STAYS_DOWN": str(int(stays_down)),
                   "ENABLE_FILE": str(temp / "enable.sh")}
            source = (ROOT / "scripts/ensure-otelcol.sh").read_text()
            # Contain the legacy guard's fixed temporary path during RED runs.
            source = source.replace("/tmp/otelcol-start.err", '"$CASE_DIR/legacy-start.err"')
            (temp / "enable.sh").write_text(source)
            result = subprocess.run(["bash", "--noprofile", "--norc", "-c",
                'set -e; source "$ENABLE_FILE"; printf "continued\\n"'],
                env=env, capture_output=True, text=True)
            calls = (temp / "privileged").read_text() if (temp / "privileged").exists() else ""
            return result, calls

    def test_active_transitional_and_unavailable_states_do_not_start_services(self):
        for state in ["active", "activating", "deactivating", "reloading", "inaccessible", "missing"]:
            with self.subTest(state=state):
                result, calls = self.scenario(state)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls, "")
                self.assertEqual(result.stdout, "continued\n")
                self.assertNotIn("not active", result.stderr)

    def test_confirmed_down_service_is_started(self):
        for state in ["inactive", "failed"]:
            with self.subTest(state=state):
                result, calls = self.scenario(state)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls, "systemctl start otelcol.service\n")
                self.assertIn("continued", result.stdout)

    def test_real_start_or_confirmation_failure_still_fails(self):
        for kwargs in [{"start_fails": True}, {"stays_down": True}]:
            with self.subTest(kwargs=kwargs):
                result, calls = self.scenario("inactive", **kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, "systemctl start otelcol.service\n")
                self.assertNotIn("continued", result.stdout)


if __name__ == "__main__":
    unittest.main()
