#!/bin/sh
# Bootstrap an empty database; verify an existing installation without executing DDL.
set -eu
set +x

: "${CH_HOST:?CH_HOST is required}"
: "${CH_PASSWORD:?CH_PASSWORD is required}"
: "${CH_EXPECTED_REPLICAS:?CH_EXPECTED_REPLICAS is required}"
CH_USER=${CH_USER:-otel_writer}
CH_PORT=${CH_PORT:-9000}
SCHEMA_DIRECTORY=${SCHEMA_DIRECTORY:-/sql}
SCHEMA_CONNECT_ATTEMPTS=${SCHEMA_CONNECT_ATTEMPTS:-60}
SCHEMA_CONNECT_WAIT_SECONDS=${SCHEMA_CONNECT_WAIT_SECONDS:-300}
SCHEMA_VERIFY_ATTEMPTS=${SCHEMA_VERIFY_ATTEMPTS:-24}
SCHEMA_QUERY_TIMEOUT_SECONDS=${SCHEMA_QUERY_TIMEOUT_SECONDS:-25}

for number in "$CH_PORT" "$CH_EXPECTED_REPLICAS" "$SCHEMA_CONNECT_ATTEMPTS" "$SCHEMA_CONNECT_WAIT_SECONDS" "$SCHEMA_VERIFY_ATTEMPTS" "$SCHEMA_QUERY_TIMEOUT_SECONDS"; do
  case "$number" in ''|*[!0-9]*|0) echo "Schema lifecycle counts must be positive integers" >&2; exit 1;; esac
  if ! [ "$number" -gt 0 ]; then
    echo "Schema lifecycle counts must be positive integers" >&2
    exit 1
  fi
done
if ! command -v timeout >/dev/null 2>&1; then
  echo "The declared schema client image must provide the timeout utility" >&2
  exit 1
fi

# The declared client reads this variable. The password is not a command-line argument.
CLICKHOUSE_PASSWORD=$CH_PASSWORD
export CLICKHOUSE_PASSWORD
read -r lifecycle_id < /proc/sys/kernel/random/uuid
bounded_client() {
  if timeout --kill-after=2s "$SCHEMA_QUERY_TIMEOUT_SECONDS" "$@"; then
    return 0
  else
    status=$?
    case "$status" in
      124|137) echo "ClickHouse metadata request exceeded its process deadline" >&2;;
    esac
    return "$status"
  fi
}
query() {
  read -r request_id < /proc/sys/kernel/random/uuid
  bounded_client clickhouse-client --host "${1%:*}" --port "${1##*:}" --user "$CH_USER" \
    --query_id "schema-inspect-$request_id" --connect_timeout=5 --receive_timeout=20 \
    --send_timeout=20 --max_execution_time=15 --readonly=1 \
    --max_memory_usage=268435456 --max_rows_to_read=10000 \
    --max_result_rows=100 --max_result_bytes=1048576 --query "$2"
}
verify() {
  read -r request_id < /proc/sys/kernel/random/uuid
  bounded_client clickhouse-client --host "${1%:*}" --port "${1##*:}" --user "$CH_USER" --multiquery \
    --query_id "schema-verify-$request_id" --connect_timeout=5 --receive_timeout=20 \
    --send_timeout=20 --max_execution_time=15 --readonly=1 \
    --max_memory_usage=268435456 --max_rows_to_read=10000 \
    --max_result_rows=100 --max_result_bytes=1048576 \
    --queries-file "$SCHEMA_DIRECTORY/clickhouse-schema-contract.sql" >/dev/null
}

schema="$SCHEMA_DIRECTORY/clickhouse-schema-replicated.sql"
contract="$SCHEMA_DIRECTORY/clickhouse-schema-contract.sql"
expected=$(sed -n 's/^-- schema-source-sha256: //p' "$contract")
actual=$(sha256sum "$schema")
actual=${actual%% *}
if [ "$expected" != "$actual" ]; then
  echo "Schema contract does not match the SQL file; regenerate and review it before installation" >&2
  exit 1
fi

