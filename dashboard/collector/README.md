# ccdash device Collector

Requires Python 3.9+, outbound HTTPS to GitHub and your dashboard, and an existing
Claude Code/Codex installation. Supports Linux and macOS on amd64/arm64.
Collector 0.163.1 archives are downloaded from the official release and verified
against four pinned SHA-256 values. This package includes no binary or token.
Python 3.9/3.10 use the included MIT-licensed Tomli parser.

## Install

On EC2/Linux, enable the user service at boot and after logout once:

```bash
sudo loginctl enable-linger "$USER"
```

Log in again if your user manager was unavailable. Linger is required for reboot
and logout persistence even when `systemctl --user` currently works. The installer
detects the user manager before changing files. Do not run the installer with sudo.
macOS uses a per-user LaunchAgent, which runs while that user is logged in.

From the extracted package:

```bash
python3 ccdash-collector/install.py install --endpoint 'https://YOUR-DASHBOARD/api/ingest'
```

Paste the device token at the hidden prompt. For automation, use `--token-file`
with an existing regular file owned by your user and mode 0600; never pass the
token value in arguments. The installed token is mode 0600 inside
`~/.local/share/ccdash-collector/` (mode 0700).

The installer validates both client configurations before writing, preserves
models/providers/authentication, and creates private backups of changed files.
It checks for concurrent edits again after downloading. Failed updates restore
the previous managed files and service; client files edited by another process
are retained. If recovery itself fails, setup reports the private recovery
directory instead of deleting its backups.
Unmanaged telemetry and service conflicts require manual migration.
Custom `CODEX_HOME` or `CLAUDE_CONFIG_DIR` layouts require manual configuration.
The default attribution ID is your login name; `--user-id` accepts a chosen
nonsecret ID. Restart clients after setup.

Claude uses loopback gRPC on 127.0.0.1:4317; Codex uses loopback HTTP on
127.0.0.1:4318. For Codex backend provenance use:

```bash
python3 "$HOME/.local/share/ccdash-collector/launch-codex.py"
```

This launcher keeps the selected model, provider, profile and credentials. It
adds nonsecret provenance headers for recognized Bedrock provider endpoints;
unknown/custom backends remain unknown. Profiles, directory/worktree switches,
and project provider overrides also leave provenance unknown because their
configuration and precedence are resolved by Codex.
Direct Codex launches still collect, but
may lack backend provenance. Codex `analytics.enabled=false` is preserved and
disables native custom metric export; enable it yourself only if intended.

## Check, replace and uninstall

```bash
python3 "$HOME/.local/share/ccdash-collector/install.py" status
```

`check` is an alias for `status`. It checks local service health and configuration.
Confirm actual delivery with the dashboard device last-delivery time. Empty
queues or local health alone do not prove complete or successful telemetry.
Linux logs use `journalctl --user -u ccdash-collector`; macOS logs are in
`~/.local/share/ccdash-collector/collector.log`.

Register a replacement device and rerun the same install command, entering its
fresh token. Revoke the old device in the dashboard. Replacement restarts the
managed service and preserves its bounded persistent queue. A full queue can
drop data; token expiry/revocation prevents further delivery.

```bash
python3 "$HOME/.local/share/ccdash-collector/install.py" uninstall
```

Uninstall stops/removes the managed service and removes the local token. Revoke
the device in the dashboard too. Client settings and private backups remain for
review: restore a matching `.ccdash-backup-*` file or remove only the managed
Codex telemetry block and Claude OTEL settings, keeping models/authentication.
Review retained queues before manually removing the installation directory.

## Maintainers

Run `python3 scripts/sync-collector-package.py` from the repository to refresh
generated policies/configurator, then `--check` to detect drift. Canonical owners
are `collector-config.yaml` and `scripts/configure-client-telemetry.py`.
`node dashboard/collector/build-packages.mjs OUTPUT_DIR` builds deterministic
platform archives and their checksum manifest from an explicit public file list;
it works with a dashboard-only Docker build context. The private central policy
is never included in downloadable archives. Its ClickHouse password and internal
bearer token are mounted files, owned by the server deployment.

Device policies scrub log bodies and known content keys and allowlist trace
attributes used for diagnostics; span events and spans containing links are
dropped. Attribution IDs and measurement metadata remain. These filters do not
detect arbitrary secrets placed in otherwise supported metadata fields.
