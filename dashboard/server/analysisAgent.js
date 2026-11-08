import { buildChatChart, CHART_TOOL } from "./chatCharts.js";
import { USAGE_TOOL } from "./analysisData.js";

export const ANALYSIS_TOOLS = { tools: [
  { toolSpec: {
    name: "run_sql",
    description: "Run a read-only ClickHouse SELECT/WITH query (at most 200 rows). Returns a result_id for chart selection.",
    inputSchema: { json: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
  } },
  USAGE_TOOL,
  CHART_TOOL,
] };

const MAX_ROUNDS = 4;
const MAX_QUERIES = 8;
const MAX_CHARTS = 3;

// Owns a private Sonnet conversation. Haiku reasoning and raw tool transcripts
// never enter this history, and Sonnet reasoning never returns to Haiku.
export async function runAnalysisAgent({ messages, question, runTurn, executeQuery, executeUsage, send, abortSignal, maskText }) {
  const history = messages.map(m => ({
    role: m.role, content: m.content.filter(block => typeof block.text === "string").map(block => ({ text: block.text })),
  })).filter(m => m.content.length);
  const context = `분석 요청: ${question}`;
  if (history.at(-1)?.role === "user") history.at(-1).content.push({ text: context });
  else history.push({ role: "user", content: [{ text: context }] });
  const results = new Map(), requests = new Map();
  let queries = 0, charts = 0, last, lastFeedback = [], summaryLimited = false, incompleteToolOutput = false;
  // Analysis prose is private working material; stream only its trace/status.
  const analysisSend = (event, data) => { if (event !== "text") send(event, data); };
  const call = allowTools => runTurn({
    agent: "analysis", messages: history, allowTools, send: analysisSend, abortSignal,
  });
  for (let round = 0; round < MAX_ROUNDS; round++) {
    abortSignal.throwIfAborted();
    send("status", { message: round === 0 ? "분석을 시작하는 중..." : "조회 결과를 분석하는 중..." });
    last = await call(true);
    abortSignal.throwIfAborted();
    history.push({ role: "assistant", content: last.content });
    incompleteToolOutput = last.stopReason === "max_tokens" && last.content.some(block => block.toolUse);
    if (last.stopReason !== "tool_use") break;
    const feedback = [];
    for (const block of last.content) {
      if (!block.toolUse) continue;
      abortSignal.throwIfAborted();
      const { toolUseId, name, input } = block.toolUse;
      try {
        if (last.truncatedToolIds?.has(toolUseId)) throw new Error("Tool input was truncated. Retry with a shorter input.");
        let result;
        if (name === "run_sql" || name === "get_usage_summary") {
          if (queries >= MAX_QUERIES) throw new Error("The query budget is exhausted.");
          queries++; // Invalid SQL consumes a slot, too.
          const value = name === "run_sql" ? await executeQuery(input?.sql, abortSignal) : await executeUsage(input, abortSignal);
          abortSignal.throwIfAborted();
          const id = `query_${queries}`;
          results.set(id, value);
          // Keep the producing tool call (email-masked, bounded) so a tool-free summary can attribute each result.
          requests.set(id, { tool: name, input: maskText(JSON.stringify(name === "run_sql" ? { sql: input?.sql } : input ?? {})).slice(0, 2000) });
          result = { ...value, result_id: id };
        } else if (name === "show_chart") {
          if (charts >= MAX_CHARTS) throw new Error("The chart budget is exhausted.");
          const chart = buildChatChart(input, results);
          // Custom labels might echo user-supplied PII; match the SQL trace policy.
          chart.title = maskText(chart.title);
          chart.series = chart.series.map(s => ({ ...s, label: maskText(s.label) }));
          if (chart.title.length > 160 || chart.series.some(s => s.label.length > 160))
            throw new Error("Masked chart labels exceed 160 characters. Use shorter labels.");
          send("chart", chart);
          result = { displayed: true, chart: ++charts, truncated: chart.truncated, partial: chart.partial };
        } else {
          throw new Error("Unknown analysis tool.");
        }
        feedback.push({ toolResult: { toolUseId, content: [{ json: result }] } });
      } catch (err) {
        if (abortSignal.aborted) throw err;
        feedback.push({ toolResult: { toolUseId, status: "error", content: [{ text: maskText(err.message) }] } });
      }
    }
    if (!feedback.length) throw new Error("Analysis requested tools without a tool call.");
    lastFeedback = feedback;
    history.push({ role: "user", content: feedback });
  }
  const budgetExhausted = last.stopReason === "tool_use";
  if (last.stopReason === "tool_use" || incompleteToolOutput) {
    abortSignal.throwIfAborted();
    // Start a fresh text-only summary request: a tool-free Bedrock request must
    // not carry toolUse/toolResult or another conversation's signed thinking.
    const observations = [];
    let size = 0;
    for (const [result_id, value] of [...results.entries()].reverse()) {
      const item = { result_id, request: requests.get(result_id), ...value };
      const length = JSON.stringify(item).length;
      if (size + length > 40000) { summaryLimited = true; continue; }
      size += length;
      observations.push(item);
    }
    last = await runTurn({
      agent: "analysis", allowTools: false, send: analysisSend, abortSignal,
      messages: [{ role: "user", content: [{ text: JSON.stringify({
        question, observations, observations_truncated: summaryLimited,
        output_truncated: incompleteToolOutput,
        last_errors: lastFeedback.filter(b => b.toolResult.status === "error").map(b => b.toolResult.content),
        instruction: "Summarize the observed evidence, limits and unresolved requests. Do not request tools.",
      }) }] }],
    });
  }
  abortSignal.throwIfAborted();
  if (last.content.some(b => b.toolUse) || last.stopReason === "tool_use")
    throw new Error("Analysis requested tools after its budget was exhausted.");
  const text = last.content.filter(b => b.text).map(b => b.text).join("\n");
  return {
    summary: text.slice(0, 12000), queries, charts,
    budget_exhausted: budgetExhausted,
    incomplete: incompleteToolOutput || summaryLimited || last.stopReason !== "end_turn" || text.length > 12000 || !text.trim(),
  };
}
