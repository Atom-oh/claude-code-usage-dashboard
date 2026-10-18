import hashlib
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]


class SchemaLifecycleStructure(unittest.TestCase):
    def test_contract_is_bound_to_the_actual_replicated_schema(self):
        source = (ROOT / "infra/files/clickhouse-schema-replicated.sql").read_bytes()
        contract = (ROOT / "infra/files/clickhouse-schema-contract.sql").read_text()
        self.assertEqual(contract.splitlines()[0], "-- schema-source-sha256: " + hashlib.sha256(source).hexdigest())
        # Diagnostic strings may contain semicolons or comment markers.
        without_strings = re.sub(r"'(?:\\.|[^'\\])*'", "''", contract)
        for statement in re.sub(r"--[^\n]*", "", without_strings).split(";"):
            if statement.strip():
                self.assertRegex(statement.strip(), r"^SELECT\b")
        for required in ["default_expression", "partition_key", "sorting_key", "primary_key",
                         "create_table_query", "as_select", "storage_policy", "zookeeper_path",
                         "schema_migrations", "checksum"]:
            self.assertIn(required, contract)

    def test_job_pins_every_input_and_keeps_its_resource_addresses(self):
        source = (ROOT / "infra/schema.tf").read_text()
        old = (ROOT / "infra/clickhouse.tf").read_text()
        self.assertIn('resource "kubernetes_config_map" "schema"', source)
        self.assertIn('resource "kubernetes_job_v1" "schema_init"', source)
        self.assertNotIn('resource "kubernetes_job_v1" "schema_init"', old)
        for name in ["clickhouse-schema-replicated.sql", "clickhouse-schema-contract.sql", "clickhouse-schema-init.sh"]:
            self.assertIn(name, source)
        self.assertRegex(source, r"immutable\s*=\s*true")
        self.assertIn("sha256(jsonencode(local.schema_lifecycle_files))", source)
        self.assertRegex(source, r"backoff_limit\s*=\s*0\b")
        self.assertRegex(source, r'restart_policy\s*=\s*"Never"')
        self.assertRegex(source, r"wait_for_completion\s*=\s*true")
        self.assertIn("secret_key_ref", source)
        self.assertNotIn("--password", source)

    def test_runner_only_bootstraps_empty_replicas_and_bounds_queries(self):
        path = ROOT / "infra/files/clickhouse-schema-init.sh"
        subprocess.run(["sh", "-n", str(path)], check=True)
        source = path.read_text()
        self.assertIn('if [ "$nonempty" = 0 ]; then', source)
        self.assertEqual(source.count('--queries-file "$schema"'), 1)
        self.assertIn('--queries-file "$SCHEMA_DIRECTORY/clickhouse-schema-contract.sql"', source)
        self.assertIn('if [ "$count" != "$CH_EXPECTED_REPLICAS" ] || [ "$unique" != "$count" ] || [ "$shards" != 1 ]', source)
        self.assertIn('if [ "$topology" != "$replicas" ] || [ "$replica_shards" != 1 ]', source)
        self.assertIn('for host in $replicas', source)
        self.assertIn("--max_execution_time=15", source)
        self.assertIn("--receive_timeout=20", source)
        self.assertEqual(source.count("--readonly=1"), 2)
        self.assertEqual(source.count("--max_memory_usage=268435456"), 2)
        self.assertEqual(source.count("--max_rows_to_read=10000"), 2)
        self.assertIn("SCHEMA_CONNECT_ATTEMPTS", source)
        self.assertIn("SCHEMA_VERIFY_ATTEMPTS", source)
        self.assertEqual(source.count('timeout --kill-after=2s "$SCHEMA_QUERY_TIMEOUT_SECONDS"'), 1)
        self.assertEqual(source.count('bounded_client clickhouse-client'), 2)
        self.assertIn("CLICKHOUSE_PASSWORD", source)
        self.assertNotIn("--password", source)
        self.assertIn("mutations_sync=2", source)

    def test_ci_checks_generated_contract_and_native_behavior(self):
        source = (ROOT / ".github/workflows/ci.yml").read_text()
        self.assertIn("python3 scripts/build-schema-contract.py --check", source)
        self.assertIn("python3 scripts/test-schema-lifecycle.py", source)


if __name__ == "__main__":
    unittest.main()
