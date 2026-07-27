#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# 워크샵 계정 소멸 전 ClickHouse 영구 아카이브 (workshop 계정 -> 내 계정 S3)
#
# 배경: 일별 백업(infra/clickhouse.tf의 clickhouse-backup CronJob)은 워크샵 계정 버킷
# cc-ab-clickhouse-<acct>-<region>/backup/ 에 쓰이고, 그 프리픽스엔 30일 만료 라이프사이클이
# 걸려 있다(infra/s3.tf). 워크샵 계정이 삭제되면 버킷도 백업도 같이 사라진다 — 이 스크립트로
# 마지막 스냅샷을 하나 더 뜨고 기존 백업 전체를 내 계정 버킷으로 옮긴다.
#
# 사전 준비 — 워크샵 계정용 ~/.aws/credentials 프로필 1개:
#   [workshop]
#   aws_access_key_id = ...
#   aws_secret_access_key = ...
#   aws_session_token = ...   # 워크샵 계정이 임시 자격증명이면 필요
#
# 내 계정(archive) 쪽은 별도 프로필 없이, 이 스크립트를 실행하는 EC2의 인스턴스 프로필
# (기본 자격증명 체인)을 그대로 쓴다 — ARCHIVE_PROFILE을 비워두면(기본값) --profile을
# 붙이지 않는다. 별도 archive 프로필을 쓰고 싶으면 ARCHIVE_PROFILE=archive 처럼 지정.
#
# 사용법:
#   ARCHIVE_BUCKET=my-permanent-bucket ./scripts/archive-clickhouse.sh
#
# 옵션 env:
#   WORKSHOP_PROFILE   워크샵 계정 aws profile (기본 workshop)
#   ARCHIVE_PROFILE    내 계정 aws profile (기본 빈 값 = EC2 인스턴스 프로필 사용)
#   ARCHIVE_BUCKET     내 계정 버킷 이름 (필수)
#   ARCHIVE_PREFIX     내 버킷 안 저장 경로 (기본 clickhouse-ab-workshop)
#   LOCAL_DIR          중간 다운로드 디렉터리 (기본 ./ch-archive)
#   KUBE_CONTEXT       kubectl context (기본 fsi-demo-cluster)
#   NAMESPACE          k8s namespace (기본 claude-code)
#   REGION             워크샵 버킷 리전 (기본 ap-northeast-2, infra/variables.tf 기본값)
#   SKIP_BACKUP=1      새 BACKUP을 안 돌리고 기존 backup/ 프리픽스만 이관 (드라이런/재실행용)
# =============================================================================

WORKSHOP_PROFILE="${WORKSHOP_PROFILE:-workshop}"
ARCHIVE_PROFILE="${ARCHIVE_PROFILE:-}"
ARCHIVE_BUCKET="${ARCHIVE_BUCKET:?ARCHIVE_BUCKET env var required (destination bucket in your own account)}"
ARCHIVE_PREFIX="${ARCHIVE_PREFIX:-clickhouse-ab-workshop}"
LOCAL_DIR="${LOCAL_DIR:-./ch-archive}"
KUBE_CONTEXT="${KUBE_CONTEXT:-fsi-demo-cluster}"
NAMESPACE="${NAMESPACE:-claude-code}"
REGION="${REGION:-ap-northeast-2}"

kube() { kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }

# ARCHIVE_PROFILE이 비어 있으면 --profile을 아예 안 붙여 기본 자격증명 체인(EC2 인스턴스
# 프로필 등)을 쓴다 — `--profile ""`로 넘기면 aws가 프로필 없음 에러를 낸다.
archive_aws() {
  if [ -n "$ARCHIVE_PROFILE" ]; then
    aws --profile "$ARCHIVE_PROFILE" "$@"
  else
    aws "$@"
  fi
}

