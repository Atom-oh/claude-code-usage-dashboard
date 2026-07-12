# Infrastructure as Code / IaC 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
`infra/` is a single Terraform root module provisioning an EKS cluster, ClickHouse via its
Kubernetes Operator, ECR, S3, and DNS/CDN for the dashboard's public endpoint.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Providers | `infra/providers.tf` | AWS/Kubernetes/Helm provider config |
| Networking/data sources | `infra/data.tf` | Existing VPC/subnet lookups |
| Nodepool | `infra/nodepool.tf` | Graviton (arm64) EKS managed node group |
| ClickHouse | `infra/clickhouse.tf` | ClickHouse Operator install + `Cluster`/storage policy resources |
| Dashboard | `infra/dashboard.tf` | Dashboard Deployment/Service, env from k8s Secret |
| ECR | `infra/ecr.tf` | Image repository |
| S3 | `infra/s3.tf` | Cold-tier storage bucket for ClickHouse, backups |
| DNS/CDN | `infra/dns_cdn.tf` | Route53 record + CloudFront distribution |
| Variables/outputs | `infra/variables.tf`, `infra/outputs.tf` | Module inputs/outputs |

### 3. Key Decisions
- **ClickHouse via Kubernetes Operator, not a managed service** -- gives control over the
  hot/cold storage policy and replica topology needed for the OTel ingestion pattern.
- **`secrets.auto.tfvars` / `image.auto.tfvars`** are gitignored `*.tfvars` -- secrets and the
  currently-deployed image tag are injected at apply time, not committed.
- State is local (`terraform.tfstate*`, gitignored) -- acceptable for a single-operator
  workshop environment; would need a remote backend (S3+DynamoDB) before multi-operator use.

### 4. Code Pointers
- `infra/nodepool.tf` -- Graviton node group definition
- `infra/clickhouse.tf` -- ClickHouse Operator + storage policy (`hot_cold`, `cold_s3` disk)
- `infra/dashboard.tf` -- dashboard k8s Deployment/Service
- `infra/dns_cdn.tf` -- CloudFront + Route53
- `infra/.terraform.lock.hcl` -- provider version lock

### 5. Cross-references
- Related modules: [infra/CLAUDE.md](../../infra/CLAUDE.md)
- Related ADRs: (none yet)
- Related runbooks: [docs/runbooks/deploy-production.md](../runbooks/deploy-production.md)

<a id="korean"></a>
## 한국어

### 1. 개요
`infra/`는 EKS 클러스터, Kubernetes Operator를 통한 ClickHouse, ECR, S3, 대시보드 공개
엔드포인트용 DNS/CDN을 프로비저닝하는 단일 Terraform 루트 모듈입니다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| Provider | `infra/providers.tf` | AWS/Kubernetes/Helm provider 설정 |
| 네트워킹/데이터소스 | `infra/data.tf` | 기존 VPC/서브넷 조회 |
| 노드풀 | `infra/nodepool.tf` | Graviton(arm64) EKS 관리형 노드 그룹 |
| ClickHouse | `infra/clickhouse.tf` | ClickHouse Operator 설치 + `Cluster`/스토리지 정책 리소스 |
| 대시보드 | `infra/dashboard.tf` | 대시보드 Deployment/Service, k8s Secret에서 env 주입 |
| ECR | `infra/ecr.tf` | 이미지 리포지토리 |
| S3 | `infra/s3.tf` | ClickHouse cold tier 스토리지 버킷, 백업 |
| DNS/CDN | `infra/dns_cdn.tf` | Route53 레코드 + CloudFront 배포 |
| 변수/출력 | `infra/variables.tf`, `infra/outputs.tf` | 모듈 입력/출력 |

### 3. 주요 결정
- **관리형 서비스가 아니라 Kubernetes Operator로 ClickHouse 운영** -- OTel 적재 패턴에 필요한
  hot/cold 스토리지 정책과 레플리카 토폴로지를 직접 제어하기 위함.
- **`secrets.auto.tfvars` / `image.auto.tfvars`**는 gitignore된 `*.tfvars` -- 시크릿과 현재
  배포된 이미지 태그는 apply 시점에 주입되고 커밋되지 않습니다.
- state는 로컬(`terraform.tfstate*`, gitignore됨) -- 단일 운영자 워크샵 환경엔 충분하나, 여러
  운영자가 다루려면 원격 backend(S3+DynamoDB)가 필요합니다.

### 4. 코드 포인터
- `infra/nodepool.tf` -- Graviton 노드 그룹 정의
- `infra/clickhouse.tf` -- ClickHouse Operator + 스토리지 정책(`hot_cold`, `cold_s3` disk)
- `infra/dashboard.tf` -- 대시보드 k8s Deployment/Service
- `infra/dns_cdn.tf` -- CloudFront + Route53
- `infra/.terraform.lock.hcl` -- provider 버전 락

### 5. 상호 참조
- 관련 모듈: [infra/CLAUDE.md](../../infra/CLAUDE.md)
- 관련 ADR: (아직 없음)
- 관련 런북: [docs/runbooks/deploy-production.md](../runbooks/deploy-production.md)
