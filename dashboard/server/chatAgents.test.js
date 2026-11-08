import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createChatHandler, runConverseTurn, CHAT_MODEL_ID, ANALYSIS_MODEL_ID, PRICING_TABLE_SLOT } from "./chat.js";
import { setPriceListLayersForTesting } from "./priceCatalog.js";

class Response extends EventEmitter {
  chunks = [];
  writableEnded = false;
  writeHead() {}
  write(chunk) { this.chunks.push(chunk); }
  end() { this.writableEnded = true; this.emit("close"); }
}
const request = () => ({ ip: "fixture", body: { messages: [{ role: "user", content: "비용 분석과 차트를 보여줘" }] } });
const done = (text = "answer") => ({ content: [{ text }], stopReason: "end_turn", truncatedToolIds: new Set() });
const tool = (name, input, id = name) => ({
  content: [{ toolUse: { name, input, toolUseId: id } }],
  stopReason: "tool_use", truncatedToolIds: new Set(),
});
const delegate = () => tool("analyze_data", { question: "비용 분석과 차트를 보여줘" });
function writerEvidence(messages) {
  const block = messages.at(-1).content.find(b => b.text?.startsWith("분석 결과"));
  return JSON.parse(block.text.slice(block.text.indexOf("{"))).analysis_results;
}
function assertSuccess(response) {
  assert.ok(response.chunks.some(c => c.startsWith("event: done")));
  assert.ok(!response.chunks.some(c => c.startsWith("event: error")));
}

test("analysis pins live pricing across signed tool rounds and refreshes on the next HTTP turn", async (t) => {
  t.after(() => setPriceListLayersForTesting());
  const prices = (input) => setPriceListLayersForTesting({
    runtime: { fetchedAt: "2026-11-08T00:00:00Z", codex: {},
      claude: { "claude-sonnet-5": { input, output: 9, cacheWrite: 8, cacheWrite1h: 11, cacheRead: 1 } } },
  });
  prices(7);
  const prompts = [];
  const handler = createChatHandler({
    limit: () => false,
    query: async () => ({ rows: [{ cost: 1 }], truncated: false }),
    runTurn: async ({ agent, allowTools, analysisSystem }) => {
      if (agent === "chat") return allowTools ? delegate() : done();
      prompts.push(analysisSystem);
      if (prompts.length === 1) {
        prices(17);
        return tool("run_sql", { sql: "SELECT 1 AS cost" });
      }
      return done("Observed cost.");
    },
  });
  const first = new Response();
  await handler(request(), first);
  assertSuccess(first);
  assert.equal(typeof prompts[0], "string");
  assert.match(prompts[0], /claude-sonnet-5: input \$7,/);
  assert.ok(!prompts[0].includes(PRICING_TABLE_SLOT));
  assert.equal(prompts[1], prompts[0]);
  const second = new Response();
  await handler(request(), second);
  assertSuccess(second);
  assert.match(prompts[2], /claude-sonnet-5: input \$17,/);
});

test("ordinary chat uses only the conversation agent and never queries", async () => {
  const roles = [];
  const res = new Response();
  await createChatHandler({ limit: () => false,
    query: async () => { assert.fail("ordinary chat must not query"); },
    runTurn: async ({ agent, send }) => { roles.push(agent); send("text", { text: "안녕하세요" }); return done(); },
  })(request(), res);
  assert.deepEqual(roles, ["chat"]);
  assert.ok(res.chunks.some(c => c.includes("안녕하세요")));
  assertSuccess(res);
});

