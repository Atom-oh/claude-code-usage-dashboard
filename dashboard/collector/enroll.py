#!/usr/bin/env python3
"""Connect this device to a ccdash dashboard through browser SSO, then run the Collector installer.

Served by the dashboard at /api/ingest/enroll.py and pinned by digest in install.sh. The device
secret and the polling credential stay in this process; the browser only sees a lookup link and
a confirmation code. Run through the dashboard's install command, not directly.
"""
import argparse
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

MAX_JSON = 16 * 1024
MAX_PACKAGE = 16 * 1024 * 1024
MAX_MEMBERS = 64
TIMEOUT = 20
HEX32 = re.compile(r"[a-f0-9]{32}")
HEX64 = re.compile(r"[a-f0-9]{64}")
USER_ID = re.compile(r"[A-Za-z0-9._+@-]{1,254}")
CODE = re.compile(r"[A-Z]{4}-[A-Z]{4}")
POLL_TOKEN = re.compile(r"cce1\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}")
PACKAGE_ROOT = "ccdash-collector"


class EnrollmentError(Exception):
    """A user-facing failure; the message never contains a credential."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise EnrollmentError("대시보드가 다른 주소로 이동시켰습니다. 대시보드 주소를 확인하세요.")


OPENER = urllib.request.build_opener(NoRedirect)


def fetch(method, url, headers=None, body=None, limit=MAX_JSON):
    """HTTPS request with verified TLS, no redirects and a bounded response: (status, headers, bytes)."""
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        response = OPENER.open(request, timeout=TIMEOUT)
    except urllib.error.HTTPError as error:
        response = error
    except (urllib.error.URLError, OSError):
        return 0, {}, b""
    status = getattr(response, "status", None) or getattr(response, "code", 0)
    try:
        data = response.read(limit + 1)
    except (OSError, AttributeError, ValueError):
        return 0, {}, b""
    finally:
        response.close()
    if len(data) > limit:
        raise EnrollmentError("대시보드 응답이 너무 큽니다.")
    return status, dict(response.headers or {}), data


def parse_json(data):
    try:
        value = json.loads(data.decode("utf-8"))
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def device_name():
    name = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", socket.gethostname() or "").strip()
    return name[:64] or "ccdash device"


def retry_after(headers, fallback):
    try:
        return min(max(int(headers.get("Retry-After", fallback)), 5), 60)
    except ValueError:
        return fallback


def start(endpoint, platform, secret_hash, name, http=fetch, sleep=time.sleep):
    body = json.dumps({"secretHash": secret_hash, "name": name, "platform": platform}).encode()
    for attempt in range(4):
        status, headers, data = http("POST", endpoint + "/enroll/start",
                                     {"Content-Type": "application/json"}, body)
        reply = parse_json(data)
        if status == 201:
            if (not isinstance(reply.get("verificationUrl"), str)
                    or not reply["verificationUrl"].startswith(endpoint.rsplit("/api/ingest", 1)[0] + "/")
                    or not isinstance(reply.get("code"), str) or not CODE.fullmatch(reply["code"])
                    or not isinstance(reply.get("pollToken"), str) or not POLL_TOKEN.fullmatch(reply["pollToken"])):
                raise EnrollmentError("대시보드 응답 형식이 올바르지 않습니다.")
            return reply
        if status == 404:
            raise EnrollmentError("이 대시보드는 브라우저 승인을 지원하지 않습니다. 토큰 설치(--token)를 사용하세요.")
        if status not in (0, 429) and status < 500:
            raise EnrollmentError("설치 요청이 거부되었습니다. 대시보드 수집기 설정을 확인하세요.")
        sleep(retry_after(headers, 5 * (attempt + 1)))
    raise EnrollmentError("대시보드에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 실행하세요.")


def open_browser(url, platform, run=subprocess.Popen, which=shutil.which, env=os.environ):
    """Best effort. Headless hosts (SSH, EC2) only print the link for another computer's browser."""
    if platform == "darwin":
        command = ["open", url]
    elif (env.get("DISPLAY") or env.get("WAYLAND_DISPLAY")) and which("xdg-open"):
        command = ["xdg-open", url]
    else:
        return False
    try:
        run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except OSError:
        return False


