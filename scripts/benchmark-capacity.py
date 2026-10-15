#!/usr/bin/env python3
"""Run real HTTP/SQL capacity scenarios on isolated, synthetic ARM64 containers."""
import argparse
import base64
import concurrent.futures
import contextlib
import datetime
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--users", type=int, default=140)
    parser.add_argument("--requests-per-user", type=int, default=720)
    parser.add_argument("--resource-bytes", type=int, default=2048)
    parser.add_argument("--dashboard-image", required=True)
    parser.add_argument("--scenario", choices=["all", "product_retry"], default="all")
    parser.add_argument("--fixture-user-projection", action="store_true",
                        help="Materialize an additive read projection on owned synthetic tables only.")
    args = parser.parse_args(argv)
    if not 1 <= args.users <= 140 or not 1 <= args.requests_per_user <= 1440:
        parser.error("users must be 1..140 and requests per user 1..1440")
    if not 0 <= args.resource_bytes <= 32768:
        parser.error("synthetic resource bytes must be 0..32768")
    if not re.fullmatch(r"(?:[a-z0-9./:_-]+@)?sha256:[a-f0-9]{64}", args.dashboard_image):
        parser.error("dashboard image must be a registry digest or immutable local image ID")
    if args.report.exists():
        parser.error("report must be a new private file")
    return args


def quantile(values, percentile):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(percentile * len(ordered)) - 1)] if ordered else None


def summarize(rows):
    statuses = {}
    for row in rows:
        status = str(row["status"])
        statuses[status] = statuses.get(status, 0) + 1
    latency = [row["elapsedMs"] for row in rows]
    return {"requests": len(rows), "statuses": statuses,
            "p50Ms": quantile(latency, 0.5), "p95Ms": quantile(latency, 0.95),
            "maxMs": max(latency) if latency else None,
            "successfulSemanticChecks": sum(row.get("semanticMatch", False) for row in rows),
            "capacityRejections": sum(row.get("capacityRejected", False) for row in rows),
            "invalidSuccessfulResponses": sum(row["status"] == 200 and not row.get("semanticMatch") for row in rows),
            "unexpectedResponses": sum(row["status"] != 200 and not row.get("capacityRejected") for row in rows)}


def equivalent(actual, expected):
    """Ignore incidental row ordering and float noise, never zero/null or population differences."""
    if type(actual) is not type(expected):
        return False
    if isinstance(actual, dict):
        return actual.keys() == expected.keys() and all(
            equivalent(actual[key], expected[key]) for key in actual)
    if isinstance(actual, list):
        def identity(value):
            if isinstance(value, dict):
                value = {key: field for key, field in value.items() if isinstance(field, str)}
            return json.dumps(value, sort_keys=True)
        return len(actual) == len(expected) and all(
            equivalent(a, b) for a, b in zip(sorted(actual, key=identity), sorted(expected, key=identity)))
    if isinstance(actual, float):
        if actual == 0 or expected == 0:
            return actual == expected
        return math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-12)
    return actual == expected


def exact_user_baseline(actual, shared, user):
    expected = [row for row in shared.get("by_user", []) if row.get("user") == user]
    # Both clients are seeded. An empty or incomplete filtered response cannot
    # become its own golden and falsely establish successful capacity.
    return len(expected) == 2 and equivalent(actual.get("by_user"), expected)