test("delegation keeps model histories separate and returns a compact tool-free final answer", async () => {
  const roles = [];
  const response = new Response();
  let signal, analysisTurns = 0;
  await createChatHandler({ limit: () => false,
    query: async (_sql, active) => { assert.equal(active, signal); return { rows: [{ cost: 2 }], truncated: false }; },
    runTurn: async ({ agent, messages, allowTools, abortSignal, send }) => {
      roles.push(agent);
      signal ??= abortSignal;
      assert.equal(abortSignal, signal);
      if (agent === "chat" && allowTools) {
        return { ...delegate(), content: [
          { reasoningContent: { reasoningText: { text: "private router", signature: "router-signature" } } },
          ...delegate().content,
        ] };
      }
      if (agent === "analysis") {
        assert.ok(!JSON.stringify(messages).includes("router-signature"));
        if (!analysisTurns++) return tool("run_sql", { sql: "SELECT 2 AS cost" });
        send("text", { text: "private analysis notes" });
        return done("observed cost 2; reported basis; no invoice claim");
      }
      assert.equal(allowTools, false);
      assert.ok(!JSON.stringify(messages).includes("router-signature"));
      assert.ok(!messages.some(m => m.content.some(b => b.toolUse || b.toolResult || b.reasoningContent)));
      assert.ok(!JSON.stringify(messages).includes('"rows"'));
      assert.ok(JSON.stringify(messages).includes("observed cost 2"));
      send("text", { text: "최종 답변" });
      return done();
    },
  })(request(), response);
  assert.deepEqual(roles, ["chat", "analysis", "analysis", "chat"]);
  assertSuccess(response);
});

test("charts select masked stored query data; no data arrays are sent back to the writer", async () => {
  let analysisTurns = 0;
  const res = new Response();
  await createChatHandler({ limit: () => false, mask: true,
    query: async () => ({ rows: [{ model: "synthetic@example.invalid", cost: null }, { model: "other", cost: 0 }], truncated: true }),
    runTurn: async ({ agent, allowTools, messages }) => {
      if (agent === "chat") {
        if (allowTools) return delegate();
        assert.ok(!JSON.stringify(messages).includes('"data"'));
        return done();
      }
      if (analysisTurns++ === 0) return tool("run_sql", { sql: "SELECT Model AS model, 0 AS cost FROM otel_logs" });
      if (analysisTurns === 2) {
        const resultId = messages.at(-1).content[0].toolResult.content[0].json.result_id;
        return tool("show_chart", { result_id: resultId, type: "bar", title: "모델 비용", x: "model",
          series: [{ key: "cost", label: "비용" }], unit: "usd" });
      }
      return done("Partial cost results; unknown cost is unavailable.");
    },
  })(request(), res);
  const chartEvent = res.chunks.find(c => c.startsWith("event: chart"));
  assert.ok(chartEvent);
  const chart = JSON.parse(chartEvent.split("data: ")[1]);
  assert.deepEqual(chart.data.map(r => r.cost), [null, 0]);
  assert.equal(chart.data[0].model, "sy******@example.invalid");
  assert.equal(chart.truncated, true);
  assert.equal(chart.source, "sql");
  assert.ok(res.chunks.some(c => c.startsWith("event: done")));
});

test("a conversation agent cannot execute SQL or keep requesting tools after the final answer", async () => {
  let calls = 0, queries = 0;
  const res = new Response();
  await createChatHandler({ limit: () => false,
    query: async () => { queries++; return { rows: [], truncated: false }; },
    runTurn: async () => { calls++; return tool("run_sql", { sql: "SELECT 1" }); },
  })(request(), res);
  assert.equal(queries, 0);
  assert.equal(calls, 2);
  assert.ok(res.chunks.some(c => c.startsWith("event: error")));
  assert.ok(!res.chunks.some(c => c.startsWith("event: done")));
});

