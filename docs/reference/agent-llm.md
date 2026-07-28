# Agent · LLM / Agent · LLM 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
"Ask Claude" is a chat assistant embedded in the dashboard, backed by Amazon Bedrock
ConverseStream, that answers usage questions by writing and running its own ClickHouse SQL in
a bounded tool-use loop.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Chat handler | `dashboard/server/chat.js` | SSE endpoint, system prompt, tool-use loop, SQL sandbox |
| Bedrock client | `dashboard/server/chat.js` | `BedrockRuntimeClient` + `ConverseStreamCommand`, model via `CHAT_MODEL_ID`, region via `BEDROCK_REGION` (falls back to `AWS_REGION`, then `us-east-1`) |
| Chat UI | `dashboard/web/src/components/FloatingChat.jsx` | Floating chat widget, SSE consumer, markdown rendering |

### 3. Key Decisions
- **Bounded tool-use loop (`MAX_HOPS = 4`)** -- caps how many `run_sql` round-trips one chat
  turn can make, avoiding runaway loops or excessive Bedrock spend on a single question.
- **System prompt documents the cumulative-counter trap explicitly** -- the model is told, in
  the prompt itself, that `sum(Value)` on `otel_metrics_sum` overcounts and must diff via
  `max()` per session/series first. Without this, the assistant would generate the same
  overcounting bug the query layer was built to avoid.
- **System prompt mirrors the dashboard's actual query surface, not a hand-maintained summary**
  -- it names `otel_metrics_sum_hourly` (the rollup every dashboard query reads) ahead of the
  raw table, and interpolates `GROUP_CTE` from `grouping.js` verbatim for the bedrock/enterprise
  heuristic instead of re-describing it in prose. If the prompt only describes the schema from
  memory (as it did before this was caught), the model can answer "no bedrock/enterprise
  distinction exists in the data" when it does -- it just doesn't know the join. What is
  interpolated tracks its source automatically: `GROUP_CTE` (`grouping.js`), `PRICING_PROMPT_TABLE`
  (`pricing.js`), `normModel()` (`queries.js`). **What must be updated by hand in the same change
  is the hardcoded part of `SCHEMA_CONTEXT`** -- table/column lists, the metric and `TokenType`
  value domains, and the rollup-vs-raw rule -- the same sync discipline as
  `grafana-ab-queries.sql` (see root `CLAUDE.md`).
- **Model is Bedrock-hosted (`CHAT_MODEL_ID`, default `global.anthropic.claude-sonnet-5`)** --
  consistent with the rest of the AWS-native infra; no external LLM API dependency.
- Streaming is SSE (`text/event-stream`), not WebSockets -- simpler to proxy through the same
  Express app and k8s ingress as every other endpoint.
- **Every Bedrock/tool-loop failure is classified (`classifyChatError`) instead of collapsed
  into one generic message** -- throttling, access-denied, and oversized-input each get a
  distinct Korean message plus the Bedrock `requestId`; the raw error (with `hop`, model id,
  AWS error name/status) is still only ever logged server-side, never sent to the client.

