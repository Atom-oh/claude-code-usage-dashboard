"""Browser enrollment helper; the dashboard, browser and installer are simulated."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
ENDPOINT = "https://dashboard.example/api/ingest"
HANDLE = "a" * 32
POLL = "cce1." + HANDLE + "." + "P" * 43
OWNER = "b" * 64
DEVICE = "c" * 32


def load():
    spec = importlib.util.spec_from_file_location("enroll_helper", ROOT / "enroll.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def archive(entries):
    """entries: (name, bytes | None for a directory | 'symlink')."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            if data is None:
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
            elif data == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = "/etc/passwd"
                tar.addfile(info)
            else:
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


PACKAGE = archive([("ccdash-collector/install.py", b"# installer\n"), ("ccdash-collector/platform", b"linux\n")])
STARTED = {"verificationUrl": "https://dashboard.example/collector/connect/" + HANDLE, "code": "BCDF-GHJK",
           "pollToken": POLL, "interval": 5, "expiresAt": "2026-11-14T10:00:00.000Z"}


def json_reply(status, body, headers=None):
    return status, headers or {}, json.dumps(body).encode()


class Dashboard:
    """Scripted responses per path; records every request."""

    def __init__(self, polls, package=PACKAGE, approved=None):
        self.polls = list(polls)
        self.package = package
        self.requests = []
        self.approved = approved or {"status": "approved", "owner": OWNER, "id": DEVICE,
                                     "userId": "alice@example.com",
                                     "packageSha256": hashlib.sha256(package).hexdigest()}

    def __call__(self, method, url, headers=None, body=None, limit=None):
        self.requests.append((method, url, headers or {}, body))
        path = url[len(ENDPOINT):]
        if path == "/enroll/start":
            return json_reply(201, STARTED)
        if path == "/enroll/poll":
            reply = self.polls.pop(0) if self.polls else "approved"
            return json_reply(200, self.approved) if reply == "approved" else reply
        if path == "/package/linux":
            return 200, {}, self.package
        raise AssertionError("unexpected request " + url)