test("Bedrock calls use Haiku for chat, Sonnet for analysis and never send analysis tools to chat", async () => {
  const commands = [];
  const sdk = { send: async cmd => {
    commands.push(cmd.input);
    return { stream: (async function* () { yield { messageStop: { stopReason: "end_turn" } }; })() };
  } };
  const configuration = { messages: [{ role: "user", content: [{ text: "synthetic" }] }],
    send: () => {}, abortSignal: new AbortController().signal, sdk, now: "2026-11-07T00:00:00Z" };
  await runConverseTurn({ ...configuration, agent: "chat", allowTools: true });
  await runConverseTurn({ ...configuration, agent: "analysis", allowTools: true });
  await runConverseTurn({ ...configuration, agent: "chat", allowTools: false });
  assert.equal(commands[0].modelId, CHAT_MODEL_ID);
  assert.equal(commands[1].modelId, ANALYSIS_MODEL_ID);
  assert.ok(!commands[1].system[0].text.includes(PRICING_TABLE_SLOT));
  assert.deepEqual(commands[0].toolConfig.tools.map(t => t.toolSpec.name), ["analyze_data"]);
  assert.deepEqual(commands[1].toolConfig.tools.map(t => t.toolSpec.name), ["run_sql", "get_usage_summary", "show_chart"]);
  assert.equal(commands[2].toolConfig, undefined);
  assert.ok(commands[0].system[0].text.length < commands[1].system[0].text.length / 3);
  assert.ok(!commands[0].system[0].text.includes("CREATE TABLE"));
});

test("one request permits only one analysis delegation even with repeated tool blocks", async () => {
  let analysisCalls = 0, chatCalls = 0;
  const response = new Response();
  await createChatHandler({ limit: () => false, runTurn: async ({ agent, messages }) => {
    if (agent === "analysis") { analysisCalls++; return done("Known facts"); }
    if (!chatCalls++) return { ...delegate(), content: [
      ...delegate().content, ...tool("analyze_data", { question: "another" }, "second").content,
    ] };
    assert.ok(writerEvidence(messages).some(result => result.status === "error"));
    return done();
  } })(request(), response);
  assert.equal(analysisCalls, 1);
  assert.equal(chatCalls, 2);
  assertSuccess(response);
});

test("unknown analysis tools and forged final tool requests never execute SQL", async () => {
  let analysisTurns = 0, queries = 0;
  const res = new Response();
  await createChatHandler({ limit: () => false,
    query: async () => { queries++; return { rows: [], truncated: false }; },
    runTurn: async ({ agent, allowTools, messages }) => {
      if (agent === "chat") return allowTools ? delegate() : done();
      if (analysisTurns++ === 0) return tool("unknown_tool", { sql: "SELECT 1" });
      if (allowTools) {
        assert.equal(messages.at(-1).content[0].toolResult.status, "error");
        return tool("unknown_tool", { sql: "SELECT 1" });
      }
      assert.ok(!messages.some(m => m.content.some(b => b.toolUse || b.toolResult || b.reasoningContent)));
      return tool("run_sql", { sql: "SELECT 1" });
    },
  })(request(), res);
  assert.equal(queries, 0);
  assert.equal(analysisTurns, 5);
  assert.ok(res.chunks.some(c => c.startsWith("event: error")));
});

test("canonical summaries preserve source, effective range, masking and partial flags in charts", async () => {
  let rounds = 0;
  const response = new Response();
  const effective_range = { from: "2026-11-06T00:00:00Z", to: "2026-11-07T00:00:00Z" };
  await createChatHandler({ limit: () => false, mask: true,
    query: async () => { assert.fail("canonical request must not use model-written SQL"); },
    lookupUsage: async (_input, signal) => {
      assert.equal(signal.aborted, false);
      return { rows: [{ user: "synthetic@example.invalid", label: "codex · bedrock-mantle · synthetic@example.invalid",
        cost_usd: null, cost_partial: true, tokens_partial: true }],
        totals: { cost_usd: null, cost_partial: true }, quality: { unpriced: 1 }, effective_range,
        source: "dashboard", truncated: false, cache_write_ttl: "1h" };
    },
    runTurn: async ({ agent, allowTools, messages }) => {
      if (agent === "chat") return allowTools ? delegate() : done();
      if (!rounds++) return tool("get_usage_summary", { ...effective_range, dimension: "user" });
      if (rounds === 2) {
        const value = messages.at(-1).content[0].toolResult.content[0].json;
        assert.equal(value.rows[0].user, "sy******@example.invalid");
        assert.equal(value.rows[0].label, "codex · bedrock-mantle · sy******@example.invalid");
        assert.equal(value.totals.cost_usd, null);
        assert.deepEqual(value.effective_range, effective_range);
        return tool("show_chart", { result_id: value.result_id, type: "bar", x: "user", title: "비용",
          series: [{ key: "cost_usd", label: "비용" }], unit: "usd" });
      }
      return done("Unknown costs remain unavailable; observed coverage is partial.");
    },
  })(request(), response);
  const chart = JSON.parse(response.chunks.find(c => c.startsWith("event: chart")).split("data: ")[1]);
  assert.equal(chart.source, "dashboard");
  assert.equal(chart.partial, true);
  assert.equal(chart.data[0].cost_usd, null);
  assert.deepEqual(chart.effective_range, effective_range);
});