### 4. Code Pointers
- `dashboard/server/chat.js` -- `MODEL_ID`, `MAX_HOPS`
- `dashboard/server/chat.js` -- `SCHEMA_CONTEXT` (exported separately from `SYSTEM` so `chat.test.js` can assert on it directly -- schema, temporality branch, per-metric `TokenType` meaning, reported-vs-computed cost, quotes `pricing.js`'s `PRICING_PROMPT_TABLE`)
- `dashboard/server/chat.js` -- `SYSTEM` prompt (intro + `SCHEMA_CONTEXT` + `GROUP_CTE` interpolation + output rules)
- `dashboard/server/chat.js` -- `TOOLS` (the `run_sql` tool spec)
- `dashboard/server/chat.js` -- `capToolResultJson()` (char-capped tool results, guards against cross-hop context growth)
- `dashboard/server/chat.js` -- `classifyChatError()` (AWS error -> user-facing Korean message + requestId)
- `dashboard/server/chat.js` -- `MAX_SQL_CALLS` (total run_sql executions per turn, independent of `MAX_HOPS` round-trips)
- `dashboard/server/chat.js` -- `handleChat()` (SSE stream + tool-use loop; wires an `AbortController` to `res`'s `close` event so a dropped browser connection cancels the in-flight Bedrock call and ClickHouse query, not just the SSE write)
- `dashboard/server/grouping.js` -- `GROUP_CTE` (imported by `chat.js`, not duplicated)
- `dashboard/server/pricing.js` -- `PRICING_PROMPT_TABLE` (imported by `chat.js`, not duplicated -- keeps the chat's cost answers in sync with the Cost page's `withComputedCost`)
- `dashboard/web/src/components/FloatingChat.jsx` -- client-side SSE consumer

### 5. Cross-references
- Related modules: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md), [docs/reference/security.md](security.md)
- Related ADRs: (none yet)
- Related runbooks: [docs/runbooks/ask-claude-chat-troubleshooting.md](../runbooks/ask-claude-chat-troubleshooting.md)

<a id="korean"></a>
## 한국어

### 1. 개요
"Ask Claude"는 대시보드에 내장된 채팅 어시스턴트로, Amazon Bedrock ConverseStream을 기반으로
자체적으로 ClickHouse SQL을 작성·실행하는 제한된 툴콜 루프를 통해 사용량 질문에 답합니다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 채팅 핸들러 | `dashboard/server/chat.js` | SSE 엔드포인트, 시스템 프롬프트, 툴콜 루프, SQL 샌드박스 |
| Bedrock 클라이언트 | `dashboard/server/chat.js` | `BedrockRuntimeClient` + `ConverseStreamCommand`, `CHAT_MODEL_ID`로 모델 지정, 리전은 `BEDROCK_REGION`(없으면 `AWS_REGION`, 없으면 `us-east-1`) |
| 채팅 UI | `dashboard/web/src/components/FloatingChat.jsx` | 플로팅 채팅 위젯, SSE 소비, 마크다운 렌더링 |

### 3. 주요 결정
- **제한된 툴콜 루프(`MAX_HOPS = 4`)** -- 한 번의 채팅 턴이 `run_sql`을 몇 번 왕복할 수
  있는지 상한을 둬서, 한 질문에 대해 루프가 폭주하거나 Bedrock 비용이 과도하게 나가는 걸
  막습니다.
- **시스템 프롬프트가 누적 카운터 함정을 명시적으로 문서화** -- 모델에게 프롬프트 자체에서
  `otel_metrics_sum`의 `sum(Value)`가 과대집계되며 세션/시리즈 단위 `max()`로 먼저 diff해야
  한다고 알려줍니다. 이게 없으면 어시스턴트가 쿼리 레이어가 애초에 피하려 했던 과대집계
  버그를 그대로 재생성하게 됩니다.
- **시스템 프롬프트가 대시보드가 실제로 쓰는 쿼리 표면을 그대로 반영** -- 프롬프트가 직접
  손으로 요약한 스키마가 아니라, 모든 대시보드 쿼리가 읽는 롤업
  `otel_metrics_sum_hourly`를 원본보다 먼저 명시하고, bedrock/enterprise 판별 규칙은
  `grouping.js`의 `GROUP_CTE`를 그대로 보간해서 씁니다(산문으로 재설명하지 않음). 프롬프트가
  스키마를 기억만으로 서술하면(이 문제가 발견되기 전 실제로 그랬음) 모델이 실제로는 있는
  bedrock/enterprise 구분을 "데이터에 없다"고 답할 수 있습니다 — join 방법을 모를 뿐입니다.
  보간되는 부분은 출처를 자동으로 따라갑니다: `GROUP_CTE`(`grouping.js`),
  `PRICING_PROMPT_TABLE`(`pricing.js`), `normModel()`(`queries.js`).
  **같은 변경에서 손으로 갱신해야 하는 건 `SCHEMA_CONTEXT`의 하드코딩 부분입니다** — 테이블·컬럼
  목록, MetricName/`TokenType` 값 도메인, 롤업 vs 원본 선택 규칙 — `grafana-ab-queries.sql`과
  같은 동기화 원칙(루트 `CLAUDE.md` 참고).
- **Bedrock 호스팅 모델(`CHAT_MODEL_ID`, 기본값 `global.anthropic.claude-sonnet-5`)** --
  AWS-네이티브 인프라의 나머지 부분과 일관됨. 외부 LLM API 의존성 없음.
- 스트리밍은 WebSocket이 아니라 SSE(`text/event-stream`) -- 다른 모든 엔드포인트와 같은
  Express 앱/k8s ingress로 프록시하기가 더 단순합니다.
- **모든 Bedrock/툴콜 실패가 하나의 일반 문구로 뭉개지지 않고 분류됩니다(`classifyChatError`)**
  -- throttling·권한 거부·입력 초과가 각각 다른 한국어 문구 + Bedrock `requestId`를 받습니다.
  원문 에러(hop, 모델ID, AWS 에러 이름/상태 포함)는 여전히 서버 로그에만 남고 클라이언트에는
  절대 노출되지 않습니다.

### 4. 코드 포인터
- `dashboard/server/chat.js` -- `MODEL_ID`, `MAX_HOPS`
- `dashboard/server/chat.js` -- `SCHEMA_CONTEXT`(`SYSTEM`과 분리 export — `chat.test.js`가 직접 단언할 수 있게. 스키마, temporality 분기, 메트릭별 `TokenType` 의미, reported vs computed 비용 구분, `pricing.js`의 `PRICING_PROMPT_TABLE` 인용)
- `dashboard/server/chat.js` -- `SYSTEM` 프롬프트(intro + `SCHEMA_CONTEXT` + `GROUP_CTE` 보간 + 출력 규칙)
- `dashboard/server/chat.js` -- `TOOLS`(`run_sql` 툴 스펙)
- `dashboard/server/chat.js` -- `capToolResultJson()`(문자수 상한 툴 결과 — hop 간 컨텍스트 팽창 방지)
- `dashboard/server/chat.js` -- `classifyChatError()`(AWS 에러 → 사용자용 한국어 문구 + requestId)
- `dashboard/server/chat.js` -- `MAX_SQL_CALLS`(한 턴의 총 run_sql 실행 상한 — 왕복 수인 `MAX_HOPS`와는 별개 축)
- `dashboard/server/chat.js` -- `handleChat()`(SSE 스트림 + 툴콜 루프; `res`의 `close` 이벤트에 `AbortController`를 연결해 브라우저 연결이 끊기면 SSE write뿐 아니라 진행 중인 Bedrock 호출·ClickHouse 쿼리도 취소)
- `dashboard/server/grouping.js` -- `GROUP_CTE`(`chat.js`가 import, 복제 없음)
- `dashboard/server/pricing.js` -- `PRICING_PROMPT_TABLE`(`chat.js`가 import, 복제 없음 — 챗의 비용 답변이 Cost 페이지의 `withComputedCost`와 드리프트하지 않게)
- `dashboard/web/src/components/FloatingChat.jsx` -- 클라이언트 측 SSE 소비

### 5. 상호 참조
- 관련 모듈: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md), [docs/reference/security.md](security.md)
- 관련 ADR: (아직 없음)
- 관련 런북: [docs/runbooks/ask-claude-chat-troubleshooting.md](../runbooks/ask-claude-chat-troubleshooting.md)