echo "== 1. 자격증명 확인 =="
WORKSHOP_ACCOUNT=$(aws sts get-caller-identity --profile "$WORKSHOP_PROFILE" --query Account --output text)
ARCHIVE_ACCOUNT=$(archive_aws sts get-caller-identity --query Account --output text)
echo "workshop account: $WORKSHOP_ACCOUNT"
echo "archive  account: $ARCHIVE_ACCOUNT (profile: ${ARCHIVE_PROFILE:-<default/instance profile>})"

# infra/s3.tf의 네이밍 규칙(cc-ab-clickhouse-<acct>-<region>)과 동일 — 버킷 하나뿐이라
# terraform output을 안 읽어도 account_id만 있으면 이름을 재구성할 수 있다.
SRC_BUCKET="cc-ab-clickhouse-${WORKSHOP_ACCOUNT}-${REGION}"
echo "source bucket: $SRC_BUCKET"

if [ "${SKIP_BACKUP:-0}" != "1" ]; then
  echo "== 2. 최종 BACKUP 생성 =="
  POD=$(kube get pod -l clickhouse.altinity.com/chi=cc-ab -o name | head -1)
  if [ -z "$POD" ]; then
    echo "ClickHouse pod를 찾지 못했습니다 (label clickhouse.altinity.com/chi=cc-ab)" >&2
    exit 1
  fi
  CH_PASSWORD=$(kube get secret clickhouse-writer -o jsonpath='{.data.CH_PASSWORD}' | base64 -d)
  BACKUP_TAG="final-$(date -u +%Y%m%dT%H%M%SZ)"
  # 비밀번호를 kubectl exec argv에 넣으면 ps로 노출된다(backfill-hourly-rollup.sh와 동일 원칙) —
  # stdin으로 넘기고 파드 안에서 env로 승격한다.
  printf '%s' "$CH_PASSWORD" | kube exec -i "$POD" -- sh -c \
    "CLICKHOUSE_PASSWORD=\$(cat) clickhouse-client --user otel_writer --password \"\$CLICKHOUSE_PASSWORD\" \
       --query \"BACKUP DATABASE claude_code TO Disk('cold_s3', 'backup/${BACKUP_TAG}')\""
  echo "backup done: backup/${BACKUP_TAG}"
else
  echo "== 2. SKIP_BACKUP=1 — 새 백업 생성 스킵, 기존 backup/ 프리픽스만 이관 =="
fi

echo "== 3. 워크샵 계정 -> 로컬 다운로드 =="
mkdir -p "$LOCAL_DIR"
aws s3 sync "s3://${SRC_BUCKET}/backup/" "${LOCAL_DIR}/backup/" --profile "$WORKSHOP_PROFILE"

echo "== 4. 스키마 사본 포함 =="
mkdir -p "${LOCAL_DIR}/schema"
cp clickhouse-schema.sql "${LOCAL_DIR}/schema/" 2>/dev/null || true
cp infra/files/clickhouse-schema-replicated.sql "${LOCAL_DIR}/schema/" 2>/dev/null || true

echo "== 5. 로컬 -> 내 계정 업로드 =="
archive_aws s3 sync "${LOCAL_DIR}/" "s3://${ARCHIVE_BUCKET}/${ARCHIVE_PREFIX}/"

echo "== 6. 검증 (객체 수 + 총 바이트) =="
src_summary() { aws s3 ls --recursive --summarize "s3://${SRC_BUCKET}/backup/" --profile "$WORKSHOP_PROFILE" | tail -2; }
dst_summary() { archive_aws s3 ls --recursive --summarize "s3://${ARCHIVE_BUCKET}/${ARCHIVE_PREFIX}/backup/" | tail -2; }

SRC=$(src_summary)
DST=$(dst_summary)
echo "source:"; echo "$SRC"
echo "archive:"; echo "$DST"

if [ "$SRC" != "$DST" ]; then
  echo "검증 실패: 소스/아카이브의 객체 수 또는 총 바이트가 다릅니다." >&2
  exit 1
fi

echo "== 완료 =="
echo "아카이브 위치: s3://${ARCHIVE_BUCKET}/${ARCHIVE_PREFIX}/"
echo "복원 절차: docs/runbooks/archive-clickhouse.md 참조"
