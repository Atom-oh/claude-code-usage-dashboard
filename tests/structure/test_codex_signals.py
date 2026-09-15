"""Native-shaped synthetic signals through the actual pinned Collector."""

import copy
import json
import unittest

import test_collector_clients as clients
from test_collector_clients import NOW, attributes, values


def resource():
    return {"attributes": attributes({
        "service.name": "codex_exec", "service.version": "0.154.0",
        "user.email": "fixture@example.invalid", "enduser.id": "fixture-user",
        "service.instance.id": "fixture-process", "project.name": "fixture",
        "backend": "bedrock-mantle", "experiment.group": "enterprise",
        "code.file.path": "/private/source", "authorization": "private header",
    })}


def metrics():
    point = {"startTimeUnixNano": str(NOW - 100), "timeUnixNano": str(NOW), "flags": 1,
             "attributes": attributes({"model": "openai.gpt-6-astra", "tool": "exec_command",
                                       "session.id": "fixture-session", "reasoning_effort": "high",
                                       "arguments": "private args", "url.full": "https://private.invalid",
                                       "unknown_future_field": "private content"})}
    items = []
    for name, kind, extra in [
        ("codex.tool.call", "sum", {"asDouble": 7}),
        ("codex.turn.unified_exec.running_processes", "gauge", {"asDouble": 2}),
        ("codex.turn.e2e_duration_ms", "histogram",
         {"count": "2", "sum": 30, "min": 10, "max": 20, "bucketCounts": ["1", "1"], "explicitBounds": [15]}),
        ("codex.api_request.duration_ms", "exponentialHistogram",
         {"count": "2", "sum": 30, "min": 10, "max": 20, "scale": 1, "zeroCount": "0",
          "positive": {"offset": 1, "bucketCounts": ["1", "1"]}}),
    ]:
        data = {"dataPoints": [{**copy.deepcopy(point), **extra}]}
        if kind != "gauge":
            data["aggregationTemporality"] = 1
        if kind == "sum":
            data["isMonotonic"] = True
        items.append({"name": name, "description": "private prompt", "unit": "ms" if "duration" in name else "",
                      kind: data})
    return {"resourceMetrics": [{"resource": resource(), "schemaUrl": "https://private.invalid/resource",
            "scopeMetrics": [{"scope": {"name": "codex_otel", "version": "0.154.0",
                                       "attributes": attributes({"authorization": "private header"})},
                             "schemaUrl": "https://private.invalid/scope", "metrics": items}]}]}


def traces():
    parent = {"traceId": "0102030405060708090a0b0c0d0e0f10", "spanId": "0102030405060708",
              "name": "session_task.turn", "startTimeUnixNano": str(NOW - 100),
              "endTimeUnixNano": str(NOW), "kind": 1, "traceState": "private=value",
              "status": {"code": 2, "message": "private exception"},
              "attributes": attributes({
                  "model": "openai.gpt-6-astra", "turn.id": "fixture-turn",
                  "codex.turn.reasoning_effort": "high", "codex.turn.token_usage.input_tokens": 100,
                  "codex.request.reasoning_effort": "high", "gen_ai.usage.output_tokens": 20,
                  "tool_name": "exec_command", "call_id": "fixture-call", "busy_ns": 75,
                  "thread.id": 123, "code.file.path": "/private/source", "cwd": "/private/cwd",
                  "http.request.header.authorization": "private header", "tool.output": "private output",
              }),
              "events": [{"timeUnixNano": str(NOW), "name": "private event",
                          "attributes": attributes({"exception.message": "private exception"})}]}
    child = {**copy.deepcopy(parent), "spanId": "0202030405060708", "parentSpanId": parent["spanId"],
             "name": "run_turn", "attributes": attributes({"busy_ns": 10})}
    return {"resourceSpans": [{"resource": resource(),
                              "scopeSpans": [{"scope": {"name": "codex_core"}, "spans": [parent, child]}]}]}


