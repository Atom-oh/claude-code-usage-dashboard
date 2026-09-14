#!/usr/bin/env bash
# Run against an isolated local database; never reuse a caller-supplied database URL.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONTAINER=""
cleanup() {
  if [ -n "$CONTAINER" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
CONTAINER=$(docker run --detach --rm \
  --publish 127.0.0.1::8123 \
  --env CLICKHOUSE_SKIP_USER_SETUP=1 \
  --ulimit nofile=262144:262144 \
  clickhouse/clickhouse-server:24.8)
for attempt in $(seq 1 60); do
  if docker exec "$CONTAINER" clickhouse-client --query 'SELECT 1' >/dev/null 2>&1; then break; fi
  if [ "$attempt" = 60 ]; then echo "Local ClickHouse did not start" >&2; exit 1; fi
  sleep 1
done
docker exec -i "$CONTAINER" clickhouse-client --multiquery < "$ROOT/clickhouse-schema.sql"
PORT=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8123/tcp") 0).HostPort}}' "$CONTAINER")
cd "$ROOT/dashboard/server"
CLIENT_SQL_TEST_URL="http://127.0.0.1:$PORT" node --test clientSql.test.js