def wait_for_approval(endpoint, poll_token, interval, lifetime, http=fetch, sleep=time.sleep, clock=time.monotonic):
    deadline = clock() + lifetime
    delay = max(5, interval)
    failures = 0
    while clock() < deadline:
        sleep(delay)
        status, headers, data = http("POST", endpoint + "/enroll/poll", {"Authorization": "Bearer " + poll_token})
        reply = parse_json(data)
        error = reply.get("error")
        if status == 200 and reply.get("status") == "approved":
            return reply
        if status == 200 and reply.get("status") == "pending":
            failures = 0
            delay = max(5, interval)
            continue
        if status == 403 or error == "enrollment_denied":
            raise EnrollmentError("브라우저에서 연결을 거부했습니다. 기기는 등록되지 않았습니다.")
        if error == "device_revoked":
            raise EnrollmentError("승인된 기기가 이미 해지되었습니다. 설치 명령을 다시 실행하세요.")
        if status == 410:
            break
        if status == 401:
            raise EnrollmentError("설치 요청이 유효하지 않습니다. 설치 명령을 다시 실행하세요.")
        failures += 1
        delay = retry_after(headers, min(5 * 2 ** failures, 30))
    raise EnrollmentError("승인 시간(10분)이 지났습니다. 설치 명령을 다시 실행하세요.")


def approved_identity(reply, user_id_override):
    owner, device, digest = reply.get("owner"), reply.get("id"), reply.get("packageSha256")
    if not (isinstance(owner, str) and HEX64.fullmatch(owner) and isinstance(device, str) and HEX32.fullmatch(device)):
        raise EnrollmentError("대시보드 승인 응답 형식이 올바르지 않습니다.")
    if not (isinstance(digest, str) and HEX64.fullmatch(digest)):
        raise EnrollmentError("패키지 무결성 정보를 받지 못했습니다. 잠시 후 다시 실행하세요.")
    user_id = reply.get("userId")
    if user_id is not None and not (isinstance(user_id, str) and USER_ID.fullmatch(user_id)):
        user_id = None
    return owner, device, digest, None if user_id_override else user_id


def download_package(endpoint, platform, token, expected, http=fetch, sleep=time.sleep):
    for _attempt in range(4):
        status, headers, data = http("GET", endpoint + "/package/" + platform,
                                     {"Authorization": "Bearer " + token}, limit=MAX_PACKAGE)
        if status != 429:
            break
        if parse_json(data).get("error") != "ingest_busy":
            raise EnrollmentError("패키지 다운로드 한도를 넘었습니다. 1시간 뒤 다시 실행하세요.")
        sleep(retry_after(headers, 5))
    else:
        raise EnrollmentError("대시보드가 바쁩니다. 잠시 후 다시 실행하세요.")
    if status != 200:
        raise EnrollmentError("패키지를 내려받지 못했습니다. 잠시 후 다시 실행하세요.")
    if hashlib.sha256(data).hexdigest() != expected:
        raise EnrollmentError("패키지 버전이 맞지 않습니다. 대시보드 배포 중일 수 있으니 잠시 후 다시 실행하세요.")
    return data


