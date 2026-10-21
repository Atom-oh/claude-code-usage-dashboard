"""Native regressions for outcome and MCP metadata after content redaction."""
import json
import time
import unittest

import test_runtime


@unittest.skipUnless(test_runtime.BINARY, "set CCDASH_TEST_COLLECTOR_BINARY for native policy fixture")
class Privacy(unittest.TestCase):
    # Share the lifecycle without inheriting and rerunning Runtime's tests.
    collector = test_runtime.Runtime.collector
    send = test_runtime.Runtime.send

    def collect_logs(self, output, expected):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            # File exporter writes can split a record across multiple writes.
            lines = output.read_text().splitlines(keepends=True) if output.exists() else []
            rows = [json.loads(line) for line in lines if line.endswith("\n")]
            records = [record for row in rows for resource in row.get("resourceLogs", [])
                       for scope in resource["scopeLogs"] for record in scope["logRecords"]]
            if len(records) == expected:
                attrs = {test_runtime.values(record["attributes"])["case.id"]:
                         test_runtime.values(record["attributes"]) for record in records}
                self.assertEqual(len(attrs), expected)
                self.assertNotIn("sensitive-", output.with_name("stderr").read_text())
                return rows, attrs
            time.sleep(0.1)
        self.fail(f"Expected {expected} log records, received {len(records)}")

    def test_error_and_mcp_semantics_survive_both_hops(self):
        cases = {
            "absent": {},
            "empty": {"error": ""},
            "failure": {"error": "sensitive-error-details"},
            "mcp": {"tool_parameters": json.dumps({
                "mcp_server_name": "fixture-mcp", "mcp_tool_name": "read",
                "arguments": {"query": "sensitive-arguments"}, "content": "sensitive-content"})},
            "bad-json": {"error": "sensitive-error-details",
                         "tool_parameters": '{"mcp_server_name":"sensitive-incomplete"'},
            "empty-json": {"tool_parameters": "{}"},
            "json-array": {"tool_parameters": '["sensitive-array"]'},
            "json-null": {"tool_parameters": "null"},
            "json-scalar": {"tool_parameters": '"sensitive-scalar"'},
            "empty-ids": {"tool_parameters": '{"mcp_server_name":"","mcp_tool_name":""}'},
            "wrong-types": {"tool_parameters":
                            '{"mcp_server_name":{"content":"sensitive-object"},"mcp_tool_name":42}'},
            "partial": {"tool_parameters":
                        '{"mcp_server_name":"fixture-mcp","mcp_tool_name":true,"arguments":"sensitive-arguments"}'},
        }
        logs = []
        for client, service in (("claude", "claude-code"), ("codex", "codex")):
            records = []
            for case, extra in cases.items():
                attrs = {"event.name": "tool_result" if client == "claude" else "codex.tool_result",
                         "case.id": client + "-" + case, "success": "true", "session.id": "fixture-session",
                         "prompt.id": "fixture-prompt", "input_tokens": "25", **extra}
                records.append({"timeUnixNano": "1792540800000000000",
                                "body": {"stringValue": "sensitive-body"},
                                "attributes": test_runtime.attributes(attrs)})
            logs.append({"resource": {"attributes": test_runtime.attributes({
                "service.name": service, "error": "sensitive-resource-error",
                "tool_parameters": "sensitive-resource-parameters"})},
                "scopeLogs": [{"logRecords": records}]})
        with self.collector() as (port, output):
            self.send(port, "logs", {"resourceLogs": logs})
            local, local_attrs = self.collect_logs(output, len(cases) * 2)
        with self.collector(central=True) as (port, output):
            for row in local:
                self.send(port, "logs", row, central=True)
            central, central_attrs = self.collect_logs(output, len(cases) * 2)

        self.assertEqual(local_attrs, central_attrs)
        for hop, stage, attrs in (("local", local, local_attrs), ("central", central, central_attrs)):
            self.assertNotIn("sensitive-", json.dumps(stage))
            for client in ("claude", "codex"):
                with self.subTest(hop=hop, client=client):
                    self.assertNotIn("error", attrs[client + "-absent"])
                    self.assertEqual(attrs[client + "-empty"]["error"], "")
                    self.assertEqual(attrs[client + "-failure"]["error"], "[redacted]")
                    self.assertEqual(attrs[client + "-bad-json"]["error"], "[redacted]")
                    if client == "claude":
                        self.assertEqual(json.loads(attrs[client + "-mcp"]["tool_parameters"]),
                                         {"mcp_server_name": "fixture-mcp", "mcp_tool_name": "read"})
                        self.assertEqual(json.loads(attrs[client + "-partial"]["tool_parameters"]),
                                         {"mcp_server_name": "fixture-mcp"})
                        self.assertEqual(json.loads(attrs[client + "-empty-ids"]["tool_parameters"]),
                                         {"mcp_server_name": "", "mcp_tool_name": ""})
                    else:
                        # Existing Codex policy removes parameters before this
                        # layer; Claude MCP queries consume tool_result.
                        for case in cases:
                            self.assertNotIn("tool_parameters", attrs[client + "-" + case])
                    for case in ("bad-json", "empty-json", "json-array", "json-null", "json-scalar", "wrong-types"):
                        self.assertNotIn("tool_parameters", attrs[client + "-" + case])
                    for case in cases:
                        self.assertEqual(attrs[client + "-" + case]["input_tokens"], "25")
                        self.assertEqual(attrs[client + "-" + case]["prompt.id"], "fixture-prompt")


if __name__ == "__main__":
    unittest.main()
