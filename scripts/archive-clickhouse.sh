#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# 워크샵 계정 소멸 전 ClickHouse 영구 아카이브 (workshop 계정 -> 내 계정 S3)
#
# 배경: 일별 백업(infra/clickhouse.tf의 clickhouse-backup CronJob)은 워크샵 계정 버킷
# cc-ab-clickhouse-<acct>-<region>의 cold/backup/ 아래에 쓰이고(cold_s3 디스크 endpoint가
# 이미 .../cold/로 끝나므로 Disk('cold_s3','backup/...')의 실제 S3 경로는 cold/backup/...),
# 그 상위 backup/ 프리픽스엔 30일 만료 라이프사이클이 걸려 있다(infra/s3.tf). 워크샵 계정이
# 삭제되면 버킷도 백업도 같이 사라진다 — 이 스크립트로 마지막 스냅샷을 하나 더 뜨고 기존
# 백업 전체를 내 계정 버킷으로 옮긴다.
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
#   SKIP_BACKUP=1      새 BACKUP을 안 돌리고 기존 cold/backup/ 프리픽스만 이관 (재실행/사전 점검용)
#
# 필요 RBAC (KUBE_CONTEXT/NAMESPACE): pods 조회, 특정 파드 exec, Secret clickhouse-writer get.
# 아카이브는 append-only(--delete 안 씀)이므로 대상 측 자격증명에 s3:DeleteObject는 필요 없다.
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

# 로컬 스테이징에 UserEmail 등 PII 전체가 평문으로 잠깐 머문다 — 다른 로컬 유저가 못 읽게
# 생성 권한을 좁히고, 성공적으로 올린 뒤엔 지운다.
umask 077

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

# 버킷명 오타 + 타 계정의 write-open 버킷이 겹치면 PII가 엉뚱한 계정으로 올라갈 수 있다 —
# 캐셔가 확인한 caller identity가 아니라 버킷 소유자 자체를 대상 sync/ls에서 검사한다.
EXPECTED_OWNER_ARGS=(--expected-bucket-owner "$ARCHIVE_ACCOUNT")

# infra/s3.tf의 네이밍 규칙(cc-ab-clickhouse-<acct>-<region>)과 동일 — 버킷 하나뿐이라
# terraform output을 안 읽어도 account_id만 있으면 이름을 재구성할 수 있다.
SRC_BUCKET="cc-ab-clickhouse-${WORKSHOP_ACCOUNT}-${REGION}"
# cold_s3 디스크의 endpoint 자체가 이미 .../cold/ 로 끝난다(infra/clickhouse.tf:34) — 따라서
# Disk('cold_s3', 'backup/...')의 'backup/'은 그 디스크 루트(=S3 cold/ 밑) 기준 상대 경로이고,
# 실제 S3 객체는 cold/backup/ 아래에 생성된다. 이걸 몰라 루트 backup/를 sync하면 항상 빈
# prefix를 복사하고도 0 objects == 0 objects로 검증이 조용히 통과한다(PR #18 리뷰 CRITICAL).
SRC_PREFIX="cold/backup"
echo "source bucket: $SRC_BUCKET (prefix: ${SRC_PREFIX}/)"

# 문서에 "~30x 한 백업 크기"로 추정치를 적어뒀었지만, infra/s3.tf의 lifecycle prefix가 실제
# 백업 경로(cold/backup/)와 달라 백업이 만료되지 않고 무기한 누적됐을 수 있어 추정이 틀릴 수
# 있다(PR #18 리뷰 MAJOR) — 추측 대신 실제 소스 크기를 재고 로컬 여유 공간과 비교한다.
mkdir -p "$LOCAL_DIR"
SRC_BYTES=$(aws s3 ls --recursive --summarize "s3://${SRC_BUCKET}/${SRC_PREFIX}/" --profile "$WORKSHOP_PROFILE" | grep "Total Size" | awk '{print $NF}')
FREE_BYTES=$(df -kP "$LOCAL_DIR" | awk 'NR==2 {print $4*1024}')
echo "source size: ${SRC_BYTES:-0} bytes, local free space: ${FREE_BYTES:-unknown} bytes"
if [ -n "$FREE_BYTES" ] && [ "${SRC_BYTES:-0}" -gt "$FREE_BYTES" ]; then
  echo "여유 공간 부족으로 보입니다 — LOCAL_DIR을 더 큰 볼륨으로 옮기거나 공간을 확보하세요." >&2
  exit 1