def extract_package(data, directory):
    """Regular files and directories under ccdash-collector/ only: no links, devices or traversal."""
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        members = archive.getmembers()
        if len(members) > MAX_MEMBERS:
            raise EnrollmentError("패키지 형식이 올바르지 않습니다.")
        for member in members:
            parts = member.name.rstrip("/").split("/")
            if (parts[0] != PACKAGE_ROOT or "\\" in member.name or any(part in ("", ".", "..") for part in parts)
                    or not (member.isfile() or (member.isdir() and len(parts) >= 1))
                    or (member.isfile() and len(parts) < 2)):
                raise EnrollmentError("패키지 형식이 올바르지 않습니다.")
        for member in members:
            target = os.path.join(directory, *member.name.rstrip("/").split("/"))
            if member.isdir():
                os.makedirs(target, mode=0o700, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            source = archive.extractfile(member)
            mode = 0o700 if member.name.endswith(".py") else 0o600
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
            with os.fdopen(descriptor, "wb") as file:
                shutil.copyfileobj(source, file)
    installer = os.path.join(directory, "ccdash-collector", "install.py")
    if not os.path.isfile(installer):
        raise EnrollmentError("패키지에 설치 프로그램이 없습니다.")
    return installer


def write_token(directory, token):
    path = os.path.join(directory, "token")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as file:
        file.write(token + "\n")
    return path


def install_command(installer, endpoint, token_file, user_id_override, approved_user_id):
    command = [sys.executable, "-I", installer, "install", "--endpoint", endpoint, "--token-file", token_file]
    if user_id_override:
        command += ["--user-id", user_id_override]
    elif approved_user_id:
        # A default only: install.py keeps an existing installation's user ID.
        command += ["--default-user-id", approved_user_id]
    return command


def enroll(args, http=fetch, sleep=time.sleep, run=subprocess.call, browser=open_browser, out=print):
    secret = secrets.token_urlsafe(32)
    request = start(args.endpoint, args.platform, hashlib.sha256(secret.encode()).hexdigest(),
                    args.name or device_name(), http=http, sleep=sleep)
    out("")
    out("브라우저에서 이 기기 연결을 승인하세요.")
    out("  확인 코드: " + request["code"])
    out("  승인 주소: " + request["verificationUrl"])
    if not browser(request["verificationUrl"], args.platform):
        out("  이 기기에서 브라우저를 열 수 없다면 위 주소를 내 컴퓨터의 브라우저에서 여세요.")
    out("본인이 방금 시작한 설치이고 화면의 코드가 같을 때만 승인하세요. 다른 사람이 보낸 링크나 코드는 승인하지 마세요.")
    out("승인을 기다리는 중입니다(최대 10분)...")
    reply = wait_for_approval(args.endpoint, request["pollToken"], int(request.get("interval") or 5), 630,
                              http=http, sleep=sleep)
    owner, device, digest, approved_user_id = approved_identity(reply, args.user_id)
    token = "ccd1.%s.%s.%s" % (owner, device, secret)
    out("승인되었습니다. 수집기 패키지를 확인하는 중입니다.")
    work = tempfile.mkdtemp(prefix="ccdash-enroll-")
    try:
        try:
            installer = extract_package(download_package(args.endpoint, args.platform, token, digest, http=http,
                                                         sleep=sleep), work)
        except (tarfile.TarError, OSError, EOFError):
            raise EnrollmentError("패키지 압축을 풀지 못했습니다.") from None
        token_file = write_token(work, token)
        token = None
        status = run(install_command(installer, args.endpoint, token_file, args.user_id, approved_user_id))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if status != 0:
        out("설치를 마치지 못했습니다. 승인된 기기는 대시보드 '수집기 설치 > 내 기기'에 남아 있습니다. "
            "다시 설치하지 않을 거라면 그 기기를 해지하세요.")
        return status or 1
    out("연결을 마쳤습니다. 대시보드 '수집기 설치 > 내 기기'에서 최근 수신을 확인하세요.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True, help="dashboard HTTPS /api/ingest URL")
    parser.add_argument("--platform", required=True, choices=("linux", "darwin"))
    parser.add_argument("--user-id", help="telemetry user ID override (default: approving account's verified email)")
    parser.add_argument("--name", help="device name shown on the dashboard (default: host name)")
    args = parser.parse_args(argv)
    try:
        if not re.fullmatch(r"https://[A-Za-z0-9.-]+(:[0-9]+)?/api/ingest", args.endpoint):
            raise EnrollmentError("대시보드 주소가 올바르지 않습니다.")
        if args.user_id is not None and not USER_ID.fullmatch(args.user_id):
            raise EnrollmentError("사용자 ID에는 영문·숫자와 . _ + @ -만 사용할 수 있습니다.")
        if args.name is not None:
            args.name = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", args.name).strip()[:64] or None
        if os.geteuid() == 0:
            raise EnrollmentError("sudo 없이 로그인 사용자로 실행하세요.")
        return enroll(args)
    except EnrollmentError as error:
        print("ccdash: " + str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nccdash: 설치를 취소했습니다.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
