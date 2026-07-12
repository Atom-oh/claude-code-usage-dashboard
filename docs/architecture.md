# Architecture

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## System Overview

Claude Code Usage Dashboard is a telemetry pipeline and web dashboard built for an AWS
Workshop Studio A/B scenario comparing Claude Code usage over Amazon Bedrock vs. Claude
Enterprise. Claude Code clients export native OpenTelemetry metrics/logs, an OTel Collector
forwards them into ClickHouse running on EKS, and a Node.js/React dashboard aggregates cost,
adoption, and productivity KPIs on top of that data — classifying each session as
`bedrock`/`enterprise` after the fact from telemetry, since participants choose their auth
method at runtime rather than a static experiment flag.

## Components

### Ingestion Layer
- **Claude Code clients (workshop participants)** -- export OTel metrics/logs natively; no
  custom instrumentation needed on the client side.
- **OpenTelemetry Collector** (`collector-config.yaml`) -- receives OTLP, writes into
  ClickHouse via the `clickhouse` exporter.

### Storage Layer
- **ClickHouse (`otel_metrics_sum`, `otel_logs`)** -- `ReplicatedMergeTree`, 3 replicas, hot/cold
  storage policy (local EBS gp3 -> S3 after 45-90 days, dropped after 90-180 days). Promoted
  materialized columns (Model, TokenType, Decision, SkillName, UserEmail, SessionId, ...)
  avoid `Attributes` map lookups in every query.
- **ClickHouse (`otel_metrics_sum_hourly`)** -- `ReplicatedAggregatingMergeTree` hourly rollup
  fed by a materialized view on `otel_metrics_sum`. Dashboard queries read this table instead
  of the raw one (~86x fewer rows; raw grows ~3M rows/day from 10s cumulative re-exports).
  Cumulative counters keep `max(Value)` per (SeriesKey, SessionId, hour); no TTL so diff
  baselines outlive the raw table's TTL. See `clickhouse-schema.sql` for cutover notes.
- **ClickHouse Keeper** -- coordination for the replicated cluster (separate StatefulSet).

### Processing / Query Layer
- **`dashboard/server`** (Express, Node.js ESM) -- one function per API endpoint in
  `queries.js`; diffs cumulative OTel counters at session boundaries (`incFlat`/`incBucketed`)
  instead of summing raw values; infers bedrock/enterprise group per session
  (`grouping.js`).

### Presentation Layer
- **`dashboard/web`** (React 18 + Vite + Tailwind + Recharts) -- 6+ pages sharing one global
  date-range/filter context; served as static files by the same Express process.

### AI/ML Layer
- **Amazon Bedrock** -- backs the "Ask Claude" chat assistant (`chat.js`), which writes and
  runs its own ClickHouse SQL in a bounded tool-use loop to answer usage questions.

### Security Layer
- **Basic Auth** (global Express middleware) -- gates the whole dashboard except `/healthz`.
- **SQL sandbox** (`sanitizeSql()` + ClickHouse `readonly=1`) -- two independent layers
  restricting the chat assistant to read-only `SELECT`/`WITH` queries.

### Infrastructure Layer
- **Terraform** (`infra/`) -- EKS (Graviton nodepool), ClickHouse Kubernetes Operator, ECR,
  S3 (cold tier + backups), Route53/CloudFront for the public dashboard endpoint.
- **CI** -- GitHub Actions multi-AI PR review (`.github/workflows/pr-review.yml`), orchestrated
  by `scripts/pr-review/`.

## Full Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Ingestion Layer                             │
│  ┌────────────────────┐        ┌───────────────────────┐             │
│  │ Claude Code clients│──OTLP─▶│  OTel Collector        │             │
│  │ (bedrock/enterprise)│       │  (collector-config.yaml)│            │
│  └────────────────────┘        └───────────┬───────────┘             │
└─────────────────────────────────────────────┼─────────────────────────┘
                                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                           Storage Layer (EKS)                        │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │  ClickHouse (ReplicatedMergeTree, 3 replicas)                  │   │