fi

if [ "${SKIP_BACKUP:-0}" != "1" ]; then
  echo "== 2. 최종 BACKUP 생성 =="
  POD=$(kube get pod -l clickhouse.altinity.com/chi=cc-ab -o name | head -1)
  if [ -z "$POD" ]; then
    echo "ClickHouse pod를 찾지 못했습니다 (label clickhouse.altinity.com/chi=cc-ab)" >&2
    exit 1
  fi
  CH_PASSWORD=$(kube get secret clickhouse-writer -o jsonpath='{.data.CH_PASSWORD}' | base64 -d)
  # 마지막이자 되돌릴 수 없는 스냅샷이므로 replicated 테이블 전부(clickhouse-schema-replicated.sql
  # 기준 4개)를 동기화하고, 하나라도 실패하면 중단한다 — otel_metrics_sum 하나만 돌리고 실패를
  # 삼키면(이전 버전) 이 파드가 lag 중일 때 다른 테이블의 최신 데이터가 조용히 빠질 수 있다
  # (PR #18 리뷰 MAJOR).
  for tbl in otel_metrics_sum otel_metrics_sum_hourly otel_metrics_gauge otel_logs; do
    echo "SYSTEM SYNC REPLICA: claude_code.${tbl}"
    printf '%s' "$CH_PASSWORD" | kube exec -i "$POD" -- sh -c \
      "CLICKHOUSE_PASSWORD=\$(cat) clickhouse-client --user otel_writer \
         --query \"SYSTEM SYNC REPLICA claude_code.${tbl}\""
  done
  BACKUP_TAG="final-$(date -u +%Y%m%dT%H%M%SZ)"
  # clickhouse-client 24.8은 CLICKHOUSE_PASSWORD env를 자동 인식한다 — --password "$VAR" 형태로
  # 같은 커맨드 라인에서 넘기면 그 $VAR는 앞의 프리픽스 대입이 적용되기 전에 확장되어 항상
  # 빈 문자열이 되고 인증이 실패한다(PR #18 리뷰 CRITICAL). env만 승격하고 --password는 뺀다.
  # 비밀번호를 kubectl exec argv에 넣으면 ps로 노출되므로 stdin으로 넘긴다.
  printf '%s' "$CH_PASSWORD" | kube exec -i "$POD" -- sh -c \
    "CLICKHOUSE_PASSWORD=\$(cat) clickhouse-client --user otel_writer \
       --query \"BACKUP DATABASE claude_code TO Disk('cold_s3', 'backup/${BACKUP_TAG}')\""
  echo "backup done: ${SRC_PREFIX}/${BACKUP_TAG}"
else
  echo "== 2. SKIP_BACKUP=1 — 새 백업 생성 스킵, 기존 ${SRC_PREFIX}/ 프리픽스만 이관 =="
fi

echo "== 3. 워크샵 계정 -> 로컬 다운로드 =="
# 재실행 시 이전 실행에서 남은 파일이 검증(count/bytes)을 어긋나게 하거나 오염된 아카이브를
# 남길 수 있어(PR #18 리뷰 MAJOR) 매번 새 스테이징 디렉터리를 쓴다.
LOCAL_DIR="${LOCAL_DIR}/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$LOCAL_DIR"
aws s3 sync "s3://${SRC_BUCKET}/${SRC_PREFIX}/" "${LOCAL_DIR}/backup/" --profile "$WORKSHOP_PROFILE"

