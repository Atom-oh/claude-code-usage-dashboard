# ccdash device Collector

Requires Python 3.9+, outbound HTTPS to GitHub and your dashboard, and an existing
Claude Code/Codex installation. Supports Linux and macOS on amd64/arm64.
Collector 0.163.1 archives are downloaded from the official release and verified
against four pinned SHA-256 values. This package includes no binary or token.
Python 3.9/3.10 use the included MIT-licensed Tomli parser.

## Choose the installation path

| Environment | Action |
|---|---|
| Personal Mac or EC2 without a Collector | Follow Install below. |
| Already using this device-token package | Rerun installation with a replacement token and the same attribution ID. |
| Installed with `setup-test-telemetry-all.sh` or `setup-test-telemetry.sh` | Follow Migrate a legacy local Collector below first. |
| Workshop EC2 prepared by the organizer | Use the prepared clients; do not install a second Collector or issue an individual token. |

The device package requires a device token, not a ClickHouse password. The organizer's
password-based workshop bootstrap is a separate path. An unprepared Workshop Studio
instance needs organizer configuration first; see the repository's
`docs/workshop-studio-notes.md`. The existing `user-data.sh` template requires deployment
inputs and secret provisioning and is not a ready-to-run generic instance setup.

## Install

1. Sign in as an editor/admin, open **Collector installation**, select your OS, and
   download the package. Viewer/demo accounts cannot download or register devices.
2. Register a device and keep its one-time token available until setup finishes.
3. On the machine that will run Claude Code/Codex, run `python3 --version`. Install a
   supported Python if absent or older than 3.9. Install the clients separately.
4. Move the archive to that machine and open a terminal in the archive's directory.
   Extract the archive for your platform and enter the package directory:

```bash
# macOS
tar -xzf ccdash-collector-darwin.tar.gz
cd ccdash-collector
```

```bash
# EC2 / Linux
tar -xzf ccdash-collector-linux.tar.gz
cd ccdash-collector
```

Run only your platform's commands. If the browser already extracted the archive,
enter its `ccdash-collector` directory and skip extraction.

On EC2/Linux, enable the user service at boot and after logout once:

```bash
sudo loginctl enable-linger "$USER"
```

Log in again if your user manager was unavailable. Linger is required for reboot
and logout persistence even when `systemctl --user` currently works. The installer
detects the user manager before changing files. Do not run the installer with sudo.
macOS uses a per-user LaunchAgent, which runs while that user is logged in.

From the extracted package directory, enter your existing attribution ID/email to
preserve user grouping. New users should choose their organization's intended identifier.
Allowed characters are letters, numbers, `.`, `_`, `+`, `@`, and `-`.
Replace `YOUR-DASHBOARD` with your dashboard host; the web page supplies the configured
endpoint in its copyable command.