│  │  otel_metrics_sum │ otel_logs   -- hot (EBS) ──▶ cold (S3)      │   │
│  └───────────────────────────────┬───────────────────────────────┘   │
│              ClickHouse Keeper (coordination)                        │
└────────────────────────────────────┼──────────────────────────────────┘
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Processing / Query Layer                          │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │  dashboard/server (Express)                                   │   │
│  │  queries.js -- incFlat/incBucketed cumulative diff             │   │
│  │  grouping.js -- session-level bedrock/enterprise inference     │   │
│  │  chat.js -- Bedrock ConverseStream + sandboxed run_sql          │──┼──▶ Amazon Bedrock
│  └───────────────────────────────┬───────────────────────────────┘   │   (AI/ML Layer)
│         ▲ Basic Auth (Security Layer, all routes except /healthz)    │
└─────────┼──────────────────────────┼──────────────────────────────────┘
          │                          ▼
┌─────────┼──────────────────────────────────────────────────────────────┐
│         │         Presentation Layer                                  │
│  ┌──────┴────────────────────────────────────────────────────────┐    │
│  │  dashboard/web (React SPA, served as static files by server)   │    │
│  │  Overview / Cost / Productivity / Users / Trends / Executive    │    │
│  └───────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   ▼
                         Route53 + CloudFront (Infrastructure Layer)
                                   ▼
                              Workshop participant browser
```

## Data Flow Summary

```
Claude Code client -> OTel Collector -> ClickHouse (hot -> cold) -> dashboard/server (cumulative diff, grouping) -> dashboard/web -> CloudFront -> browser
                                                                          |
                                                                          └-> Bedrock (chat assistant, read-only SQL sandbox)
