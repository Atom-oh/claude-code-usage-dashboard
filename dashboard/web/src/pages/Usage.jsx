import { localeTag, localize, translate, useLocale } from "../i18n/index.js";
import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";
import { useGroupsShown } from "../useGroupsShown.js";
import { useConfig } from "../ConfigContext.jsx";
import { decisionLabel } from "../labels.js";

const fmt = (n) => Number(n || 0).toLocaleString(localeTag());
const pct = (ok, total) => (total > 0 ? `${((ok / total) * 100).toFixed(0)}%` : "—");
// ClickHouse quantile()은 float를 그대로 내려보낸다 — ms 컬럼은 반올림해서 표시.
const ms = (v) => fmt(Math.round(Number(v) || 0));
// render와 CSV 내보내기용 값이 같아야 하는 컬럼용 — 화면의 라벨/단위를 CSV에도 그대로 넣는다.
const pct0 = (v) => `${(Number(v || 0) * 100).toFixed(0)}%`;
// 압축률의 원본 render는 `Number(v)`였다(|| 0 없음) — 동작을 바꾸지 않기 위해 따로 둔다.
const ratioPct0 = (v) => `${(Number(v) * 100).toFixed(0)}%`;
// 오류/실패 컬럼의 render는 0보다 크면 강조용 <span>을 돌려준다 — CSV엔 원본 숫자를 넣는다.
const count = (v) => Number(v) || 0;
// 성공률·사용당 비용은 컬럼 자신의 값이 아니라 row의 다른 필드에서 나온다.
const okRate = (v, r) => pct(v, r.calls);
// null cost is unavailable (non-Anthropic spend without a factor), never $0.
const cost2 = (v) => v == null ? "—" : Number(v).toFixed(2);
const costPerUse = (_v, r) => r.est_cost_usd == null ? "—" : (Number(r.est_cost_usd) / (Number(r.invocations) || 1)).toFixed(3);
// 화면과 CSV에 원시 enum 값이 그대로 나가지 않게 한다. 이 두 맵은 이 페이지에만 필요해
// labels.js로 올리지 않는다. 매핑되지 않은 값은 그대로 통과시킨다.
const SOURCE_LABEL = localize({ config: "설정 사전 허용", user_temporary: "매번 확인", user_permanent: "사용자 허용 목록" });
const sourceLabel = (v) => SOURCE_LABEL[v] ?? v;
const SKILL_TRIGGER_LABEL = localize({ "user-slash": "슬래시 커맨드 호출", "claude-proactive": "자동 발동", "nested-skill": "다른 Skill에서 호출" });
const skillTriggerLabel = (v) => SKILL_TRIGGER_LABEL[v] ?? v;
// 2026-09-09 — tool_result의 decision_source는 위 SOURCE_LABEL(tool_decision의 source)과
// 이벤트가 다르고 값 집합도 다르다(hook이 추가로 있다) — 한 맵으로 합치면 어느 이벤트의
// 라벨인지 알 수 없어져 따로 둔다. 매핑되지 않은 값은 그대로 통과시킨다.
const DECISION_SOURCE_LABEL = localize({
  config: "설정 자동 승인",
  user_temporary: "사용자(1회)",
  user_permanent: "사용자(항상)",
  hook: "훅",
});
const decisionSourceLabel = (v) => DECISION_SOURCE_LABEL[v] ?? v;
// app.entrypoint의 빈 값은 서버가 'terminal'로 바꿔 내려준다(queries.js entrypointBreakdown).
const ENTRYPOINT_LABEL = localize({ vscode: "VS Code 확장", terminal: "터미널" });
const entrypointLabel = (v) => ENTRYPOINT_LABEL[v] ?? v;

// group을 카드 제목으로 좌우 분리해 보여주므로 테이블 안에서는 그룹 컬럼을 뺀다.
const TOOL_MCP_COLUMNS = localize([
  { key: "tool", label: "도구" },
  { key: "mcp_server", label: "MCP 서버" },
  { key: "ok", label: "성공", render: fmt },
  { key: "fail", label: "실패", render: fmt },
  { key: "total", label: "합계", render: fmt },
]);

