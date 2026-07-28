#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# 워크샵 계정 소멸 전 ClickHouse 영구 아카이브 (workshop 계정 -> 내 계정 S3)
#
# 배경: 일별 백업(infra/clickhouse.tf의 clickhouse-backup CronJob)은 BACKUP TO S3(...)로
# 워크샵 계정 버킷 cc-ab-clickhouse-<acct>-<region>의 backup/ 아래에 쓰이고, 그 프리픽스엔
# 30일 만료 라이프사이클이 걸려 있다(infra/s3.tf). 워크샵 계정이 삭제되면 버킷도 백업도 같이
# 사라진다 — 이 스크립트로 마지막 스냅샷을 하나 더 뜨고 기존 백업 전체를 내 계정 버킷으로 옮긴다.
#
# 왜 Disk('cold_s3', ...)가 아니라 S3(...)인가 — 실측 확인(2026-07-27): type=s3 디스크는 논리
# 경로를 파드 로컬 metadata에만 두고 S3에는 랜덤 blob 키(cold/aaa/bzscpv...)로 저장한다.
# 그 방식으로 뜬 백업은 S3에 backup/ 경로가 생기지 않아(cold/backup/ 객체 0개) 옮길 대상이
# 없고, blob만 복사해도 PVC의 metadata 없이는 복원이 불가능하다. S3(...)는 .backup 매니페스트
# 와 data/<db>/<table>/... 논리 경로를 그대로 써서 버킷만 있으면 복원된다.
#
# 이 아카이브는 append-only다: 대상 측에 --delete를 쓰지 않고, 검증도 "지금 이 실행이 올린
# 파일들이 실제로 대상에 있는가"만 확인한다(라이브 소스 전체와의 정확일치는 요구하지 않음) —
# 재실행 사이에 소스의 일별 백업이 만료되어도 이전에 옮겨둔 아카이브를 건드리지 않는다.
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
#   LOCAL_DIR          중간 다운로드 디렉터리의 부모 경로 (기본 ./ch-archive)
#   KUBE_CONTEXT       kubectl context (기본 fsi-demo-cluster)
#   NAMESPACE          k8s namespace (기본 claude-code)
#   REGION             워크샵 버킷 리전 (기본 ap-northeast-2, infra/variables.tf 기본값)
#   SKIP_BACKUP=1      새 BACKUP을 안 돌리고 기존 backup/ 프리픽스만 이관 (재실행/사전 점검용)
#
# 필요 RBAC (KUBE_CONTEXT/NAMESPACE): pods 조회, 특정 파드 exec, Secret clickhouse-writer get.
# 아카이브는 append-only(--delete 안 씀)이므로 대상 측 자격증명에 s3:DeleteObject는 필요 없다.
# =============================================================================

WORKSHOP_PROFILE="${WORKSHOP_PROFILE:-workshop}"
ARCHIVE_PROFILE="${ARCHIVE_PROFILE:-}"
ARCHIVE_BUCKET="${ARCHIVE_BUCKET:?ARCHIVE_BUCKET env var required (destination bucket in your own account)}"
ARCHIVE_PREFIX="${ARCHIVE_PREFIX:-clickhouse-ab-workshop}"
ARCHIVE_PREFIX="${ARCHIVE_PREFIX%/}"   # trailing slash를 붙여 넘겨도 s3://.../prefix//... 가 되지 않게
LOCAL_DIR_ROOT="${LOCAL_DIR:-./ch-archive}"
KUBE_CONTEXT="${KUBE_CONTEXT:-fsi-demo-cluster}"
NAMESPACE="${NAMESPACE:-claude-code}"
REGION="${REGION:-ap-northeast-2}"
# REGION은 BACKUP SQL 문자열에 그대로 들어간다 — glob의 *는 알파벳이 아닌 임의 문자(예:
# 따옴표)도 허용하므로 case 패턴이 아니라 문자 집합을 엄격히 제한하는 grep -E로 검증한다.
if ! printf '%s' "$REGION" | grep -Eq '^[a-z]{2}-[a-z]+-[0-9]$'; then
  echo "REGION 형식이 이상합니다: '$REGION' (예: ap-northeast-2)" >&2
  exit 1