def seed_sql(day, users, requests, resource_bytes):
    # All values are bounded integers/date objects. Neither endpoints nor user SQL are accepted.
    start = day.strftime("%Y-%m-%d 00:00:00")
    base = f"toDateTime64('{start}',9)"
    email = "concat('user-',toString(user_index),'@fixture.invalid')"
    return f"""
INSERT INTO claude_code.otel_metrics_sum
(ResourceAttributes,ScopeName,MetricName,Attributes,StartTimeUnix,TimeUnix,Value,AggregationTemporality,IsMonotonic)
SELECT map('user.email',{email},'client','claude_code','service.version','fixture'),
 'claude-code',metric,
 map('session.id',concat('claude-',toString(user_index)),
     'model','us.anthropic.claude-sonnet-4-5-20250929-v1:0','type',token_type),
 {base}-INTERVAL 4 DAY,{base}-INTERVAL 3 DAY+toIntervalSecond(slot*30),
 if(metric='claude_code.session.count',toFloat64(slot>=8640),slot*rate*0.05),2,true
FROM (SELECT intDiv(number,11521) AS user_index,number%11521 AS slot
 FROM numbers({users*11521})) AS exports
CROSS JOIN (
 SELECT 'claude_code.token.usage' AS metric,'input' AS token_type,100. AS rate
 UNION ALL SELECT 'claude_code.token.usage','output',30.
 UNION ALL SELECT 'claude_code.token.usage','cacheRead',20.
 UNION ALL SELECT 'claude_code.token.usage','cacheCreation',0.
 UNION ALL SELECT 'claude_code.cost.usage','',0.0001
 UNION ALL SELECT 'claude_code.session.count','',0.
) AS counters;
INSERT INTO claude_code.otel_logs (Timestamp,ResourceAttributes,LogAttributes)
SELECT {base}+toIntervalSecond(intDiv(request_index*86400,{requests}))
    +toIntervalMicrosecond(piece),
 map('user.email',{email},'client','codex','backend','bedrock-mantle',
     'service.instance.id',concat('fixture-',toString(user_index)),
     'fixture.resource',repeat('x',{resource_bytes})),
 mapUpdate(map('event.name','codex.sse_event',
    'event.kind',if(piece=9,'response.completed','response.output_text.delta'),
    'conversation.id',concat('codex-',toString(user_index)),
    'model','openai.gpt-6.1-sol','model_reasoning_effort','high'),
    if(piece=9,map('input_token_count','100','cached_token_count','20',
      'cache_write_token_count','0','output_token_count','30','reasoning_token_count','10'),map()))
FROM (SELECT intDiv(number,{requests*10}) AS user_index,
 intDiv(number%{requests*10},10) AS request_index,number%10 AS piece
 FROM numbers({users*requests*10}));
INSERT INTO claude_code.codex_metrics_sum
(ResourceAttributes,ScopeName,ScopeVersion,ScopeAttributes,Attributes,MetricName,MetricUnit,
 StartTimeUnix,TimeUnix,Value,AggregationTemporality,IsMonotonic)
SELECT map('user.email',{email},'client','codex','backend','bedrock-mantle',
    'fixture.resource',repeat('x',{resource_bytes})),
 'codex','fixture',map('fixture','capacity'),map('model','openai.gpt-6.1-sol'),
 concat('codex.fixture.counter.',toString(metric_index)),'1',
 {base}-INTERVAL 4 DAY,{base}-INTERVAL 3 DAY+toIntervalSecond(slot*30),
 toFloat64(slot),2,true
FROM (SELECT intDiv(number,11521*4) AS user_index,
 intDiv(number%{11521*4},4) AS slot,number%4 AS metric_index
 FROM numbers({users*11521*4}));
"""