// 2026-08-31 — 툴 권한 결정 퍼널. source가 핵심: config는 사전 허용(개발자를 안 멈춤),
// user_temporary는 매번 물어봤다는 뜻, user_permanent는 사용자가 직접 허용목록에 넣은 것.
// 상위 20개 툴 × source라 그룹당 수십 행 — SUBAGENT_FANOUT_COLUMNS 주석의 판단 기준상
// group 컬럼 하나로 합치는 쪽이 아니라 TOOL_MCP_COLUMNS처럼 그룹별 카드로 좌우 분리한다.
// 합계(n)가 수락+거부와 다르면 accept/reject 외의 decision 값이 새로 생긴 것.
const TOOL_DECISION_COLUMNS = localize([
  { key: "tool", label: "도구" },
  { key: "source", label: "허용 출처", render: sourceLabel, toText: sourceLabel },
  { key: "accepts", label: "허용", render: fmt },
  { key: "rejects", label: "거부", render: fmt },
  { key: "accept_rate", label: "권한 허용률", render: pct0, toText: pct0 },
  { key: "n", label: "합계", render: fmt },
]);

const TOOL_LATENCY_COLUMNS = localize([
  { key: "tool", label: "도구" },
  { key: "uses", label: "실행", render: fmt },
  { key: "errors", label: "오류", render: (v) => (Number(v) > 0 ? <span className="text-negative-text font-medium">{fmt(v)}</span> : fmt(v)), toText: count },
  { key: "p50_ms", label: "p50 (ms)", render: ms },
  { key: "p95_ms", label: "p95 (ms)", render: ms },
]);

const COMMAND_COLUMNS = localize([
  { key: "command", label: "커맨드" },
  { key: "uses", label: "사용", render: fmt },
  { key: "users", label: "사용자", render: fmt },
]);

// MCP 서버는 그룹당 몇 개뿐이라 SUBAGENT_FANOUT_COLUMNS 주석의 판단 기준대로 좌우 카드 분리
// 대신 group 컬럼 하나로 합친다 — 커넥터 사용 현황(호출량, 수십 행)과 다르게 가는 의도적 선택.
const MCP_HEALTH_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "server", label: "서버" },
  { key: "attempts", label: "시도", render: fmt },
  { key: "connected", label: "성공", render: fmt },
  { key: "failed", label: "실패", render: (v) => (Number(v) > 0 ? <span className="text-negative-text font-medium">{fmt(v)}</span> : fmt(v)), toText: count },
  { key: "p95_ms", label: "p95 (ms)", render: ms },
]);

const CONNECTOR_COLUMNS = localize([
  { key: "connector", label: "커넥터" },
  { key: "users", label: "사용자", render: fmt },
  { key: "calls", label: "호출", render: fmt },
  { key: "ok", label: "성공률", render: okRate, toText: okRate },
]);

const SKILL_COLUMNS = localize([
  { key: "skill", label: "Skill" },
  { key: "invocations", label: "사용 세션 수", render: fmt },
  { key: "est_cost_usd", label: "Claude Code 보고 비용 ($)", render: cost2 },
  { key: "cost_per_use", label: "세션당 비용 ($)", render: costPerUse, toText: costPerUse },
]);

// 2026-08-11 — STEP 3 신규 이벤트 패널. skill_activated의 trigger가 'claude-proactive'인
// 비율이 "우리가 만든 스킬이 실제로 자동 발동하는지"의 핵심 지표(원본 지시서 강조 사항).
const SKILL_ACTIVATION_COLUMNS = localize([
  { key: "skill", label: "Skill" },
  { key: "trigger", label: "발동 방식", render: skillTriggerLabel, toText: skillTriggerLabel },
  { key: "invocations", label: "건수", render: fmt },
]);

const PLUGIN_COLUMNS = localize([
  { key: "plugin", label: "플러그인" },
  { key: "marketplace", label: "마켓플레이스" },
  { key: "session_loads", label: "세션 로드 수", render: fmt },
  { key: "sessions", label: "세션 수", render: fmt },
]);

// 2026-08-11 — 서브에이전트 팬아웃(otel_logs의 subagent_completed, 베타 불필요)과 compaction
// 압박(컨텍스트 한도 프록시). 둘 다 그룹당 행이 적어(≤몇 개) bedrock/enterprise 카드 분리 없이
// group 컬럼 하나로 충분하다 — 위 tool/skill 패턴과 다르게 가는 의도적 선택.
const SUBAGENT_FANOUT_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "subagent_completions", label: "완료 건수", render: fmt },
  { key: "interactions", label: "인터랙션 수", render: fmt },
  { key: "avg_subagents_per_interaction", label: "인터랙션당 평균 에이전트 수" },
]);

const COMPACTION_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "trigger", label: "발생 방식" },
  { key: "compactions", label: "압축 횟수", render: fmt },
  { key: "sessions", label: "세션 수", render: fmt },
  { key: "compactions_per_session", label: "세션당 압축 횟수" },
  { key: "avg_compression_ratio", label: "평균 압축률", render: ratioPct0, toText: ratioPct0 },
]);

