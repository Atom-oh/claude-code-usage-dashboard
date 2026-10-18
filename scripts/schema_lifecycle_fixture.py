"""Network-isolated ClickHouse fixture for the schema lifecycle checks."""

import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


class SchemaFixture:
    image = "clickhouse/clickhouse-server:24.8"
    password = "YOUR_SYNTHETIC_SCHEMA_FIXTURE_PASSWORD"

    def __init__(self, root, replicas=1):
        if replicas not in (1, 3):
            raise ValueError("Schema fixtures support one or three replicas.")
        self.root = Path(root)
        self.name = "ccdash-schema-lifecycle-" + uuid.uuid4().hex[:12]
        self.replicas = replicas
        self.members = [self.name] if replicas == 1 else [self.name + "-" + str(i) for i in range(replicas)]
        self.name = self.members[0]
        self.network = self.name + "-network"
        self.directory = tempfile.TemporaryDirectory(prefix="ccdash-schema-lifecycle-")
        self.started = []
        self.network_id = None

    def docker(self, *args, input=None, check=True, timeout=120):
        return subprocess.run(
            ["docker", *args], input=input, text=True, capture_output=True,
            check=check, timeout=timeout,
        )

    def __enter__(self):
        directory = Path(self.directory.name)
        hosts = ["127.0.0.1"] if self.replicas == 1 else self.members
        cluster = "".join(
            f"<replica><host>{host}</host><port>9000</port>"
            f"<user>otel_writer</user><password>{self.password}</password></replica>"
            for host in hosts
        )
        keeper = """<keeper_server>
    <tcp_port>9181</tcp_port><server_id>1</server_id>
    <log_storage_path>/var/lib/clickhouse/keeper/log</log_storage_path>
    <snapshot_storage_path>/var/lib/clickhouse/keeper/snapshots</snapshot_storage_path>
    <raft_configuration><server><id>1</id><hostname>127.0.0.1</hostname><port>9234</port></server></raft_configuration>
  </keeper_server>"""
        try:
            if self.replicas > 1:
                self.network_id = self.docker("network", "create", "--internal", self.network).stdout.strip()
            for index, member in enumerate(self.members):
                configuration = f"""<clickhouse>
  <listen_host replace="1">0.0.0.0</listen_host>
  <background_schedule_pool_size>16</background_schedule_pool_size>
  <background_buffer_flush_schedule_pool_size>4</background_buffer_flush_schedule_pool_size>
  <background_message_broker_schedule_pool_size>4</background_message_broker_schedule_pool_size>
  <background_distributed_schedule_pool_size>4</background_distributed_schedule_pool_size>
  <max_server_memory_usage>1000000000</max_server_memory_usage>
  {keeper if index == 0 else ''}
  <zookeeper><node><host>{hosts[0]}</host><port>9181</port></node></zookeeper>
  <macros><shard>0</shard><replica>fixture{index}</replica></macros>
  <remote_servers><replicated><shard><internal_replication>true</internal_replication>
    {cluster}
  </shard></replicated></remote_servers>
  <storage_configuration>
    <disks><cold><path>/var/lib/clickhouse/cold/</path></cold></disks>
    <policies><hot_cold><volumes><hot><disk>default</disk></hot><cold><disk>cold</disk></cold></volumes></hot_cold></policies>
  </storage_configuration>
</clickhouse>
"""
                path = directory / ("fixture-" + str(index) + ".xml")
                path.write_text(configuration)
                created = self.docker(
                    "run", "-d", "--name", member,
                    "--network", "none" if self.replicas == 1 else self.network,
                    "--memory", "1536m", "--cpus", "1",
                    "--tmpfs", "/var/lib/clickhouse:rw,size=1g",
                    "--tmpfs", "/var/log/clickhouse-server:rw,size=128m",
                    "-e", "CLICKHOUSE_USER=otel_writer",
                    "-e", "CLICKHOUSE_PASSWORD=" + self.password,
                    "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
                    "-v", str(path) + ":/etc/clickhouse-server/config.d/fixture.xml:ro",
                    "-v", str(self.root / "infra/files") + ":/sql:ro",
                    self.image,
                )
                self.started.append((created.stdout.strip(), member))
            for index in range(self.replicas):
                for _ in range(120):
                    result = self.query("SELECT 1", check=False, timeout=10, node_index=index)
                    if result.returncode == 0:
                        break
                    time.sleep(0.25)
                else:
                    raise RuntimeError("Isolated schema fixture did not start: " + result.stderr[-2000:])
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        failures = []
        try:
            for container_id, member in reversed(self.started):
                try:
                    observed = self.docker("inspect", container_id, timeout=10, check=False)
                    if observed.returncode:
                        if "No such object" in observed.stderr or "No such container" in observed.stderr:
                            continue
                        raise RuntimeError(observed.stderr)
                    info = json.loads(observed.stdout)[0]
                    if info["Name"] != "/" + member:
                        raise RuntimeError("Owned fixture container identity changed.")
                    if info["State"]["Paused"]:
                        self.docker("unpause", container_id, timeout=10)
                    # Kill first: an rm observation timeout must not abort cleanup
                    # of the remaining replicas or be mistaken for their removal.
                    if info["State"]["Running"]:
                        try:
                            self.docker("kill", "--signal", "KILL", container_id, timeout=15, check=False)
                        except subprocess.TimeoutExpired:
                            pass
                    try:
                        self.docker("rm", "-f", container_id, timeout=15, check=False)
                    except subprocess.TimeoutExpired:
                        pass
                    for attempt in range(5):
                        observed = self.docker("inspect", container_id, timeout=10, check=False)
                        absent = observed.returncode and (
                            "No such object" in observed.stderr or "No such container" in observed.stderr
                        )
                        if absent:
                            break
                        if observed.returncode:
                            raise RuntimeError(observed.stderr)
                        if attempt < 4:
                            time.sleep(1)
                    else:
                        raise RuntimeError("Owned fixture container removal is not verified.")
                except (subprocess.SubprocessError, RuntimeError, ValueError) as error:
                    failures.append(member + ": " + str(error))
            if self.network_id:
                try:
                    try:
                        self.docker("network", "rm", self.network_id, timeout=15, check=False)
                    except subprocess.TimeoutExpired:
                        pass
                    for attempt in range(5):
                        observed = self.docker("network", "inspect", self.network_id, timeout=10, check=False)
                        absent = observed.returncode and (
                            "No such network" in observed.stderr
                            or f"network {self.network_id} not found" in observed.stderr
                        )
                        if absent:
                            break
                        if observed.returncode:
                            raise RuntimeError(observed.stderr)
                        if attempt < 4:
                            time.sleep(1)
                    else:
                        raise RuntimeError("Owned fixture network removal is not verified.")
                except (subprocess.SubprocessError, RuntimeError) as error:
                    failures.append("Owned fixture network: " + str(error))
        finally:
            self.directory.cleanup()
        if failures:
            raise RuntimeError("Owned schema fixture cleanup failed: " + "\n".join(failures))

    def query(self, sql, check=True, timeout=120, node_index=0, **settings):
        return self.docker(
            "exec", "-i", "-e", "CLICKHOUSE_PASSWORD=" + self.password,
            self.members[node_index], "clickhouse-client", "--user", "otel_writer", "--multiquery",
            *["--" + name + "=" + str(value) for name, value in settings.items()],
            input=sql, check=check, timeout=timeout,
        )

    def rows(self, sql, node_index=0):
        text = self.query(sql + " FORMAT JSONEachRow", node_index=node_index).stdout
        return [json.loads(line) for line in text.splitlines() if line]

    def runner(self, **overrides):
        environment = {
            "CH_HOST": "127.0.0.1", "CH_USER": "otel_writer", "CH_PASSWORD": self.password,
            "CH_EXPECTED_REPLICAS": str(self.replicas), "SCHEMA_DIRECTORY": "/sql",
            "SCHEMA_VERIFY_ATTEMPTS": "12" if self.replicas == 3 else "1", "SCHEMA_CONNECT_ATTEMPTS": "2",
            "SCHEMA_QUERY_TIMEOUT_SECONDS": "5",
        }
        environment.update(overrides)
        arguments = ["exec"]
        for name, value in environment.items():
            arguments.extend(["-e", name + "=" + value])
        return self.docker(
            *arguments, self.name, "sh", "/sql/clickhouse-schema-init.sh", check=False,
        )