class Stack:
    def __init__(self, args, directory):
        self.args, self.directory = args, directory
        self.run_id = secrets.token_hex(6)
        self.network = "capacity-" + self.run_id
        self.containers = []
        self.volumes = []
        self.nodes = ["ch-" + self.run_id + "-" + str(i) for i in range(3)]
        self.apps = ["app-" + self.run_id + "-" + str(i) for i in range(2)]
        self.proxy = "proxy-" + self.run_id
        self.authorization = "Basic " + base64.b64encode(
            ("capacity-fixture:" + secrets.token_urlsafe(24)).encode()).decode()
        self.network_created = False
        self.stage = "not_started"

    def command(self, values, data=None, timeout=120):
        result = subprocess.run(values, input=data, text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            # Private diagnostics never include command arguments or environment files.
            with (self.directory / "commands.log").open("a") as log:
                log.write(result.stderr + "\n")
            raise RuntimeError("isolated benchmark command failed")
        return result.stdout

    def docker(self, *values, data=None, timeout=120):
        return self.command(["docker", *values], data, timeout)

    def run(self, name, *values):
        self.containers.append(name)
        return self.docker("run", "-d", "--name", name, "--network", self.network,
                           "--label", "ccdash.capacity-run=" + self.run_id, *values).strip()

    def sql(self, node, query):
        return self.docker("exec", "-i", node, "clickhouse-client", "--multiquery",
                           data=query, timeout=180)

    def start(self, day):
        self.stage = "validate_local_runtime"
        architecture = json.loads(self.docker("info", "--format", "{{json .Architecture}}"))
        if architecture != "aarch64":
            raise RuntimeError("ARM64 host required; emulated throughput is not comparable")
        image = json.loads(self.docker("image", "inspect", self.args.dashboard_image))[0]
        if image["Architecture"] != "arm64":
            raise RuntimeError("ARM64 dashboard image required")
        self.revision = (image["Config"].get("Labels") or {}).get("org.opencontainers.image.revision", "")
        if not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", self.revision):
            raise RuntimeError("dashboard image must identify a full Git revision")
        health = image["Config"].get("Healthcheck", {}).get("Test", [])
        if not health or health[0] == "NONE":
            raise RuntimeError("dashboard image must include its readiness healthcheck")
        database = json.loads(self.docker("image", "inspect", "clickhouse/clickhouse-server:24.8"))[0]
        self.clickhouse_image = database["Id"]
        if database["Architecture"] != "arm64" or not re.fullmatch(r"sha256:[a-f0-9]{64}", self.clickhouse_image):
            raise RuntimeError("an existing ARM64 ClickHouse 24.8 image is required")
        self.docker("network", "create", "--internal", "--label",
                    "ccdash.capacity-run=" + self.run_id, self.network)
        self.network_created = True
        self.stage = "prepare_synthetic_config"
        password = secrets.token_urlsafe(24)
        digest = hashlib.sha256(password.encode()).hexdigest()
        config = self.directory / "clickhouse.xml"
        config.write_text("""<clickhouse>
<background_schedule_pool_size>16</background_schedule_pool_size>
<background_buffer_flush_schedule_pool_size>4</background_buffer_flush_schedule_pool_size>
<background_message_broker_schedule_pool_size>4</background_message_broker_schedule_pool_size>
<background_distributed_schedule_pool_size>4</background_distributed_schedule_pool_size>
<max_server_memory_usage>11864847155</max_server_memory_usage>
</clickhouse>""")
        config.chmod(0o644)  # Synthetic tuning only; ClickHouse's non-root process reads this.
        users = self.directory / "users.xml"
        users.write_text(f"""<clickhouse><profiles><capacity_reader>
<readonly>1</readonly><max_execution_time>60</max_execution_time>
<max_memory_usage>4000000000</max_memory_usage><max_result_bytes>104857600</max_result_bytes>
<max_rows_to_read>2000000000</max_rows_to_read></capacity_reader></profiles>
<users><default><networks replace="replace"><ip>127.0.0.1</ip><ip>::1</ip></networks></default>
<capacity_reader><password_sha256_hex>{digest}</password_sha256_hex>
<networks><ip>::/0</ip></networks><profile>capacity_reader</profile>
<quota>default</quota><allow_databases><database>claude_code</database></allow_databases>
</capacity_reader></users></clickhouse>""")
        users.chmod(0o644)  # Synthetic password hash; no production credentials are consumed.
        for node in self.nodes:
            self.stage = "start_database"
            volume = node + "-data"
            self.volumes.append(volume)
            self.docker("volume", "create", "--label", "ccdash.capacity-run=" + self.run_id, volume)
            self.run(node, "--cpus", "3.5", "--memory", "13g", "--ulimit", "nofile=262144:262144",
                     "-v", volume + ":/var/lib/clickhouse",
                     "-v", str(config) + ":/etc/clickhouse-server/config.d/capacity.xml:ro",
                     "-v", str(users) + ":/etc/clickhouse-server/users.d/capacity.xml:ro",
                     self.clickhouse_image)
        for node in self.nodes:
            self.stage = "initialize_schema"
            for _ in range(60):
                try:
                    self.sql(node, "SELECT 1")
                    break
                except RuntimeError:
                    time.sleep(0.5)
            else:
                raise RuntimeError("isolated ClickHouse startup failed")
            self.sql(node, (ROOT / "clickhouse-schema.sql").read_text())
        fixture = seed_sql(day, self.args.users, self.args.requests_per_user, self.args.resource_bytes)
        self.stage = "seed_synthetic_data"
        print(json.dumps({"phase": self.stage, "users": self.args.users,
                          "rowsPerDatabase": self.args.users*(11521*10+self.args.requests_per_user*10)}),
              flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda node: self.sql(node, fixture), self.nodes))
        if self.args.fixture_user_projection:
            self.stage = "materialize_synthetic_user_projection"
            print(json.dumps({"phase": self.stage}), flush=True)
            sql = """ALTER TABLE claude_code.otel_logs ADD PROJECTION capacity_user_order (
              SELECT Timestamp, ResourceAttributes, LogAttributes, EventName, UserEmail, EndUserId
              ORDER BY (coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''), ''), EventName, Timestamp));
              ALTER TABLE claude_code.otel_logs MATERIALIZE PROJECTION capacity_user_order
              SETTINGS mutations_sync=1"""
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                list(pool.map(lambda node: self.sql(node, sql), self.nodes))
        targets = {"api": [f"http://{name}:8080" for name in self.apps],
                   "database": [f"http://{name}:8123" for name in self.nodes]}
        proxy_env = self.directory / "proxy.env"
        proxy_env.write_text("CAPACITY_TARGETS=" + json.dumps(targets, separators=(",", ":")) + "\n")
        proxy_env.chmod(0o600)
        self.stage = "start_private_transport"
        self.run(self.proxy, "--cpus", "2", "--memory", "512m",
                 "--env-file", str(proxy_env), "--entrypoint", "node",
                 "-v", str(ROOT / "scripts/capacity-proxy.mjs") + ":/capacity-proxy.mjs:ro",
                 self.args.dashboard_image, "/capacity-proxy.mjs")
        private_ip = None
        for _ in range(30):
            transport = json.loads(self.docker("inspect", self.proxy))[0]
            if not transport["State"]["Running"]:
                with (self.directory / "commands.log").open("a") as log:
                    log.write(self.docker("logs", self.proxy))
                raise RuntimeError("private transport exited")
            network = transport["NetworkSettings"]["Networks"].get(self.network, {})
            if network.get("IPAddress"):
                private_ip = network["IPAddress"]
                break
            time.sleep(0.1)
        if not private_ip or not ipaddress.ip_address(private_ip).is_private:
            raise RuntimeError("private transport address unavailable")
        self.base = "http://" + private_ip + ":8080"
        basic_password = base64.b64decode(self.authorization[6:]).decode().split(":", 1)[1]
        app_env = self.directory / "app.env"
        app_env.write_text(f"""CH_URL=http://{self.proxy}:8123
CH_DB=claude_code
CH_USER=capacity_reader
CH_PASSWORD={password}
AUTH_MODE=basic
BASIC_AUTH_USER=capacity-fixture
BASIC_AUTH_PASSWORD={basic_password}
CLAUDE_ENABLED=true
CODEX_ENABLED=true
DEFAULT_RANGE_DAYS=1
""")
        app_env.chmod(0o600)
        for app in self.apps:
            self.stage = "start_api"
            self.run(app, "--cpus", "0.5", "--memory", "256m", "--env-file", str(app_env),
                     self.args.dashboard_image)
        self.wait_ready()
        self.stage = "api_ready"

    def wait_ready(self):
        for _ in range(100):
            rows = [self.docker("inspect", "--format", "{{json .State}}", name) for name in self.apps]
            if all(json.loads(row).get("Health", {}).get("Status") == "healthy" for row in rows):
                return
            if any(not json.loads(row)["Running"] for row in rows):
                raise RuntimeError("isolated API exited")
            time.sleep(0.5)
        raise RuntimeError("isolated API readiness deadline exceeded")

    def clear_api_caches(self):
        for app in self.apps:
            self.docker("restart", "--time", "15", app)
        self.wait_ready()

    def state(self):
        return [{"component": item["Name"].split("-")[0].lstrip("/"),
                 "state": item["State"], "restarts": item["RestartCount"]}
                for item in json.loads(self.docker("inspect", *self.nodes, *self.apps, self.proxy))]

    def sample(self):
        return [json.loads(line) for line in self.docker("stats", "--no-stream",
                "--format", "{{json .}}", *self.nodes, *self.apps, self.proxy,
                timeout=4).splitlines()]

    def owned(self, kind, name):
        result = subprocess.run(["docker", kind, "inspect", name], capture_output=True, text=True)
        if result.returncode:
            return False
        item = json.loads(result.stdout)[0]
        labels = item.get("Config", {}).get("Labels", {}) if kind == "container" else item.get("Labels", {})
        return labels.get("ccdash.capacity-run") == self.run_id

    def close(self):
        for name in reversed(self.containers):
            if self.owned("container", name):
                subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=30)
        for volume in self.volumes:
            if self.owned("volume", volume):
                subprocess.run(["docker", "volume", "rm", volume], capture_output=True, timeout=30)
        if self.network_created and self.owned("network", self.network):
            subprocess.run(["docker", "network", "rm", self.network], capture_output=True, timeout=30)