// 2026-09-09 — 프로젝트/권한모드/승인출처/진입점. 넷 다 그룹당 행이 적어 group 컬럼 하나로
// 합친다(MCP_HEALTH_COLUMNS와 같은 판단). 비용 컬럼의 라벨이 "Claude Code 보고 비용"인 이유는
// SKILL_COLUMNS와 같다 — 토큰×단가 계산 비용이 아니라 클라이언트가 보고한 값이고, Claude Code
// 버전에 따라 달라진다(실측 2026-09-03).
const PROJECT_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "project", label: "프로젝트" },
  { key: "cost_usd", label: "Claude Code 보고 비용 ($)", render: cost2 },
  { key: "tokens", label: "토큰", render: fmt },
  { key: "sessions", label: "세션", render: fmt },
  { key: "users", label: "사용자", render: fmt },
]);

const PERMISSION_MODE_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "from_mode", label: "이전 모드" },
  { key: "to_mode", label: "변경 모드" },
  { key: "changes", label: "횟수", render: fmt },
  { key: "sessions", label: "세션", render: fmt },
]);

const DECISION_SOURCE_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "decision_source", label: "승인 출처", render: decisionSourceLabel, toText: decisionSourceLabel },
  { key: "decision_type", label: "결정", render: decisionLabel, toText: decisionLabel },
  { key: "tool_results", label: "건수", render: fmt },
  { key: "share", label: "비율", render: pct0, toText: pct0 },
]);

const ENTRYPOINT_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "entrypoint", label: "진입점", render: entrypointLabel, toText: entrypointLabel },
  { key: "requests", label: "요청", render: fmt },
  { key: "sessions", label: "세션", render: fmt },
  { key: "users", label: "사용자", render: fmt },
  { key: "cost_usd", label: "Claude Code 보고 비용 ($)", render: (v) => Number(v).toFixed(2) },
]);