```bash
printf 'Telemetry user ID/email: '
IFS= read -r ccdash_user_id
python3 install.py install --endpoint 'https://YOUR-DASHBOARD/api/ingest' --user-id "$ccdash_user_id"
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

## Confirm receipt

Start fresh Claude Code and Codex sessions and perform actual work with each.
Check the local service:

```bash
python3 "$HOME/.local/share/ccdash-collector/install.py" status
```

`check` is an alias for `status`. It checks local service health and configuration.
Refresh **My devices** on the installation page and check the device last-delivery time.
Then check actual usage with the intended dashboard time, client, and user filters. Empty
queues or local health alone do not prove complete or successful telemetry.
Linux logs use `journalctl --user -u ccdash-collector`; macOS logs are in
`~/.local/share/ccdash-collector/collector.log`.

## Migrate a legacy local Collector

Use this only for a personal installation created by `setup-test-telemetry-all.sh`
or `setup-test-telemetry.sh`. A prepared workshop Collector with
`/etc/otelcol/config.yaml` belongs to the organizer and must not be replaced by this
procedure. Finish and close running clients, resolve exporter errors, and let queued
records drain first. The new package does not import the old disk queue.
Keep `~/.otelcol`, the old binary, and service files for recovery.

### macOS

Identify listeners and the legacy service without printing its credential environment:

```bash
lsof -nP -iTCP:4317 -iTCP:4318 -iTCP:13133 -sTCP:LISTEN
launchctl list | awk '$3 == "com.ccdash.otelcol" || $3 == "org.ccdash.collector"'
/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$HOME/Library/LaunchAgents/com.ccdash.otelcol.plist"
```

Proceed only if the label is `com.ccdash.otelcol` and its config argument points to
your own `~/.otelcol/config.yaml`. `org.ccdash.collector` is the new package: update
it through its installer instead of stopping another service.

Disable automatic launch and unload the legacy service:

```bash
launchctl disable "gui/$(id -u)/com.ccdash.otelcol" &&
launchctl bootout "gui/$(id -u)/com.ccdash.otelcol"
```

### EC2 / Linux personal installation

```bash
sudo ss -ltnp '( sport = :4317 or sport = :4318 or sport = :13133 )'
systemctl show otelcol.service --property=FragmentPath,ExecStart
systemctl --user is-active ccdash-collector.service
```

Proceed only if the legacy unit is `/etc/systemd/system/otelcol.service` and its
config argument points to your own `~/.otelcol/config.yaml`. The new user service
`ccdash-collector.service` is this package; update it through its installer.

The legacy shell helper can restart an inactive service even after `disable`.
Retain the unit under a backup name, then mask the old service to prevent that restart:

```bash
sudo test ! -e /etc/systemd/system/otelcol.service.ccdash-backup &&
sudo systemctl disable --now otelcol.service &&
sudo mv /etc/systemd/system/otelcol.service /etc/systemd/system/otelcol.service.ccdash-backup &&
sudo systemctl mask otelcol.service
```

An existing backup stops this command. Do not overwrite it; inspect the prior migration
state before proceeding.

### Continue or recover

Stop on service-management errors. Repeat the listener query: all three ports must be free
before a first installation. A permissions error is not an empty listener result.
Unknown listeners require their owner's migration procedure; do not kill arbitrary PIDs.
Missing legacy service files can be normal on a new machine.

Return to Install and use the original attribution ID. Keep the legacy
`enable-test-telemetry.sh` shell hook for now to preserve user/team attributes.
The unloaded macOS job or masked Linux service will not be restarted by its guard.
Its printed destination can be stale after migration; confirm the new path through
device receipt and actual dashboard data.

If installation fails after a new service was created, remove the new managed service:

```bash
python3 "$HOME/.local/share/ccdash-collector/install.py" uninstall
```

Skip this command if that file does not exist. If removal fails or a listener remains,
resolve that before restarting the old service. Restore only the service identified above:

```bash
# macOS
launchctl enable "gui/$(id -u)/com.ccdash.otelcol" &&
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.ccdash.otelcol.plist"
```

```bash
# Linux
sudo test -f /etc/systemd/system/otelcol.service.ccdash-backup &&
sudo systemctl unmask otelcol.service &&
sudo mv /etc/systemd/system/otelcol.service.ccdash-backup /etc/systemd/system/otelcol.service &&
sudo systemctl daemon-reload &&
sudo systemctl enable --now otelcol.service
```

The local endpoints are unchanged. Restart clients and verify the original path.
If client configuration also needs restoring, compare private `*.ccdash-backup-*`
files with current files first and preserve subsequent edits and model/login settings.
Revoke the unused new device token in the dashboard.

## Troubleshooting

| Symptom | Next action |
|---|---|
| `local Collector port is occupied` | Follow legacy migration above; the check covers 4317, 4318, and health port 13133. |
| `systemd user manager unavailable` | Enable linger, reconnect over SSH, and rerun as the normal user. |
| Missing archive or `install.py` | Use the directory containing the download/extracted package. |
| Download or connection failure | Check HTTPS access to GitHub and the configured dashboard; retain TLS verification. |
| Expired/revoked token or authentication failure | Register a replacement device, install with its token, verify receipt, then revoke the old device. |
| Healthy local service but no receipt | Restart clients, perform work, inspect exporter errors, check filters, and refresh the device list. |
| `unmanaged Codex [otel] conflicts` | Privately back up `~/.codex/config.toml`. Explicitly migrate only its OTel table to the loopback exporters in `generated/configure-client-telemetry.py`; keep model/provider/login settings. |
| `unmanaged Claude telemetry conflicts` | Review the exporter owner and endpoints. The bundled configurator offers `--replace-claude-telemetry`; read its `--help` and use `--check` first with the intended paths and attribution ID. Do not delete `settings.json`. |
| Custom config roots or symlinks | Configure the actual owner manually; the installer supports normal default paths. |

Inspect local logs without posting credentials or full configuration files:

```bash
# macOS
tail -n 50 "$HOME/.local/share/ccdash-collector/collector.log"
```

```bash
# Linux
journalctl --user -u ccdash-collector.service -n 50 --no-pager
```

## Replace and uninstall

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
