# Infrastructure / 인프라 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
The dashboard ships as a single multi-stage Docker image (web build -> server runtime) that
serves the React SPA as static files from the same Express process that answers the API. It
runs on an EKS Graviton (arm64) nodepool alongside a ClickHouse Kubernetes Operator cluster.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Dashboard image | `dashboard/Dockerfile` | Multi-stage build: `web-build` (vite build) -> `server` runtime (node:24-alpine, arm64) |
| Local dev stack | `dashboard/docker-compose.yml` | Runs server+web together for local testing |
| Dashboard k8s deployment | `infra/dashboard.tf` | Deployment/Service manifest, env vars (CH_*, BASIC_AUTH_*) |
| ECR repository | `infra/ecr.tf` | Image registry for `cc-ab-dashboard` |
| EKS nodepool | `infra/nodepool.tf` | Graviton (arm64) node group |
| DNS/CDN | `infra/dns_cdn.tf` | Route53 + CloudFront in front of the dashboard NLB |

### 3. Key Decisions
- Build for `linux/arm64` only (`docker buildx build --platform linux/arm64`) -- the nodepool is
  Graviton (m8g.xlarge) for cost; the image must match the node CPU architecture.
- Serve the SPA and API from one Express process/one image -- avoids a separate static-hosting
  component for what is a small internal workshop tool.
- `node:24-alpine` base image -- the project moved off `node:20-alpine` once Node 20 reached
  EOL; AWS SDK v3 already logs a pre-EOL warning under old runtimes.

### 4. Code Pointers
- `dashboard/Dockerfile:2` -- web-build stage (vite build)
- `dashboard/Dockerfile:9` -- server runtime stage
- `dashboard/server/index.js:34` -- `/healthz` endpoint used by k8s probes
- `infra/dashboard.tf` -- deployment spec, resource requests/limits, env injection from secrets
- `infra/ecr.tf` -- ECR repo definition

### 5. Cross-references
- Related modules: [dashboard/CLAUDE.md](../../dashboard/CLAUDE.md), [infra/CLAUDE.md](../../infra/CLAUDE.md)
- Related ADRs: (none yet)
- Related runbooks: [docs/runbooks/deploy-production.md](../runbooks/deploy-production.md)

<a id="korean"></a>
## 한국어

### 1. 개요
대시보드는 웹 빌드(vite build)와 서버 런타임을 하나로 묶은 멀티스테이지 Docker 이미지로
배포되며, React SPA를 API와 같은 Express 프로세스에서 정적 파일로 서빙합니다. ClickHouse
Kubernetes Operator 클러스터와 같은 EKS Graviton(arm64) 노드풀에서 실행됩니다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 대시보드 이미지 | `dashboard/Dockerfile` | 멀티스테이지 빌드: `web-build`(vite build) -> `server` 런타임(node:24-alpine, arm64) |
| 로컬 개발 스택 | `dashboard/docker-compose.yml` | 로컬 테스트용 server+web 동시 실행 |
| 대시보드 k8s 배포 | `infra/dashboard.tf` | Deployment/Service 매니페스트, 환경변수(CH_*, BASIC_AUTH_*) |
| ECR 리포지토리 | `infra/ecr.tf` | `cc-ab-dashboard` 이미지 레지스트리 |
| EKS 노드풀 | `infra/nodepool.tf` | Graviton(arm64) 노드 그룹 |
| DNS/CDN | `infra/dns_cdn.tf` | 대시보드 NLB 앞단의 Route53 + CloudFront |

### 3. 주요 결정
- `linux/arm64`만 빌드(`docker buildx build --platform linux/arm64`) -- 노드풀이 비용 절감용
  Graviton(m8g.xlarge)이라 이미지가 노드 CPU 아키텍처와 맞아야 합니다.
- SPA와 API를 하나의 Express 프로세스/이미지로 서빙 -- 내부 워크샵 도구 규모에 별도 정적
  호스팅 컴포넌트는 과함.
- `node:24-alpine` 베이스 이미지 -- Node 20 EOL 이후 전환. AWS SDK v3가 구 런타임에서 이미
  EOL 사전 경고를 출력하고 있었음.

### 4. 코드 포인터
- `dashboard/Dockerfile:2` -- web-build 스테이지(vite build)
- `dashboard/Dockerfile:9` -- 서버 런타임 스테이지
- `dashboard/server/index.js:34` -- k8s probe용 `/healthz` 엔드포인트
- `infra/dashboard.tf` -- 배포 스펙, 리소스 요청/제한, secret에서 env 주입
- `infra/ecr.tf` -- ECR 리포 정의

### 5. 상호 참조
- 관련 모듈: [dashboard/CLAUDE.md](../../dashboard/CLAUDE.md), [infra/CLAUDE.md](../../infra/CLAUDE.md)
- 관련 ADR: (아직 없음)
- 관련 런북: [docs/runbooks/deploy-production.md](../runbooks/deploy-production.md)