class CodexSignalTests(unittest.TestCase):
    run_collector = clients.CollectorTests.run_collector
    post = clients.CollectorTests.post

    def test_four_metric_types_and_model_less_trace_ancestry_are_preserved_privately(self):
        emitted = self.run_collector("true", "true", [
            ("/v1/metrics", metrics(), {"x-ccdash-backend": "bedrock-runtime", "authorization": "private"}),
            ("/v1/traces", traces(), {"x-ccdash-backend": "bedrock-runtime"}),
        ])
        self.assertNotIn("private", json.dumps(emitted))
        metric_rows = [(res, m) for batch in emitted for res in batch.get("resourceMetrics", [])
                       for scope in res["scopeMetrics"] for m in scope["metrics"]]
        self.assertEqual(len(metric_rows), 4)
        for res, metric in metric_rows:
            attrs = values(res["resource"]["attributes"])
            self.assertEqual(attrs["backend"], "bedrock-runtime")
            self.assertEqual(attrs["client"], "codex")
            self.assertEqual(attrs["user.email"], "fixture@example.invalid")
            self.assertEqual(attrs["service.instance.id"], "fixture-process")
            self.assertNotIn("experiment.group", attrs)
            kind = next(k for k in ("sum", "gauge", "histogram", "exponentialHistogram") if k in metric)
            data = metric[kind]
            point = data["dataPoints"][0]
            self.assertEqual(int(point["startTimeUnixNano"]), NOW - 100)
            self.assertEqual(int(point["timeUnixNano"]), NOW)
            self.assertEqual(point["flags"], 1)
            self.assertEqual(values(point["attributes"])["session.id"], "fixture-session")
            if kind != "gauge":
                self.assertEqual(data["aggregationTemporality"], 1)
            if kind == "sum":
                self.assertEqual(point["asDouble"], 7)
                self.assertTrue(data["isMonotonic"])
            if kind in ("histogram", "exponentialHistogram"):
                self.assertEqual(int(point["count"]), 2)
                self.assertEqual(point["sum"], 30)
        span_rows = [(res, s) for batch in emitted for res in batch.get("resourceSpans", [])
                     for scope in res["scopeSpans"] for s in scope["spans"]]
        self.assertEqual({s["name"] for _, s in span_rows}, {"session_task.turn", "run_turn"})
        for res, span in span_rows:
            self.assertEqual(values(res["resource"]["attributes"])["backend"], "bedrock-runtime")
            self.assertEqual(values(res["resource"]["attributes"])["client"], "codex")
            attrs = values(span["attributes"])
            self.assertNotIn("thread.id", attrs)
            self.assertFalse(span.get("events"))
            self.assertFalse(span.get("traceState"))
            self.assertFalse(span["status"].get("message"))
            if span["name"] == "session_task.turn":
                self.assertEqual(attrs["codex.turn.reasoning_effort"], "high")
                self.assertEqual(int(attrs["codex.turn.token_usage.input_tokens"]), 100)
                self.assertEqual(attrs["call_id"], "fixture-call")
            else:
                self.assertEqual(span["parentSpanId"], "0102030405060708")
                self.assertNotIn("model", attrs)

    def test_disabled_codex_and_foreign_provenance_do_not_reach_codex_tables(self):
        for enabled, service in [("false", "codex_exec"), ("true", "unrelated"), ("true", None)]:
            metric_body, span_body = metrics(), traces()
            identity = {"client": "codex", "model": "openai.gpt-6-astra"}
            if service is not None:
                identity["service.name"] = service
            metric_body["resourceMetrics"][0]["resource"]["attributes"] = attributes(identity)
            span_body["resourceSpans"][0]["resource"]["attributes"] = attributes(identity)
            output = self.run_collector("false", enabled, [
                ("/v1/metrics", metric_body, {}), ("/v1/traces", span_body, {}),
            ])
            self.assertFalse(output)

    def test_invalid_header_does_not_overwrite_valid_resource_backend(self):
        output = self.run_collector("false", "true", [
            ("/v1/metrics", metrics(), {"x-ccdash-backend": "https://private.invalid"}),
            ("/v1/traces", traces(), {}),
        ])
        for batch in output:
            for key in ("resourceMetrics", "resourceSpans"):
                for res in batch.get(key, []):
                    self.assertEqual(values(res["resource"]["attributes"])["backend"], "bedrock-mantle")
        self.assertTrue(output)
        self.assertNotIn("private", json.dumps(output))

    def test_unknown_backend_and_unsafe_nested_content_fail_closed(self):
        metric_body, span_body = metrics(), traces()
        for body, key in [(metric_body, "resourceMetrics"), (span_body, "resourceSpans")]:
            res = body[key][0]["resource"]
            res["attributes"] = attributes({**values(res["attributes"]),
                                            "backend": "https://private.invalid",
                                            "ccdash.transport.backend": "bedrock-runtime"})
        point = metric_body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]["sum"]["dataPoints"][0]
        point["exemplars"] = [{"timeUnixNano": str(NOW), "asDouble": 1,
                              "filteredAttributes": attributes({"prompt": "private prompt"})}]
        span_body["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["links"] = [{
            "traceId": "0102030405060708090a0b0c0d0e0f10", "spanId": "0102030405060708",
            "attributes": attributes({"output": "private output"}), "traceState": "private=value",
        }]
        output = self.run_collector("false", "true", [
            ("/v1/metrics", metric_body, {}), ("/v1/traces", span_body, {}),
        ])
        self.assertNotIn("private", json.dumps(output))
        metric_names, span_names = [], []
        for batch in output:
            for key in ("resourceMetrics", "resourceSpans"):
                for res in batch.get(key, []):
                    self.assertNotIn("backend", values(res["resource"]["attributes"]))
                    for scope in res.get("scopeMetrics", []):
                        metric_names.extend(m["name"] for m in scope["metrics"])
                    for scope in res.get("scopeSpans", []):
                        span_names.extend(s["name"] for s in scope["spans"])
        self.assertEqual(len(metric_names), 3)
        self.assertNotIn("codex.tool.call", metric_names)
        self.assertEqual(span_names, ["run_turn"])


if __name__ == "__main__":
    unittest.main()