fi

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

# 파드 안에서 clickhouse-client를 실행한다. 비밀번호는 kubectl exec argv가 아니라 stdin으로
# 넘기고 파드 내부에서 env로 승격 — ps에 노출되지 않는다. clickhouse-client는
# CLICKHOUSE_PASSWORD env를 자동 인식하므로 --password 플래그는 쓰지 않는다: 같은 커맨드
# 라인에서 `VAR=$(cmd) other --flag "$VAR"` 형태로 쓰면 그 $VAR는 프리픽스 대입이 적용되기
# 전에 확장되어 항상 빈 문자열이 되고 인증이 실패한다.
#
# SQL도 원격 `sh -c` 문자열에 보간하지 않는다: 비밀번호 다음 줄부터를 쿼리로 읽어
# --queries-file /dev/stdin으로 넘긴다. 테이블명처럼 서버(system.replicas)에서 받아온 값이
# 쿼리에 들어가도 파드 안에서 shell로 재해석되지 않는다.
ch_query() {
  printf '%s\n%s' "$CH_PASSWORD" "$1" | kube exec -i "$POD" -- sh -c \
    'IFS= read -r pw; CLICKHOUSE_PASSWORD=$pw exec clickhouse-client --user otel_writer --queries-file /dev/stdin'
}

echo "== 1. 자격증명 확인 =="
WORKSHOP_ACCOUNT=$(aws sts get-caller-identity --profile "$WORKSHOP_PROFILE" --query Account --output text)
ARCHIVE_ACCOUNT=$(archive_aws sts get-caller-identity --query Account --output text)
echo "workshop account: $WORKSHOP_ACCOUNT"
echo "archive  account: $ARCHIVE_ACCOUNT (profile: ${ARCHIVE_PROFILE:-<default/instance profile>})"

# 버킷명 오타 + 타 계정의 write-open 버킷이 겹치면 PII가 엉뚱한 계정으로 올라갈 수 있다.
# --expected-bucket-owner는 s3api류(head-bucket 등) 옵션이고 고수준 `aws s3 sync`/`aws s3 ls`는
# 이 플래그를 모른다("Unknown options"로 즉시 실패) — 그래서 sync/ls에는 절대 붙이지 않고,
# 소유자 검증은 s3api head-bucket으로 시작 시점에 한 번만 한다.
archive_aws s3api head-bucket --bucket "$ARCHIVE_BUCKET" --expected-bucket-owner "$ARCHIVE_ACCOUNT"
echo "archive bucket owner 확인됨: $ARCHIVE_BUCKET (account $ARCHIVE_ACCOUNT)"

# infra/s3.tf의 네이밍 규칙(cc-ab-clickhouse-<acct>-<region>)과 동일 — 버킷 하나뿐이라
# terraform output을 안 읽어도 account_id만 있으면 이름을 재구성할 수 있다.
SRC_BUCKET="cc-ab-clickhouse-${WORKSHOP_ACCOUNT}-${REGION}"
# BACKUP TO S3('.../backup/<date>')가 쓰는 버킷 루트의 backup/ (infra/clickhouse.tf의
# backup_s3_prefix). cold/ 아래는 건드리지 않는다 — 랜덤 blob 키뿐이라 옮겨도 복원 불가.
SRC_PREFIX="backup"
echo "source bucket: $SRC_BUCKET (prefix: ${SRC_PREFIX}/)"

# 소스 쪽도 동일하게 소유자를 못 박는다 — 워크샵 계정 ID로 이름을 재구성하므로 정상적으로는
# 맞지만, REGION이 틀리면 남의 계정의 같은 이름 버킷을 읽을 수 있다.
aws s3api head-bucket --bucket "$SRC_BUCKET" --expected-bucket-owner "$WORKSHOP_ACCOUNT" --profile "$WORKSHOP_PROFILE"