```

## Infrastructure

### Deployment Region
- ap-northeast-2 (Seoul)

### Modules / Resources
| Module | Resources | Description |
|--------|-----------|-------------|
| `infra/nodepool.tf` | EKS managed node group | Graviton (m8g.xlarge, arm64) nodes |
| `infra/clickhouse.tf` | ClickHouse Operator, Cluster, storage policy | `hot_cold` policy: local EBS + `cold_s3` disk |
| `infra/dashboard.tf` | Deployment, Service | Dashboard app, env from k8s Secret |
| `infra/ecr.tf` | ECR repository | `cc-ab-dashboard` image registry |
| `infra/s3.tf` | S3 buckets | ClickHouse cold tier, backups |
| `infra/dns_cdn.tf` | Route53, CloudFront | Public dashboard endpoint |

### Deployed Resources
- Dashboard: internal NLB behind CloudFront, Basic Auth-gated
- ClickHouse: `clickhouse-cc-ab` Service (ClusterIP), 3 replicas + 3-node Keeper

## Key Design Decisions

- Diff cumulative OTel counters at session boundaries instead of summing raw values -- Claude
  Code re-exports session-cumulative totals every ~30s; naive summation overcounted tokens by
  orders of magnitude in early testing.
- Infer bedrock/enterprise grouping per session from telemetry, not a static env flag --
  Workshop Studio participants choose their own auth path at login on a shared image; the
  group can't be baked into the deployment.
- Serve the SPA and API from one Express process/one Docker image -- this is a workshop tool,
  not a product; a separate static-hosting tier would add operational surface for no benefit.
- ClickHouse hot/cold TTL policy instead of manual retention scripts -- disk growth is capped
  automatically (45-90d hot depending on table, dropped at 90-180d).
- Read-only API by construction, with the one write-adjacent surface (`/api/chat`'s SQL tool)
  guarded by two independent layers (string sanitizer + ClickHouse `readonly=1`).

## Operations
- Deployment: see [docs/runbooks/deploy-production.md](runbooks/deploy-production.md)
- Incident Response: see [docs/runbooks/incident-response.md](runbooks/incident-response.md)

---

<a id="korean"></a>

# 한국어

## 시스템 개요

Claude Code Usage Dashboard는 Amazon Bedrock 대 Claude Enterprise로 Claude Code 사용량을
비교하는 AWS Workshop Studio A/B 시나리오를 위한 텔레메트리 파이프라인과 웹 대시보드입니다.
Claude Code 클라이언트가 네이티브 OpenTelemetry 메트릭/로그를 export하면 OTel Collector가
EKS에서 실행 중인 ClickHouse로 전달하고, Node.js/React 대시보드가 그 위에서 비용·도입률·
생산성 KPI를 집계합니다 — 참가자가 런타임에 인증 방식을 직접 고르기 때문에 정적 실험
플래그가 아니라 텔레메트리로 사후에 각 세션을 `bedrock`/`enterprise`로 분류합니다.

## 구성요소

### Ingestion Layer
- **Claude Code 클라이언트(워크샵 참가자)** -- OTel 메트릭/로그를 네이티브로 export, 클라이언트
  측 커스텀 계측 불필요.
- **OpenTelemetry Collector**(`collector-config.yaml`) -- OTLP를 수신해 `clickhouse` exporter로
  적재.

### Storage Layer
- **ClickHouse(`otel_metrics_sum`, `otel_logs`)** -- `ReplicatedMergeTree`, 레플리카 3개,
  hot/cold 스토리지 정책(로컬 EBS gp3 -> 45~90일 후 S3, 90~180일에 삭제). 승격된 materialized
  컬럼(Model, TokenType, Decision, SkillName, UserEmail, SessionId 등)으로 매 쿼리마다
  `Attributes` 맵 조회를 피함.
- **ClickHouse(`otel_metrics_sum_hourly`)** -- `otel_metrics_sum` 위의 materialized view가
  채우는 시간별 rollup(`ReplicatedAggregatingMergeTree`). 대시보드 쿼리는 원본 대신 이
  테이블을 읽는다(행 수 ~86x 감소; 원본은 10초 누적 재-export로 하루 ~300만 행씩 증가).
  누적 카운터는 (SeriesKey, SessionId, hour)당 `max(Value)`만 보존하며, TTL이 없어 원본
  TTL 이후에도 diff baseline이 남는다. 컷오버 절차는 `clickhouse-schema.sql` 주석 참고.
- **ClickHouse Keeper** -- 레플리카 클러스터 코디네이션(별도 StatefulSet).

### Processing / Query Layer
- **`dashboard/server`**(Express, Node.js ESM) -- `queries.js`에 엔드포인트당 함수 하나씩;
  원본 값을 합산하는 대신 세션 경계에서 누적 OTel 카운터를 diff(`incFlat`/`incBucketed`);
  세션 단위 bedrock/enterprise 그룹 추론(`grouping.js`).

### Presentation Layer
- **`dashboard/web`**(React 18 + Vite + Tailwind + Recharts) -- 전역 날짜범위/필터 컨텍스트를
  공유하는 6개 이상의 페이지; 같은 Express 프로세스가 정적 파일로 서빙.

### AI/ML Layer
- **Amazon Bedrock** -- "Ask Claude" 채팅 어시스턴트(`chat.js`)를 지원, 제한된 툴콜 루프 안에서
  자체적으로 ClickHouse SQL을 작성·실행해 사용량 질문에 답변.

### Security Layer
- **Basic Auth**(전역 Express 미들웨어) -- `/healthz`를 제외한 대시보드 전체를 게이트.
- **SQL 샌드박스**(`sanitizeSql()` + ClickHouse `readonly=1`) -- 채팅 어시스턴트를 읽기 전용
  `SELECT`/`WITH` 쿼리로 제한하는 독립된 2개 레이어.

### Infrastructure Layer
- **Terraform**(`infra/`) -- EKS(Graviton 노드풀), ClickHouse Kubernetes Operator, ECR,
  S3(cold tier + 백업), 공개 대시보드 엔드포인트용 Route53/CloudFront.
- **CI** -- GitHub Actions 멀티 AI PR 리뷰(`.github/workflows/pr-review.yml`),
  `scripts/pr-review/`가 오케스트레이션.

## 전체 아키텍처 다이어그램

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Ingestion Layer                             │
│  ┌────────────────────┐        ┌───────────────────────┐             │
│  │ Claude Code 클라이언트│──OTLP─▶│  OTel Collector        │             │
│  │ (bedrock/enterprise)│       │  (collector-config.yaml)│            │
│  └────────────────────┘        └───────────┬───────────┘             │
└─────────────────────────────────────────────┼─────────────────────────┘
                                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                           Storage Layer (EKS)                        │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │  ClickHouse (ReplicatedMergeTree, 레플리카 3개)                  │   │
│  │  otel_metrics_sum │ otel_logs   -- hot (EBS) ──▶ cold (S3)      │   │
│  └───────────────────────────────┬───────────────────────────────┘   │
│              ClickHouse Keeper (코디네이션)                            │
└────────────────────────────────────┼──────────────────────────────────┘
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Processing / Query Layer                          │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │  dashboard/server (Express)                                   │   │
│  │  queries.js -- incFlat/incBucketed 누적 diff                    │   │
│  │  grouping.js -- 세션 단위 bedrock/enterprise 추론                 │   │
│  │  chat.js -- Bedrock ConverseStream + 샌드박스된 run_sql           │──┼──▶ Amazon Bedrock
│  └───────────────────────────────┬───────────────────────────────┘   │   (AI/ML Layer)
│         ▲ Basic Auth (Security Layer, /healthz 제외 전체 라우트)        │
└─────────┼──────────────────────────┼──────────────────────────────────┘
          │                          ▼
┌─────────┼──────────────────────────────────────────────────────────────┐
│         │         Presentation Layer                                  │
│  ┌──────┴────────────────────────────────────────────────────────┐    │
│  │  dashboard/web (React SPA, server가 정적 파일로 서빙)              │    │
│  │  Overview / Cost / Productivity / Users / Trends / Executive    │    │
│  └───────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   ▼
                         Route53 + CloudFront (Infrastructure Layer)
                                   ▼
                              워크샵 참가자 브라우저
```