def request(stack, path):
    started = time.monotonic()
    call = urllib.request.Request(stack.base + path, headers={"Authorization": stack.authorization})
    try:
        # The host reaches its owned internal Docker bridge directly; never use ambient proxies.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(call, timeout=75) as response:
            return response.status, json.loads(response.read()), response.headers, (time.monotonic()-started)*1000
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read()), error.headers, (time.monotonic()-started)*1000


@contextlib.contextmanager
def observe_usage(stack):
    samples, stopped = [], threading.Event()
    def observe():
        while not stopped.is_set():
            try:
                samples.append({"sampledAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                "containers": stack.sample()})
            except Exception:
                samples.append({"status": "unavailable"})
            stopped.wait(0.25)
    observer = threading.Thread(target=observe, daemon=True)
    observer.start()
    try:
        yield samples
    finally:
        stopped.set(); observer.join(timeout=5)


def burst(stack, paths, expected):
    barrier = threading.Barrier(len(paths))

    def visit(index):
        barrier.wait(timeout=10)
        try:
            status, body, headers, elapsed = request(stack, paths[index])
            return {"status": status, "elapsedMs": round(elapsed, 2),
                    "semanticMatch": status == 200 and equivalent(body, expected[index]),
                    "capacityRejected": status == 503 and body.get("code") == "capacity_exhausted"
                    and headers.get("Retry-After") == "1"}
        except Exception as error:
            return {"status": "transport_error", "elapsedMs": 75000,
                    "errorType": type(error).__name__}
    with observe_usage(stack) as samples:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(paths)) as pool:
            rows = list(pool.map(visit, range(len(paths))))
    return {**summarize(rows), "samples": samples}


def client_burst(stack, paths, expected):
    name = "client-" + stack.run_id + "-0"
    stack.containers.append(name)
    value = {"runId": stack.run_id, "paths": paths, "authorization": stack.authorization}
    with observe_usage(stack) as samples:
        output = stack.docker("run", "--rm", "-i", "--name", name, "--network", stack.network,
            "--label", "ccdash.capacity-run=" + stack.run_id, "--cpus", "1", "--memory", "256m",
            "--entrypoint", "node",
            "-v", str(ROOT / "scripts/capacity-client.mjs") + ":/capacity-client.mjs:ro",
            "-v", str(ROOT / "dashboard/web/src/api.js") + ":/capacity-api.mjs:ro",
            stack.args.dashboard_image, "/capacity-client.mjs", data=json.dumps(value), timeout=120)
    native = json.loads(output)
    if len(native) != len(paths):
        raise RuntimeError("product retry result population mismatch")
    rows = [{"status": row["status"], "elapsedMs": row["elapsedMs"],
             "semanticMatch": row["status"] == 200 and equivalent(row["body"], expected[index]),
             "capacityRejected": row["status"] == 503 and row.get("body", {}).get("code")
               == "capacity_exhausted" and row.get("retryAfter") == "1"}
            for index, row in enumerate(native)]
    return {**summarize(rows), "initial503": sum(row["attempts"][:1] == [503] for row in native),
            "totalHttpAttempts": sum(len(row["attempts"]) for row in native),
            "retries": sum(max(0, len(row["attempts"])-1) for row in native),
            "apiFetchSha256": hashlib.sha256((ROOT / "dashboard/web/src/api.js").read_bytes()).hexdigest(),
            "productRetry": True, "samples": samples}


def main(argv=None):
    args = arguments(argv)
    os.umask(0o077)
    day = datetime.datetime.now(datetime.timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0)-datetime.timedelta(days=1)
    record = {"startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "scope": "synthetic local ARM64 HTTP/SQL, Basic authentication; not customer OIDC or production capacity",
              "users": args.users, "requestsPerUser": args.requests_per_user,
              "resourceBytes": args.resource_bytes,
              "selectedScenario": args.scenario,
              "syntheticUserProjection": args.fixture_user_projection,
              "envelope": {"clickhouse": {"replicas": 3, "cpuEach": 3.5, "memoryEach": "13Gi"},
                           "api": {"replicas": 2, "cpuEach": 0.5, "memoryEach": "256Mi"}},
              "limitations": ["independent database copies omit Keeper/replication overhead",
                              "HTTP cache cold does not flush database/storage caches",
                              "synthetic density and labels do not prove customer workload equivalence",
                              "Basic auth omits real OIDC/cookie and browser rendering overhead"],
              "scenarios": []}
    with tempfile.TemporaryDirectory(prefix="ccdash-capacity-") as directory:
        stack = Stack(args, Path(directory))
        record["runId"] = stack.run_id
        try:
            print(json.dumps({"phase": "initialize_isolated_stack", "runId": stack.run_id}), flush=True)
            stack.start(day)
            record["runtimeRevision"] = stack.revision
            record["dashboardImage"] = args.dashboard_image
            record["clickhouseImage"] = stack.clickhouse_image
            params = {"from": day.isoformat(), "to": (day+datetime.timedelta(days=1)).isoformat(),
                      "client": "all", "view": "cost", "intervalHours": str(1/6), "modelTime": "1"}
            base_path = "/api/clients/overview?" + urllib.parse.urlencode(params)
            status, golden, _, _ = request(stack, base_path)
            if status != 200 or not (golden.get("totals", {}).get("cost_usd") or 0) > 0:
                raise RuntimeError("fixture cost baseline unavailable")
            if not (golden["totals"].get("observed_tokens") or 0) > 0 or len(golden["by_user"]) != args.users*2:
                raise RuntimeError("fixture population/usage mismatch")
            cases = [("shared_cold", [base_path]*args.users, [golden]*args.users),
                     ("shared_warm", [base_path]*args.users, [golden]*args.users)] if args.scenario == "all" else []
            distinct, expected = [], []
            for index in range(args.users):
                path = "/api/clients/overview?" + urllib.parse.urlencode(
                    {**params, "userExact": f"user-{index}@fixture.invalid"})
                code, result, _, _ = request(stack, path)
                if code != 200 or not exact_user_baseline(
                        result, golden, f"user-{index}@fixture.invalid"):
                    raise RuntimeError("exact-user baseline mismatch")
                distinct.append(path); expected.append(result)
                if (index+1) % 20 == 0:
                    print(json.dumps({"phase": "verify_exact_user_baselines",
                                      "verifiedUsers": index+1}), flush=True)
            if args.scenario == "all":
                cases.extend([("distinct_cold", distinct, expected), ("distinct_followup", distinct, expected)])
            for name, paths, expected in cases:
                print(json.dumps({"phase": name, "requests": len(paths)}), flush=True)
                if name.endswith("_cold"):
                    stack.clear_api_caches()
                summary = burst(stack, paths, expected)
                summary.update(name=name, after=stack.state())
                record["scenarios"].append(summary)
            stack.clear_api_caches()
            print(json.dumps({"phase": "distinct_cold_product_retry", "requests": args.users}), flush=True)
            summary = client_burst(stack, distinct, expected)
            summary.update(name="distinct_cold_product_retry", after=stack.state())
            record["scenarios"].append(summary)
            record["allUsersSucceededInEveryScenario"] = all(
                case["successfulSemanticChecks"] == args.users for case in record["scenarios"])
            record["responsesSemanticallyValid"] = all(
                case["invalidSuccessfulResponses"] == case["unexpectedResponses"] == 0
                for case in record["scenarios"])
            record["oomObserved"] = any(
                component["state"].get("OOMKilled") for case in record["scenarios"]
                for component in case["after"])
            record["completedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            record["status"] = "completed"
        except Exception as error:
            record["status"] = "failed"
            record["failureType"] = type(error).__name__
            record["failure"] = str(error)
            record["failureStage"] = stack.stage
            diagnostics = Path(directory) / "commands.log"
            if diagnostics.exists():
                args.report.parent.mkdir(parents=True, exist_ok=True)
                destination = args.report.with_suffix(".diagnostics.log")
                descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w") as output:
                    output.write(diagnostics.read_text())
        finally:
            stack.close()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(args.report, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(record, output, indent=2); output.write("\n")
    print(json.dumps({"status": record["status"], "users": args.users,
                      "scenarios": [{key: value for key, value in item.items() if key not in ["after", "samples"]}
                                    for item in record["scenarios"]], "report": str(args.report)}))
    return 0 if record["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