# 여기 올라가는 데이터는 UserEmail 등 PII를 담고, 소스 클러스터의 90/180일 TTL과 달리 무기한
# 남는다. 소스 버킷엔 Public Access Block이 걸려 있으므로(infra/s3.tf) 대상도 최소 동일해야
# 한다 — 4개 항목이 모두 true가 아니면 업로드 전에 멈춘다(fail-closed).
PAB=$(archive_aws s3api get-public-access-block --bucket "$ARCHIVE_BUCKET" \
  --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' \
  --output text 2>/dev/null || true)
if [ "$PAB" != "$(printf 'True\tTrue\tTrue\tTrue')" ]; then
  echo "중단: $ARCHIVE_BUCKET 의 Public Access Block이 완전하지 않습니다 (현재: ${PAB:-설정 없음})." >&2
  echo "  aws s3api put-public-access-block --bucket $ARCHIVE_BUCKET \\" >&2
  echo "    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >&2
  exit 1
fi
echo "archive bucket public access block 확인됨"

# PAB은 public 접근만 막는다 — 특정 외부 principal에게 열린 bucket policy는 PAB을 그대로
# 통과한다. 대상 버킷은 운영자 소유가 전제이므로 fail-closed는 과하고, 경고만 남긴다.
if BUCKET_POLICY=$(archive_aws s3api get-bucket-policy --bucket "$ARCHIVE_BUCKET" --query Policy --output text 2>/dev/null); then
  echo "경고: $ARCHIVE_BUCKET 에 bucket policy가 설정되어 있습니다 — PII를 담는 버킷이므로" >&2
  echo "  의도한 principal에게만 열려 있는지 확인하세요:" >&2
  echo "$BUCKET_POLICY" >&2
fi

if [ "${SKIP_BACKUP:-0}" != "1" ]; then
  echo "== 2. 최종 BACKUP 생성 =="
  POD=$(kube get pod -l clickhouse.altinity.com/chi=cc-ab -o name | head -1)
  if [ -z "$POD" ]; then
    echo "ClickHouse pod를 찾지 못했습니다 (label clickhouse.altinity.com/chi=cc-ab)" >&2
    exit 1
  fi
  CH_PASSWORD=$(kube get secret clickhouse-writer -o jsonpath='{.data.CH_PASSWORD}' | base64 -d)

  # ponytail: 단일 pod(head -1)만 보는 건 shardsCount=1(infra/clickhouse.tf) 전제다 —
  # shard가 늘면 이 pod가 전체 데이터를 갖고 있지 않아 BACKUP이 조용히 일부만 백업한다.
  # 실측 확인(2026-07-27): uniqExact(shard_num)=1. 늘어나면 pod별 반복 또는
  # BACKUP ... ON CLUSTER로 재설계 필요 — 여기서는 미리 죽는 쪽을 선택한다.
  SHARD_COUNT=$(ch_query "SELECT uniqExact(shard_num) FROM system.clusters WHERE cluster = 'replicated'")
  if [ "$SHARD_COUNT" != "1" ]; then
    echo "중단: cluster 'replicated'의 shard 수가 ${SHARD_COUNT}입니다 — 이 스크립트는 단일" >&2
    echo "  shard(head -1로 고른 pod 하나)만 백업합니다. 다중 shard 지원이 필요합니다." >&2
    exit 1
  fi

  # 마지막이자 되돌릴 수 없는 스냅샷이므로 이 파드가 replication lag 중이면 안 된다 —
  # 어떤 테이블이 replicated인지 하드코딩하지 않고 system.replicas에서 직접 목록을 얻어
  # 전부 동기화하고, 하나라도 실패하면(set -e) 스크립트를 중단한다.
  # ponytail: 이 최종 스냅샷 실행 중에도 참가자 EC2의 otelcol이 계속 쓰기를 보내면, SYNC
  # 시점 이후 도착한 마지막 몇 초의 데이터는 이 백업에 빠질 수 있다 — teardown 직전 실행이라
  # 실무상 문제되는 경우는 드물지만, 완전한 보장이 필요하면 워크샵 참가자 인스턴스의
  # otelcol을 먼저 멈추고 이 스크립트를 실행할 것.
  REPLICATED_TABLES=$(ch_query "SELECT table FROM system.replicas WHERE database = 'claude_code'")
  echo "$REPLICATED_TABLES" | while IFS= read -r tbl; do
    [ -n "$tbl" ] || continue
    echo "SYSTEM SYNC REPLICA: claude_code.${tbl}"
    # 서버에서 받아온 값이지만 identifier로 SQL에 다시 들어가므로 백틱으로 quoting —
    # 신뢰 경계 안의 값이라 실위험은 낮지만 방어적으로 처리한다.
    ch_query "SYSTEM SYNC REPLICA claude_code.\`${tbl}\`"
  done

  BACKUP_TAG="final-$(date -u +%Y%m%dT%H%M%SZ)"
  ch_query "BACKUP DATABASE claude_code TO S3('https://${SRC_BUCKET}.s3.${REGION}.amazonaws.com/${SRC_PREFIX}/${BACKUP_TAG}')"
  echo "backup done: ${SRC_PREFIX}/${BACKUP_TAG}"
else
  echo "== 2. SKIP_BACKUP=1 — 새 백업 생성 스킵, 기존 ${SRC_PREFIX}/ 프리픽스만 이관 =="
fi

echo "== 3. 디스크 여유 공간 확인 =="
# 새 BACKUP을 이미 떴다면(2단계) 그만큼 소스가 커진 뒤에 재는 것이 맞다 — 백업 생성 전에
# 재면 방금 만든 스냅샷의 용량이 반영되지 않는다. "30일치 백업"이라는 가정으로 추정하지
# 않는다: infra/s3.tf의 30일 lifecycle 필터 자체는 기존에도 있었지만, 이 PR 전에는
# backup/에 아무것도 안 쓰였으니(구 Disk('cold_s3', ...) 백업은 딴 곳에 씀) 만료시킬
# 대상이 없었다 — CronJob이 실제로 쓰기 시작한 뒤 얼마나 쌓였는지 알 수 없으니
# 실제 크기를 재는 쪽이 안전하다.
mkdir -p "$LOCAL_DIR_ROOT"
# 프리픽스가 비어 있으면 `grep "Total Size"`가 실패해 set -e로 이유 없이 죽는다 — 명시적으로 잡는다.
SRC_LS=$(aws s3 ls --recursive --summarize "s3://${SRC_BUCKET}/${SRC_PREFIX}/" --profile "$WORKSHOP_PROFILE")
if ! SRC_BYTES=$(printf '%s' "$SRC_LS" | grep "Total Size" | awk '{print $NF}') || [ -z "$SRC_BYTES" ]; then
  echo "중단: s3://${SRC_BUCKET}/${SRC_PREFIX}/ 에 객체가 없습니다." >&2
  echo "  일별 백업 CronJob이 BACKUP TO S3(...) 방식으로 갱신됐는지(infra/clickhouse.tf) 확인하세요 —" >&2
  echo "  구버전 Disk('cold_s3', ...) 백업은 S3에 backup/ 경로를 만들지 않습니다." >&2
  exit 1
fi
FREE_BYTES=$(df -kP "$LOCAL_DIR_ROOT" | awk 'NR==2 {print $4*1024}')
echo "source size: ${SRC_BYTES:-0} bytes, local free space: ${FREE_BYTES:-unknown} bytes"
if [ -n "$FREE_BYTES" ] && [ "${SRC_BYTES:-0}" -gt "$FREE_BYTES" ]; then
  echo "여유 공간 부족으로 보입니다 — LOCAL_DIR을 더 큰 볼륨으로 옮기거나 공간을 확보하세요." >&2
  exit 1
fi

echo "== 4. 워크샵 계정 -> 로컬 다운로드 =="
# 재실행 시 이전 실행에서 남은 파일이 이번 검증을 오염시킬 수 있어 매번 새 스테이징
# 디렉터리를 쓴다. UserEmail 등 PII가 평문으로 잠깐 머무르므로, 생성 권한을 좁히고
# (umask) 스크립트가 어떻게 끝나든(성공/실패 모두) 종료 시 반드시 지운다(trap).
umask 077
STAGING_DIR="${LOCAL_DIR_ROOT}/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$STAGING_DIR"
trap 'rm -rf "$STAGING_DIR"' EXIT
aws s3 sync "s3://${SRC_BUCKET}/${SRC_PREFIX}/" "${STAGING_DIR}/backup/" --profile "$WORKSHOP_PROFILE"

SRC_OBJECT_COUNT=$(find "${STAGING_DIR}/backup" -type f | wc -l)
if [ "$SRC_OBJECT_COUNT" -eq 0 ]; then
  echo "검증 실패: 소스 ${SRC_PREFIX}/에서 받아온 파일이 0개입니다 — 빈 프리픽스를 이관한 것으로 보입니다." >&2
  exit 1
fi

echo "== 5. 스키마 사본 포함 =="
mkdir -p "${STAGING_DIR}/schema"
# 실패를 삼키면 스키마 없이도 "성공"으로 끝나 나중에야 빠진 걸 알게 된다 — 레포 루트에서
# 실행하지 않았다는 신호이므로 바로 죽는다.
cp "$(dirname "$0")/../clickhouse-schema.sql" "${STAGING_DIR}/schema/"
cp "$(dirname "$0")/../infra/files/clickhouse-schema-replicated.sql" "${STAGING_DIR}/schema/"
cp "$(dirname "$0")/../grafana-ab-queries.sql" "${STAGING_DIR}/schema/"

echo "== 6. 로컬 -> 내 계정 업로드 =="
# --delete는 쓰지 않는다: 아카이브는 append-only다. 대상 버킷 소유자는 1단계에서 이미
# head-bucket으로 확인했으므로 여기서는 반복하지 않는다(sync는 이 플래그를 지원하지 않음).
archive_aws s3 sync "${STAGING_DIR}/" "s3://${ARCHIVE_BUCKET}/${ARCHIVE_PREFIX}/" --sse AES256

echo "== 7. 검증 =="
# "라이브 소스 전체 == 아카이브 전체" 정확일치는 append-only 설계와 모순된다: 소스의 일별
# 백업이 검증 시점 사이에 만료되면(정상 동작) 아카이브가 소스의 초집합이 되어 오탐이 나고,
# 반대로 검증 타이밍에 소스가 갱신되면(TOCTOU) 방금 올린 것과 달라져도 오탐이 난다.
# 대신 "이번에 로컬로 받아온 파일들이 실제로 대상에 다 있는가"만 확인한다 — 방금 실행한
# sync를 --dryrun으로 다시 돌려 보류 작업이 남았는지 보는 것으로 충분하다.
PENDING=$(archive_aws s3 sync "${STAGING_DIR}/" "s3://${ARCHIVE_BUCKET}/${ARCHIVE_PREFIX}/" --sse AES256 --dryrun)
if [ -n "$PENDING" ]; then
  echo "검증 실패: 업로드 후에도 대상과 차이가 남아 있습니다:" >&2
  echo "$PENDING" >&2
  exit 1
fi

echo "== 완료 =="
echo "아카이브 위치: s3://${ARCHIVE_BUCKET}/${ARCHIVE_PREFIX}/"
echo "복원 절차: docs/runbooks/archive-clickhouse.md 참조"
echo ""
echo "*** infra/clickhouse.tf의 백업 목적지 변경(BACKUP TO S3(...))이 적용됐다면, 그 이후로는"
echo "*** infra/s3.tf에 이미 있던 30일 lifecycle 필터가 backup/를 실제로 만료시킵니다 —"
echo "*** 이 스크립트를 30일 넘게 재실행하지 않고 방치하지 말고, 계정 삭제 직전엔 꼭 한 번 더 돌리세요."
