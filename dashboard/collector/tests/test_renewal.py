"""Scheduled token renewal; HTTP and service managers are simulated."""
import email.message
import fcntl
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "ccd1." + "a" * 64 + "." + "b" * 32 + "." + "C" * 43
NEW = TOKEN[:-1] + "D"
ENDPOINT = "https://dashboard.example/api/ingest"


class Response:
    def __init__(self, body, status=200, kind="application/json"):
        self.status, self.body = status, body
        self.headers = email.message.Message()
        self.headers["Content-Type"] = kind

    def read(self, limit):
        return self.body[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def http_error(code):
    return urllib.error.HTTPError(ENDPOINT + "/renew", code, "fixture", email.message.Message(), io.BytesIO(b"{}"))


def renewed(token=NEW):
    return json.dumps({"renewed": True, "token": token, "expiresAt": "2026-12-13T12:00:00.000Z"}).encode()


NOT_DUE = json.dumps({"renewed": False, "expiresAt": "2026-11-20T12:00:00.000Z"}).encode()


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "install.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Renewal(unittest.TestCase):
    def setUp(self):
        self.module = load("renewal_installer")
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.root = self.home / ".local/share/ccdash-collector"
        self.unit = self.home / ".config/systemd/user/ccdash-collector.service"
        self.root.mkdir(parents=True, mode=0o700)
        self.module.atomic(self.root / "token", TOKEN + "\n")
        self.commands, self.requests, self.handlers = [], [], []
        self.outcome = None
        self.restart_error = False
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        for context in (patch.object(self.module.sys, "platform", "linux"),
                        patch.object(self.module, "run", self.external),
                        patch.object(self.module.urllib.request, "build_opener", self.opener),
                        patch("sys.stdout", self.stdout), patch("sys.stderr", self.stderr)):
            context.start()
            self.addCleanup(context.stop)

    def external(self, command, required=True, output=False):
        self.commands.append(command)
        if self.restart_error and "restart" in command:
            raise ValueError("simulated restart failure")
        return "" if output else True

    def opener(self, *handlers):
        self.handlers.extend(handlers)
        test = self

        class Opener:
            def open(self, request, timeout):
                test.requests.append((request, timeout))
                if isinstance(test.outcome, BaseException):
                    raise test.outcome
                return test.outcome
        return Opener()

    def renew(self, saved=ENDPOINT):
        return self.module.renew(self.root, self.unit, os.getuid(), {"endpoint": saved})

    def state(self):
        return json.loads((self.root / "renew-state.json").read_text())["outcome"]

    def token(self):
        return (self.root / "token").read_text()

    def test_due_renewal_writes_private_token_and_restarts_collector(self):
        self.outcome = Response(renewed())
        self.assertEqual(self.renew(), 0)
        self.assertEqual(self.token(), NEW + "\n")
        self.assertEqual((self.root / "token").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.commands, [["systemctl", "--user", "restart", "ccdash-collector.service"]])
        (request, timeout), = self.requests
        self.assertEqual(request.full_url, ENDPOINT + "/renew")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.data, b"")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(timeout, 15)
        self.assertIn(self.module.NoRedirect, self.handlers)
        self.assertEqual(self.state(), "renewed")
        state = self.root / "renew-state.json"
        self.assertEqual(state.stat().st_mode & 0o777, 0o600)
        for secret in (TOKEN, NEW, "C" * 43):
            self.assertNotIn(secret, state.read_text())
        output = self.stdout.getvalue() + self.stderr.getvalue()
        self.assertNotIn(TOKEN, output)
        self.assertNotIn(NEW, output)

    def test_not_due_response_changes_nothing(self):
        self.outcome = Response(NOT_DUE)
        self.assertEqual(self.renew(), 0)
        self.assertEqual(self.token(), TOKEN + "\n")
        self.assertEqual(self.commands, [])
        self.assertEqual(self.state(), "not_due")
        self.assertEqual(self.stdout.getvalue(), "")

    def test_rejected_token_requires_reenrollment(self):
        self.outcome = http_error(401)
        self.assertEqual(self.renew(), 2)
        self.assertEqual(self.token(), TOKEN + "\n")
        self.assertEqual(self.commands, [])
        self.assertIn("Register a new device", self.stderr.getvalue())
        self.assertEqual(self.state(), "unauthorized")

    def test_invalid_or_redirected_responses_never_replace_the_token(self):
        outcomes = [
            Response(b"not json"), Response(b'{"renewed":false,"renewed":false,"expiresAt":"x"}'),
            Response(b'{"renewed":false,"expiresAt":"x","extra":1}'),
            Response(b"[" * 4000),
            Response(b'{"renewed":true,"expiresAt":"x"}'),
            Response(renewed(TOKEN)), Response(renewed("ccd1." + "f" * 64 + "." + "b" * 32 + "." + "D" * 43)),
            Response(renewed("not-a-token")), Response(renewed(), kind="text/plain"),
            Response(renewed(), status=201), http_error(302), http_error(500),
            http.client.RemoteDisconnected("closed"), urllib.error.URLError("offline"),
            Response(NOT_DUE + b" " * 4096),
        ]
        for outcome in outcomes:
            with self.subTest(outcome=outcome):
                self.outcome = outcome
                with self.assertRaises((ValueError, OSError)):
                    self.renew()
                self.assertEqual(self.token(), TOKEN + "\n")
                self.assertEqual(self.commands, [])
                self.assertEqual(self.state(), "failed")

    def test_saved_endpoint_is_revalidated_before_each_request(self):
        self.outcome = Response(renewed())
        with self.assertRaises(ValueError):
            self.renew("http://dashboard.example/api/ingest")
        self.assertEqual((self.token(), self.requests), (TOKEN + "\n", []))

    def test_redirect_handler_never_follows(self):
        self.assertIsNone(self.module.NoRedirect().redirect_request(
            None, None, 302, "Found", {}, "https://elsewhere.example/"))

    def test_restart_failure_keeps_the_new_token_for_the_next_start(self):
        self.outcome = Response(renewed())
        self.restart_error = True
        with self.assertRaisesRegex(ValueError, "restart failure"):
            self.renew()
        self.assertEqual(self.token(), NEW + "\n")
        self.assertEqual(self.state(), "restart_failed")

    def test_running_installation_defers_renewal(self):
        lock = (self.root / ".install.lock").open("a")
        self.addCleanup(lock.close)
        fcntl.flock(lock, fcntl.LOCK_EX)
        with self.assertRaisesRegex(ValueError, "another installation"):
            self.renew()
        self.assertEqual(self.requests, [])

    def test_cli_renew_exit_codes_ignore_client_directories(self):
        self.module.atomic(self.root / "state.json", json.dumps({
            "managedBy": self.module.MARKER, "endpoint": ENDPOINT, "version": "0.163.1",
            "unit": str(self.unit), "userId": "fixture"}))
        account = SimpleNamespace(pw_dir=str(self.home), pw_name="fixture", pw_uid=os.getuid(), pw_gid=os.getgid())
        with patch.object(self.module.os, "geteuid", return_value=1000), \
                patch.object(self.module.pwd, "getpwuid", return_value=account), \
                patch.object(self.module.sys, "argv", ["install.py", "renew"]), \
                patch.dict(os.environ, {"CODEX_HOME": "/elsewhere", "CLAUDE_CONFIG_DIR": ""}):
            for outcome, code in ((http_error(401), 2), (http_error(503), 1), (Response(NOT_DUE), 0)):
                with self.subTest(code=code):
                    self.outcome = outcome
                    self.assertEqual(self.module.main(), code)

    def test_launch_agent_runs_renewal_every_six_hours(self):
        with patch.object(self.module.sys, "platform", "darwin"):
            self.assertEqual(plistlib.loads(self.module.launchd_renewal(self.root)[0]), {
                "Label": "org.ccdash.collector.renew", "Comment": self.module.MARKER,
                "ProgramArguments": [sys.executable, str(self.root / "install.py"), "renew"],
                "StartInterval": 21600, "RunAtLoad": True, "Umask": 0o077})
            self.assertEqual(self.module.renewal_locations(self.home),
                             [self.home / "Library/LaunchAgents/org.ccdash.collector.renew.plist"])


if __name__ == "__main__":
    unittest.main()