echo "== 4. 스키마 사본 포함 =="
mkdir -p "${LOCAL_DIR}/schema"
# 실패를 삼키면(2>/dev/null || true) 스키마 없이도 "성공"으로 끝나 나중에야 빠진 걸 알게 된다
# (PR #18 리뷰 MAJOR) — 레포 루트에서 실행하지 않았다는 신호이므로 바로 죽는다.
cp "$(dirname "$0")/../clickhouse-schema.sql" "${LOCAL_DIR}/schema/"
cp "$(dirname "$0")/../infra/files/clickhouse-schema-replicated.sql" "${LOCAL_DIR}/schema/"
cp "$(dirname "$0")/../grafana-ab-queries.sql" "${LOCAL_DIR}/schema/"

echo "== 5. 로컬 -> 내 계정 업로드 =="
# --delete는 쓰지 않는다: 이 아카이브는 append-only여야 한다. LOCAL_DIR을 매번 새 타임스탬프로
# 만들기 때문에 --delete를 쓰면 "이번 실행에서 안 받아온 것 = 소스에 이제 없는 것"으로 간주해
# 지워버리는데, 소스가 만료/축소된 상태(예: 재실행 시점에 일부 일별 백업이 이미 30일 만료로
# 사라진 뒤)라면 이전에 이미 옮겨둔 아카이브까지 지운다 — "0==0으로 조용히 통과"의 또 다른
# 형태다(PR #18 리뷰 MAJOR). 아카이브 버킷 소유자가 예상과 다르면 즉시 실패하도록 명시한다.
archive_aws s3 sync "${LOCAL_DIR}/" "s3://${ARCHIVE_BUCKET}/${ARCHIVE_PREFIX}/" "${EXPECTED_OWNER_ARGS[@]}"

echo "== 6. 검증 (객체 수 + 총 바이트, backup/ + schema/ 모두) =="
src_summary() {
  aws s3 ls --recursive --summarize "s3://${SRC_BUCKET}/${SRC_PREFIX}/" --profile "$WORKSHOP_PROFILE" | tail -2
  find "${LOCAL_DIR}/schema" -type f | wc -l
}
dst_summary() {
  archive_aws s3 ls --recursive --summarize "s3://${ARCHIVE_BUCKET}/${ARCHIVE_PREFIX}/backup/" "${EXPECTED_OWNER_ARGS[@]}" | tail -2
  archive_aws s3 ls --recursive "s3://${ARCHIVE_BUCKET}/${ARCHIVE_PREFIX}/schema/" "${EXPECTED_OWNER_ARGS[@]}" | wc -l
}

SRC=$(src_summary)
DST=$(dst_summary)
echo "source (+ local schema file count):"; echo "$SRC"
echo "archive (+ remote schema file count):"; echo "$DST"

# --delete 없이 append-only sync만으로는 "옮길 게 하나도 없어도" 검증이 통과할 수 있다 —
# 소스가 실제로 비어 있는데도 0==0으로 넘어가는 걸 막기 위해 소스 쪽 object count가
# 0보다 커야 한다는 조건을 명시적으로 추가한다(PR #18 리뷰 MAJOR).
SRC_OBJECT_COUNT=$(aws s3 ls --recursive --summarize "s3://${SRC_BUCKET}/${SRC_PREFIX}/" --profile "$WORKSHOP_PROFILE" | grep "Total Objects" | awk '{print $NF}')
if [ "${SRC_OBJECT_COUNT:-0}" -eq 0 ]; then
  echo "검증 실패: 소스 ${SRC_PREFIX}/에 객체가 0개입니다 — 빈 프리픽스를 이관한 것으로 보입니다." >&2
  exit 1
fi

if [ "$SRC" != "$DST" ]; then
  echo "검증 실패: 소스/아카이브의 객체 수, 총 바이트, 또는 스키마 파일 수가 다릅니다." >&2
  exit 1
fi

rm -rf "$LOCAL_DIR"

echo "== 완료 =="
echo "아카이브 위치: s3://${ARCHIVE_BUCKET}/${ARCHIVE_PREFIX}/"
echo "복원 절차: docs/runbooks/archive-clickhouse.md 참조"
