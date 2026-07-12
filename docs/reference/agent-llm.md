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
| Bedrock client | `dashboard/server/chat.js` | `BedrockRuntimeClient` + `ConverseStreamCommand`, model via `CHAT_MODEL_ID` |
| Chat UI | `dashboard/web/src/components/FloatingChat.jsx` | Floating chat widget, SSE consumer, markdown rendering |

### 3. Key Decisions
- **Bounded tool-use loop (`MAX_HOPS = 4`)** -- caps how many `run_sql` round-trips one chat
  turn can make, avoiding runaway loops or excessive Bedrock spend on a single question.
- **System prompt documents the cumulative-counter trap explicitly** -- the model is told, in
  the prompt itself, that `sum(Value)` on `otel_metrics_sum` overcounts and must diff via
  `max()` per session/series first. Without this, the assistant would generate the same
  overcounting bug the query layer was built to avoid.
- **Model is Bedrock-hosted (`CHAT_MODEL_ID`, default `global.anthropic.claude-sonnet-5`)** --
  consistent with the rest of the AWS-native infra; no external LLM API dependency.
- Streaming is SSE (`text/event-stream`), not WebSockets -- simpler to proxy through the same
  Express app and k8s ingress as every other endpoint.

### 4. Code Pointers
- `dashboard/server/chat.js:12` -- `MODEL_ID`, `MAX_HOPS`
- `dashboard/server/chat.js:96` -- `SYSTEM` prompt (cumulative-counter warning)
- `dashboard/server/chat.js:114` -- `TOOLS` (the `run_sql` tool spec)
- `dashboard/server/chat.js:141` -- `handleChat()` (SSE stream + tool-use loop)
- `dashboard/web/src/components/FloatingChat.jsx` -- client-side SSE consumer

### 5. Cross-references
- Related modules: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md), [docs/reference/security.md](security.md)
- Related ADRs: (none yet)
- Related runbooks: (none yet)

<a id="korean"></a>
## 한국어

### 1. 개요
"Ask Claude"는 대시보드에 내장된 채팅 어시스턴트로, Amazon Bedrock ConverseStream을 기반으로
자체적으로 ClickHouse SQL을 작성·실행하는 제한된 툴콜 루프를 통해 사용량 질문에 답합니다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 채팅 핸들러 | `dashboard/server/chat.js` | SSE 엔드포인트, 시스템 프롬프트, 툴콜 루프, SQL 샌드박스 |
| Bedrock 클라이언트 | `dashboard/server/chat.js` | `BedrockRuntimeClient` + `ConverseStreamCommand`, `CHAT_MODEL_ID`로 모델 지정 |
| 채팅 UI | `dashboard/web/src/components/FloatingChat.jsx` | 플로팅 채팅 위젯, SSE 소비, 마크다운 렌더링 |

### 3. 주요 결정
- **제한된 툴콜 루프(`MAX_HOPS = 4`)** -- 한 번의 채팅 턴이 `run_sql`을 몇 번 왕복할 수
  있는지 상한을 둬서, 한 질문에 대해 루프가 폭주하거나 Bedrock 비용이 과도하게 나가는 걸
  막습니다.
- **시스템 프롬프트가 누적 카운터 함정을 명시적으로 문서화** -- 모델에게 프롬프트 자체에서
  `otel_metrics_sum`의 `sum(Value)`가 과대집계되며 세션/시리즈 단위 `max()`로 먼저 diff해야
  한다고 알려줍니다. 이게 없으면 어시스턴트가 쿼리 레이어가 애초에 피하려 했던 과대집계
  버그를 그대로 재생성하게 됩니다.
- **Bedrock 호스팅 모델(`CHAT_MODEL_ID`, 기본값 `global.anthropic.claude-sonnet-5`)** --
  AWS-네이티브 인프라의 나머지 부분과 일관됨. 외부 LLM API 의존성 없음.
- 스트리밍은 WebSocket이 아니라 SSE(`text/event-stream`) -- 다른 모든 엔드포인트와 같은
  Express 앱/k8s ingress로 프록시하기가 더 단순합니다.

### 4. 코드 포인터
- `dashboard/server/chat.js:12` -- `MODEL_ID`, `MAX_HOPS`
- `dashboard/server/chat.js:96` -- `SYSTEM` 프롬프트(누적 카운터 경고)
- `dashboard/server/chat.js:114` -- `TOOLS`(`run_sql` 툴 스펙)
- `dashboard/server/chat.js:141` -- `handleChat()`(SSE 스트림 + 툴콜 루프)
- `dashboard/web/src/components/FloatingChat.jsx` -- 클라이언트 측 SSE 소비

### 5. 상호 참조
- 관련 모듈: [dashboard/server/CLAUDE.md](../../dashboard/server/CLAUDE.md), [docs/reference/security.md](security.md)
- 관련 ADR: (아직 없음)
- 관련 런북: (아직 없음)