## 데이터 흐름 요약

```
Claude Code 클라이언트 -> OTel Collector -> ClickHouse (hot -> cold) -> dashboard/server (누적 diff, 그룹 판별) -> dashboard/web -> CloudFront -> 브라우저
                                                                              |
                                                                              └-> Bedrock (채팅 어시스턴트, 읽기 전용 SQL 샌드박스)
```

## 인프라

### 배포 리전
- ap-northeast-2 (서울)

### 모듈 / 리소스
| 모듈 | 리소스 | 설명 |
|--------|-----------|-------------|
| `infra/nodepool.tf` | EKS 관리형 노드 그룹 | Graviton(m8g.xlarge, arm64) 노드 |
| `infra/clickhouse.tf` | ClickHouse Operator, Cluster, 스토리지 정책 | `hot_cold` 정책: 로컬 EBS + `cold_s3` disk |
| `infra/dashboard.tf` | Deployment, Service | 대시보드 앱, k8s Secret에서 env 주입 |
| `infra/ecr.tf` | ECR 리포지토리 | `cc-ab-dashboard` 이미지 레지스트리 |
| `infra/s3.tf` | S3 버킷 | ClickHouse cold tier, 백업 |
| `infra/dns_cdn.tf` | Route53, CloudFront | 공개 대시보드 엔드포인트 |

### 배포된 리소스
- 대시보드: CloudFront 뒤의 내부 NLB, Basic Auth 게이트
- ClickHouse: `clickhouse-cc-ab` Service(ClusterIP), 레플리카 3개 + 3노드 Keeper

## 주요 설계 결정

- 원본 값을 합산하는 대신 세션 경계에서 누적 OTel 카운터를 diff -- Claude Code가 ~30초마다
  세션 누적 합계를 다시 export하는데, 단순 합산은 초기 테스트에서 토큰 수를 자릿수 단위로
  과대집계했습니다.
- bedrock/enterprise 그룹을 정적 env 플래그가 아니라 텔레메트리로 세션 단위 추론 -- Workshop
  Studio 참가자가 같은 이미지에서 로그인 시 인증 방식을 직접 고르므로 그룹을 배포에 고정할
  수 없습니다.
- SPA와 API를 하나의 Express 프로세스/이미지로 서빙 -- 제품이 아니라 워크샵 도구라 별도
  정적 호스팅 계층은 이득 없이 운영 표면만 늘립니다.
- 수동 보존 스크립트 대신 ClickHouse hot/cold TTL 정책 -- 디스크 증가가 자동으로 캡됨(테이블에
  따라 hot 45~90일, 90~180일에 삭제).
- 구조적으로 읽기 전용인 API, 쓰기에 가까운 유일한 표면(`/api/chat`의 SQL 도구)은 독립된
  2개 레이어(문자열 sanitizer + ClickHouse `readonly=1`)로 보호.

## 운영
- 배포: [docs/runbooks/deploy-production.md](runbooks/deploy-production.md) 참고
- 장애 대응: [docs/runbooks/incident-response.md](runbooks/incident-response.md) 참고
