#!/usr/bin/env bash
# Source before configuring shell exporters. Inaccessible systemd is not evidence
# of an inactive Collector. Success permits configuration; it is not a health check.
_ccdash_ensure_otelcol() {
  local status output
  if ! status=$(systemctl show otelcol.service --property=LoadState --property=ActiveState 2>/dev/null); then
    return 0
  fi
  [[ "$status" == *"LoadState=loaded"* ]] || return 0
  [[ "$status" == *"ActiveState=inactive"* || "$status" == *"ActiveState=failed"* ]] || return 0

  echo "otelcol.service is not active — attempting to start it..." >&2
  if ! output=$(sudo systemctl start otelcol.service 2>&1); then
    printf 'ERROR: failed to start otelcol.service:\n%s\n' "$output" >&2
    return 1
  fi
  sleep 2 || return 1
  if ! systemctl is-active --quiet otelcol.service 2>/dev/null; then
    echo "ERROR: could not confirm otelcol.service after starting it." >&2
    return 1
  fi
  echo "otelcol.service started." >&2
}

if _ccdash_ensure_otelcol; then
  unset -f _ccdash_ensure_otelcol
else
  unset -f _ccdash_ensure_otelcol
  return 1 2>/dev/null || exit 1
fi