connect_deadline=$(( $(date +%s) + SCHEMA_CONNECT_WAIT_SECONDS ))
wait_for_endpoint() {
  connect_attempt=0
  until query "$1" 'SELECT 1' >/dev/null 2>&1; do
    connect_attempt=$((connect_attempt + 1))
    if [ "$connect_attempt" -ge "$SCHEMA_CONNECT_ATTEMPTS" ] || [ "$(date +%s)" -ge "$connect_deadline" ]; then
      echo "Schema lifecycle could not connect to expected endpoint $1 within the configured wait; no bootstrap was started" >&2
      exit 1
    fi
    echo "Schema lifecycle: waiting for ClickHouse endpoint $1" >&2
    sleep 5
  done
}
wait_for_endpoint "$CH_HOST:$CH_PORT"

replicas=$(query "$CH_HOST:$CH_PORT" "SELECT concat(host_name, ':', toString(port)) FROM system.clusters WHERE cluster = 'replicated' ORDER BY shard_num, replica_num FORMAT TSV")
shards=$(query "$CH_HOST:$CH_PORT" "SELECT uniqExact(shard_num) FROM system.clusters WHERE cluster = 'replicated' FORMAT TSV")
count=$(printf '%s\n' "$replicas" | awk 'NF { n++ } END { print n+0 }')
unique=$(printf '%s\n' "$replicas" | sort -u | awk 'NF { n++ } END { print n+0 }')
if [ "$count" != "$CH_EXPECTED_REPLICAS" ] || [ "$unique" != "$count" ] || [ "$shards" != 1 ]; then
  echo "Schema lifecycle replica count or shard layout does not match the installation" >&2
  exit 1
fi

# Disable pathname expansion while splitting the trusted cluster host list.
set -f
nonempty=0
for host in $replicas; do
  case "$host" in ''|*[!a-zA-Z0-9.:_-]*) echo "Invalid ClickHouse replica hostname" >&2; exit 1;; esac
  # A ready service can route to the first pod while the operator starts its peers.
  # Share the connection wait deadline; every probe retains its process deadline.
  wait_for_endpoint "$host"
  topology=$(query "$host" "SELECT concat(host_name, ':', toString(port)) FROM system.clusters WHERE cluster = 'replicated' ORDER BY shard_num, replica_num FORMAT TSV")
  replica_shards=$(query "$host" "SELECT uniqExact(shard_num) FROM system.clusters WHERE cluster = 'replicated' FORMAT TSV")
  if [ "$topology" != "$replicas" ] || [ "$replica_shards" != 1 ]; then
    echo "Schema lifecycle replica topology differs between endpoints" >&2
    exit 1
  fi
  objects=$(query "$host" "SELECT count() FROM system.tables WHERE database = 'claude_code' FORMAT TSV")
  if [ "$objects" != 0 ]; then nonempty=1; fi
done

if [ "$nonempty" = 0 ]; then
  echo "Schema lifecycle: bootstrapping an empty database"
  # All schema DDL remains confined to a fresh installation. Wait for empty-table
  # materializations so the subsequent migration ledger guards see their completion.
  clickhouse-client --host "$CH_HOST" --port "$CH_PORT" --user "$CH_USER" \
    --query_id "schema-bootstrap-$lifecycle_id" \
    --mutations_sync=2 --distributed_ddl_task_timeout=600 --multiquery --queries-file "$schema"
else
  echo "Schema lifecycle: verifying existing replicas; migrations are explicit"
fi

# A fresh ledger INSERT replicates asynchronously. Allow convergence, but never replay
# schema DDL on a verifier failure or treat a partial bootstrap as another empty install.
attempt=0
while :; do
  complete=1
  for host in $replicas; do
    if ! verify "$host"; then complete=0; fi
  done
  if [ "$complete" = 1 ]; then
    echo "Schema lifecycle: every expected replica satisfies the metadata and ledger contract"
    exit 0
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$SCHEMA_VERIFY_ATTEMPTS" ]; then
    echo "Schema lifecycle verification failed; inspect partial state and follow docs/runbooks/schema-migrations.md" >&2
    exit 1
  fi
  sleep 5
done