test("a truncated analysis tool call is not executed and yields an incomplete evidence summary", async () => {
  let rounds = 0;
  const response = new Response();
  await createChatHandler({ limit: () => false,
    query: async () => { assert.fail("truncated SQL must never execute"); },
    runTurn: async ({ agent, allowTools, messages }) => {
      if (agent === "chat") {
        if (allowTools) return delegate();
        assert.equal(writerEvidence(messages)[0].evidence[0].json.incomplete, true);
        return done("The analysis output was cut off.");
      }
      if (allowTools) {
        rounds++;
        return { ...tool("run_sql", { sql: "SELECT" }), stopReason: "max_tokens",
          truncatedToolIds: new Set(["run_sql"]) };
      }
      assert.equal(allowTools, false);
      assert.ok(!messages.some(m => m.content.some(b => b.toolUse || b.toolResult)));
      return done("No completed evidence. A shorter request is needed.");
    },
  })(request(), response);
  assert.equal(rounds, 1);
  assertSuccess(response);
});

test("router text and final answer have a separator after delegation", async () => {
  const response = new Response();
  await createChatHandler({ limit: () => false,
    runTurn: async ({ agent, allowTools, send }) => {
      if (agent === "chat" && allowTools) { send("text", { text: "조회하겠습니다." }); return delegate(); }
      if (agent === "analysis") return done("Observed evidence.");
      send("text", { text: "분석 결과입니다." });
      return done();
    },
  })(request(), response);
  const texts = response.chunks.filter(c => c.startsWith("event: text")).map(c => JSON.parse(c.split("data: ")[1]).text);
  assert.deepEqual(texts, ["조회하겠습니다.", "\n\n", "분석 결과입니다."]);
  assertSuccess(response);
});

test("labels exceeding the chart bound after masking produce tool feedback without a false display acknowledgment", async () => {
  let rounds = 0;
  const response = new Response();
  const title = "x".repeat(148) + " a@b.invalid";
  assert.equal(title.length, 160);
  await createChatHandler({ limit: () => false,
    query: async () => ({ rows: [{ model: "synthetic", cost: 1 }], truncated: false }),
    runTurn: async ({ agent, allowTools, messages }) => {
      if (agent === "chat") return allowTools ? delegate() : done();
      if (!rounds++) return tool("run_sql", { sql: "SELECT 1 AS cost, 'synthetic' AS model" });
      if (rounds === 2) return tool("show_chart", {
        result_id: "query_1", type: "bar", x: "model", title,
        series: [{ key: "cost", label: "Cost" }], unit: "usd",
      });
      assert.equal(messages.at(-1).content[0].toolResult.status, "error");
      return done("The title needs to be shorter.");
    },
  })(request(), response);
  assert.ok(!response.chunks.some(c => c.startsWith("event: chart")));
  assertSuccess(response);
});

test("analysis usage queries receive the shared disconnect cancellation signal", async () => {
  const response = new Response();
  let cancelled = false, calls = 0;
  await createChatHandler({ limit: () => false,
    lookupUsage: async (_input, signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
        response.destroyed = true;
        response.emit("close");
      });
    },
    runTurn: async ({ agent }) => { calls++; return agent === "chat" ? delegate() : tool("get_usage_summary", {}); },
  })(request(), response);
  assert.equal(cancelled, true);
  assert.equal(calls, 2);
  assert.ok(!response.chunks.some(c => /event: (done|error)/.test(c)));
});