export default function Usage() {
  const _locale = useLocale();
  const shownGroups = useGroupsShown();
  const { schema } = useConfig();
  const toolMcp = useApi("/api/usage/tool-mcp");
  const toolDecisions = useApi("/api/usage/tool-decisions");
  const skills = useApi("/api/usage/skills");
  const connectors = useApi("/api/usage/connectors");
  const skillActivations = useApi("/api/usage/skill-activations");
  const plugins = useApi("/api/usage/plugins");
  const subagentFanout = useApi("/api/usage/subagent-fanout");
  const compaction = useApi("/api/usage/compaction");
  const toolLatency = useApi("/api/usage/tool-latency");
  const commands = useApi("/api/usage/commands");
  const hookOverhead = useApi("/api/usage/hook-overhead");
  const mcpHealth = useApi("/api/usage/mcp-health");
  const entrypoints = useApi("/api/usage/entrypoints");
  const permissionModes = useApi("/api/usage/permission-modes");
  const decisionSources = useApi("/api/usage/decision-sources");
  // 훅은 조건부로 호출할 수 없으므로 항상 부르고 렌더만 가린다 — 005 미적용 클러스터에서는
  // 서버가 즉시 빈 배열을 돌려준다(index.js의 projectColumns 게이트).
  const projects = useApi("/api/usage/projects");

  return (
    <div>
      <PageHeader title={translate("m8d59829c1e15")} subtitle={translate("mb9ca32b5e522")} right={<RangePicker />} />
      <div className="p-8 flex flex-col gap-4">
        {entrypoints.loading ? (
          <Loading />
        ) : entrypoints.error ? (
          <ErrorBox error={entrypoints.error} />
        ) : (
          <DataTable
            title={translate("m9091d6907626")}
            subtitle={translate("mc5ee94fe0d16")}
            help={translate("m692eef2ce5eb")}
            columns={ENTRYPOINT_COLUMNS}
            rows={entrypoints.data || []}
            exportName="usage_entrypoints"
            stale={entrypoints.stale}
          />
        )}

        {schema?.projectColumns === true ? (
          projects.loading ? (
            <Loading />
          ) : projects.error ? (
            <ErrorBox error={projects.error} />
          ) : (
            <DataTable
              title={translate("m85f476a71c66")}
              subtitle={translate("m90a16cfd481f")}
              help={translate("m67d6e460845f")}
              columns={PROJECT_COLUMNS}
              rows={projects.data || []}
              exportName="usage_projects"
              stale={projects.stale}
            />
          )
        ) : null}

        {toolMcp.loading ? (
          <Loading />
        ) : toolMcp.error ? (
          <ErrorBox error={toolMcp.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(toolMcp.data).map((g) => (
              <DataTable
                key={g}
                title={translate("mac5da77c2d6f", [g])}
                subtitle={translate("mec0201aec245")}
                help={translate("m93be0a86c168")}
                columns={TOOL_MCP_COLUMNS}
                rows={(toolMcp.data || []).filter((r) => r.group === g)}
                exportName={`usage_tool_mcp_${g}`}
                stale={toolMcp.stale}
              />
            ))}
          </div>
        )}

        {toolDecisions.loading ? (
          <Loading />
        ) : toolDecisions.error ? (
          <ErrorBox error={toolDecisions.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(toolDecisions.data).map((g) => (
              <DataTable
                key={g}
                title={translate("m9eb2acc1adb8", [g])}
                subtitle={translate("m20c2ee07a05b")}
                help={translate("m0b5372afcef1")}
                columns={TOOL_DECISION_COLUMNS}
                rows={(toolDecisions.data || []).filter((r) => r.group === g)}
                exportName={`usage_tool_decisions_${g}`}
                stale={toolDecisions.stale}
              />
            ))}
          </div>
        )}

        {permissionModes.loading ? (
          <Loading />
        ) : permissionModes.error ? (
          <ErrorBox error={permissionModes.error} />
        ) : (
          <DataTable
            title={translate("m568d09119ddc")}
            subtitle={translate("mb1759473d342")}
            help={translate("ma6529cbfa160")}
            columns={PERMISSION_MODE_COLUMNS}
            rows={permissionModes.data || []}
            exportName="usage_permission_modes"
            stale={permissionModes.stale}
          />
        )}

        {decisionSources.loading ? (
          <Loading />
        ) : decisionSources.error ? (
          <ErrorBox error={decisionSources.error} />
        ) : (
          <DataTable
            title={translate("m6b64b7b11204")}
            subtitle={translate("mc6408ab4495e")}
            help={translate("md8523a9467d9")}
            columns={DECISION_SOURCE_COLUMNS}
            rows={decisionSources.data || []}
            exportName="usage_decision_sources"
            stale={decisionSources.stale}
          />
        )}

        {toolLatency.loading ? (
          <Loading />
        ) : toolLatency.error ? (
          <ErrorBox error={toolLatency.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(toolLatency.data).map((g) => (
              <DataTable
                key={g}
                title={translate("m751918f20531", [g])}
                subtitle={translate("mf386610058c6")}
                help={translate("m45eb21819f0d")}
                columns={TOOL_LATENCY_COLUMNS}
                rows={(toolLatency.data || [])
                  .filter((r) => r.group === g)
                  .sort((a, b) => Number(b.uses) - Number(a.uses))
                  .slice(0, 10)}
                exportName={`usage_tool_latency_${g}`}
                stale={toolLatency.stale}
              />
            ))}
          </div>
        )}

        {connectors.loading ? (
          <Loading />
        ) : connectors.error ? (
          <ErrorBox error={connectors.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(connectors.data).map((g) => (
              <DataTable
                key={g}
                title={translate("m558d6db6f523", [g])}
                subtitle={translate("mdcc3443eeea5")}
                help={translate("m7afaf969e6cf")}
                columns={CONNECTOR_COLUMNS}
                rows={(connectors.data || []).filter((r) => r.group === g)}
                exportName={`usage_connectors_${g}`}
                stale={connectors.stale}
              />
            ))}
          </div>
        )}

        {mcpHealth.loading ? (
          <Loading />
        ) : mcpHealth.error ? (
          <ErrorBox error={mcpHealth.error} />
        ) : (
          <DataTable
            title={translate("m92e4328fde4a")}
            subtitle={translate("m4cd78e58e461")}
            help={translate("m8dd94827556c")}
            columns={MCP_HEALTH_COLUMNS}
            rows={mcpHealth.data || []}
            exportName="usage_mcp_health"
            stale={mcpHealth.stale}
          />
        )}

        {skills.loading ? (
          <Loading />
        ) : skills.error ? (
          <ErrorBox error={skills.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(skills.data).map((g) => (
              <DataTable
                key={g}
                title={translate("m3e8bea620661", [g])}
                subtitle={translate("mc558a5ab7c26")}
                help={translate("mac4b8b766a5c")}
                columns={SKILL_COLUMNS}
                rows={(skills.data || []).filter((r) => r.group === g)}
                exportName={`usage_skills_${g}`}
                stale={skills.stale}
              />
            ))}
          </div>
        )}

        {skillActivations.loading ? (
          <Loading />
        ) : skillActivations.error ? (
          <ErrorBox error={skillActivations.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(skillActivations.data).map((g) => (
              <DataTable
                key={g}
                title={translate("mf193bbffe651", [g])}
                subtitle={translate("mc24c60e2dd16")}
                help={translate("m26b11547784c")}
                columns={SKILL_ACTIVATION_COLUMNS}
                rows={(skillActivations.data || []).filter((r) => r.group === g)}
                exportName={`usage_skill_activations_${g}`}
                stale={skillActivations.stale}
              />
            ))}
          </div>
        )}

        {plugins.loading ? (
          <Loading />
        ) : plugins.error ? (
          <ErrorBox error={plugins.error} />
        ) : (
          <DataTable
            title={translate("m811098264838")}
            subtitle={translate("me40a14de3632")}
            help={translate("m889d1a6acdc3")}
            columns={PLUGIN_COLUMNS}
            rows={plugins.data || []}
            exportName="usage_plugins"
            stale={plugins.stale}
          />
        )}

        {subagentFanout.loading ? (
          <Loading />
        ) : subagentFanout.error ? (
          <ErrorBox error={subagentFanout.error} />
        ) : (
          <DataTable
            title={translate("mbb19d40017ab")}
            subtitle={translate("mc187e91d67e7")}
            help={translate("maf060ad55f8d")}
            columns={SUBAGENT_FANOUT_COLUMNS}
            rows={subagentFanout.data || []}
            exportName="usage_subagent_fanout"
            stale={subagentFanout.stale}
          />
        )}

        {compaction.loading ? (
          <Loading />
        ) : compaction.error ? (
          <ErrorBox error={compaction.error} />
        ) : (
          <DataTable
            title={translate("m1e8953f803d0")}
            subtitle={translate("m3f50cf8fdc6f")}
            help={translate("m31ed66ebfb9c")}
            columns={COMPACTION_COLUMNS}
            rows={compaction.data || []}
            exportName="usage_compaction"
            stale={compaction.stale}
          />
        )}

        {commands.loading ? (
          <Loading />
        ) : commands.error ? (
          <ErrorBox error={commands.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(commands.data?.commands).map((g) => (
              <DataTable
                key={g}
                title={translate("m75d0ef44d02f", [g])}
                subtitle={translate("mbb3373c14e4a")}
                columns={COMMAND_COLUMNS}
                rows={(commands.data?.commands || []).filter((r) => r.group === g)}
                exportName={`usage_commands_${g}`}
                stale={commands.stale}
              />
            ))}
          </div>
        )}

        {commands.loading ? (
          <Loading />
        ) : commands.error ? (
          <ErrorBox error={commands.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(commands.data?.prompts).map((g) => {
              const r = (commands.data?.prompts || []).find((row) => row.group === g);
              return (
                <Card key={g} title={translate("m08526c3211c0", [g])} subtitle={translate("ma4d106b12732")} help={translate("m0ba9a0294853")}>
                  <div className="grid grid-cols-3 gap-4">
                    <StatTile label={translate("m04a034dc45fc")} value={r ? fmt(r.prompts) : "—"} />
                    <StatTile label={translate("m97ddcd7738e2")} value={r ? fmt(Math.round(Number(r.p50_len) || 0)) : "—"} />
                    <StatTile label={translate("mf2aadf53e881")} value={r ? fmt(Math.round(Number(r.p95_len) || 0)) : "—"} />
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {hookOverhead.loading ? (
          <Loading />
        ) : hookOverhead.error ? (
          <ErrorBox error={hookOverhead.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(hookOverhead.data).map((g) => {
              const r = (hookOverhead.data || []).find((row) => row.group === g);
              return (
                <Card key={g} title={translate("mea34a2036c99", [g])} subtitle={translate("m04618ca493d2")} help={translate("me4d112db4fca")}>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatTile label={translate("m08c48f7106d7")} value={r ? fmt(r.executions) : "—"} />
                    <StatTile label={translate("m84bdeeac45c4")} value={r ? fmt(Math.round(Number(r.total_seconds) || 0)) : "—"} />
                    <StatTile label="p95 (ms)" value={r ? ms(r.p95_ms) : "—"} />
                    <StatTile label={translate("mcd8ee1928c63")} value={r ? fmt(r.blocked) : "—"} variant={Number(r?.blocked) > 0 ? "danger" : "default"} />
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