class Enrollment(unittest.TestCase):
    def setUp(self):
        self.module = load()
        self.sleeps = []
        self.output = []
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patcher = patch.object(self.module.tempfile, "tempdir", self.temp.name)
        patcher.start()
        self.addCleanup(patcher.stop)

    def args(self, **overrides):
        values = {"endpoint": ENDPOINT, "platform": "linux", "user_id": None, "name": "EC2 dev"}
        values.update(overrides)
        return SimpleNamespace(**values)

    def run_enroll(self, dashboard, status=0, **overrides):
        seen = {}

        def installer(command):
            token_file = command[command.index("--token-file") + 1]
            seen["command"] = command
            seen["mode"] = stat.S_IMODE(os.stat(token_file).st_mode)
            seen["token"] = Path(token_file).read_text()
            seen["work"] = Path(token_file).parent
            return status

        result = self.module.enroll(self.args(**overrides), http=dashboard, sleep=self.sleeps.append,
                                    run=installer, browser=lambda url, platform: False, out=self.output.append)
        return result, seen

    def test_approval_installs_with_a_private_token_built_from_the_local_secret(self):
        dashboard = Dashboard([json_reply(200, {"status": "pending", "interval": 5}), "approved"])
        result, seen = self.run_enroll(dashboard)
        self.assertEqual(result, 0)
        start = json.loads(dashboard.requests[0][3])
        self.assertEqual(start["platform"], "linux")
        self.assertEqual(start["name"], "EC2 dev")
        secret = seen["token"].strip().split(".")[3]
        self.assertEqual(hashlib.sha256(secret.encode()).hexdigest(), start["secretHash"])
        self.assertEqual(seen["token"], "ccd1.%s.%s.%s\n" % (OWNER, DEVICE, secret))
        self.assertEqual(seen["mode"], 0o600)
        command = seen["command"]
        self.assertEqual(command[1:4], ["-I", command[2], "install"])
        self.assertTrue(command[2].endswith("ccdash-collector/install.py"))
        self.assertEqual(command[command.index("--default-user-id") + 1], "alice@example.com")
        self.assertNotIn("--user-id", command)
        self.assertFalse(seen["work"].exists(), "temporary token and package are removed")
        polls = [request for request in dashboard.requests if request[1].endswith("/enroll/poll")]
        self.assertTrue(all(request[2] == {"Authorization": "Bearer " + POLL} for request in polls))
        package = [request for request in dashboard.requests if request[1].endswith("/package/linux")][0]
        self.assertEqual(package[2], {"Authorization": "Bearer " + seen["token"].strip()})
        self.assertTrue(all(delay >= 5 for delay in self.sleeps))
        text = "\n".join(self.output)
        self.assertIn("BCDF-GHJK", text)
        self.assertIn(STARTED["verificationUrl"], text)
        for secret_value in (secret, POLL, "P" * 43):
            self.assertNotIn(secret_value, text)
        for command_part in command:
            self.assertNotIn(secret, command_part)

    def test_user_id_override_replaces_the_approved_default(self):
        _, seen = self.run_enroll(Dashboard(["approved"]), user_id="bob@example.com")
        self.assertEqual(seen["command"][seen["command"].index("--user-id") + 1], "bob@example.com")
        self.assertNotIn("--default-user-id", seen["command"])

    def test_without_a_verified_email_the_installer_keeps_its_own_default(self):
        dashboard = Dashboard(["approved"])
        dashboard.approved["userId"] = None
        _, seen = self.run_enroll(dashboard)
        self.assertNotIn("--default-user-id", seen["command"])
        dashboard = Dashboard(["approved"])
        dashboard.approved["userId"] = "bad value; rm"
        _, seen = self.run_enroll(dashboard)
        self.assertNotIn("--default-user-id", seen["command"])

    def test_failed_installation_explains_the_registered_device(self):
        result, seen = self.run_enroll(Dashboard(["approved"]), status=3)
        self.assertEqual(result, 3)
        self.assertIn("해지", self.output[-1])
        self.assertFalse(seen["work"].exists())

    def test_denial_expiry_revocation_and_invalid_requests_stop_without_installing(self):
        for reply, message in [
            (json_reply(403, {"error": "enrollment_denied"}), "거부"),
            (json_reply(410, {"error": "enrollment_expired"}), "10분"),
            (json_reply(410, {"error": "device_revoked"}), "해지"),
            (json_reply(401, {"error": "invalid_enrollment"}), "유효하지 않습니다"),
        ]:
            with self.subTest(message=message):
                dashboard = Dashboard([reply])
                with self.assertRaisesRegex(self.module.EnrollmentError, message):
                    self.run_enroll(dashboard)
                self.assertFalse(any(request[1].endswith("/package/linux") for request in dashboard.requests))
        self.assertEqual(os.listdir(self.temp.name), [])

    def test_transient_failures_and_throttling_back_off_until_approval(self):
        dashboard = Dashboard([(0, {}, b""), json_reply(503, {"error": "store_unavailable"}),
                               json_reply(429, {"error": "poll_rate_limited"}, {"Retry-After": "10"}), "approved"])
        result, _ = self.run_enroll(dashboard)
        self.assertEqual(result, 0)
        self.assertEqual(self.sleeps, [5, 10, 20, 10])

    def test_polling_stops_at_the_local_deadline(self):
        clock = iter(range(0, 10000, 100)).__next__
        replies = [json_reply(200, {"status": "pending"})] * 100
        with self.assertRaisesRegex(self.module.EnrollmentError, "10분"):
            self.module.wait_for_approval(ENDPOINT, POLL, 5, 630, http=Dashboard(replies), sleep=lambda _: None,
                                          clock=clock)

    def test_package_hash_and_archive_shape_are_verified_before_installing(self):
        dashboard = Dashboard(["approved"])
        dashboard.approved["packageSha256"] = "0" * 64
        with self.assertRaisesRegex(self.module.EnrollmentError, "패키지 버전"):
            self.run_enroll(dashboard)
        dashboard = Dashboard(["approved"])
        dashboard.approved["packageSha256"] = None
        with self.assertRaisesRegex(self.module.EnrollmentError, "무결성"):
            self.run_enroll(dashboard)
        for entries in [
            [("ccdash-collector/../escape.py", b"x")],
            [("/ccdash-collector/install.py", b"x")],
            [("other/install.py", b"x")],
            [("ccdash-collector/install.py", "symlink")],
            [("ccdash-collector/x%d" % i, b"x") for i in range(65)],
            [("ccdash-collector/README.md", b"no installer")],
        ]:
            with self.subTest(entries=entries[0][0]):
                package = archive(entries)
                with self.assertRaises(self.module.EnrollmentError):
                    self.run_enroll(Dashboard(["approved"], package=package))
        self.assertEqual(os.listdir(self.temp.name), [])
        directory = tempfile.mkdtemp(dir=self.temp.name)
        installer = self.module.extract_package(archive([("ccdash-collector", None),
                                                         ("ccdash-collector/install.py", b"#!\n")]), directory)
        self.assertEqual(stat.S_IMODE(os.stat(installer).st_mode), 0o700)

    def test_start_rejects_foreign_links_and_reports_unsupported_dashboards(self):
        def reply(status, body):
            return lambda *args, **kwargs: json_reply(status, body)
        foreign = dict(STARTED, verificationUrl="https://evil.example/collector/connect/" + HANDLE)
        with self.assertRaisesRegex(self.module.EnrollmentError, "형식"):
            self.module.start(ENDPOINT, "linux", "d" * 64, "Mac", http=reply(201, foreign), sleep=lambda _: None)
        with self.assertRaisesRegex(self.module.EnrollmentError, "--token"):
            self.module.start(ENDPOINT, "linux", "d" * 64, "Mac", http=reply(404, {}), sleep=lambda _: None)
        sleeps = []
        with self.assertRaisesRegex(self.module.EnrollmentError, "연결하지 못했습니다"):
            self.module.start(ENDPOINT, "linux", "d" * 64, "Mac", http=reply(429, {}), sleep=sleeps.append)
        self.assertEqual(len(sleeps), 4)

    def test_browser_opens_only_with_a_desktop(self):
        calls = []
        run = lambda command, **kwargs: calls.append(command)
        self.assertTrue(self.module.open_browser("https://x/c", "darwin", run=run))
        self.assertFalse(self.module.open_browser("https://x/c", "linux", run=run, which=lambda _: "/usr/bin/xdg-open",
                                                  env={}))
        self.assertTrue(self.module.open_browser("https://x/c", "linux", run=run, which=lambda _: "/usr/bin/xdg-open",
                                                 env={"DISPLAY": ":0"}))
        self.assertEqual(calls, [["open", "https://x/c"], ["xdg-open", "https://x/c"]])

    def test_redirects_are_refused(self):
        with self.assertRaises(self.module.EnrollmentError):
            self.module.NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://elsewhere/")

    def test_main_validates_arguments_and_refuses_root(self):
        with patch("sys.stderr", io.StringIO()) as error:
            self.assertEqual(self.module.main(["--endpoint", "http://dashboard.example/api/ingest",
                                               "--platform", "linux"]), 1)
            self.assertEqual(self.module.main(["--endpoint", ENDPOINT, "--platform", "linux",
                                               "--user-id", "bad id"]), 1)
            with patch.object(self.module.os, "geteuid", return_value=0):
                self.assertEqual(self.module.main(["--endpoint", ENDPOINT, "--platform", "linux"]), 1)
        self.assertIn("sudo", error.getvalue())


if __name__ == "__main__":
    unittest.main()
