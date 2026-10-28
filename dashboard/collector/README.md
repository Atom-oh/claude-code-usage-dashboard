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
| Installed before automatic token renewal | See Automatic token renewal below. |
| Legacy personal macOS Collector (`com.ccdash.otelcol`) | Run Install; confirm the installer's migration prompt. |
| Legacy Linux Collector | Follow Migrate a legacy local Collector below first. |
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
(
printf 'Telemetry user ID/email: '
IFS= read -r ccdash_user_id
if [ -n "$ccdash_user_id" ]; then
  python3 install.py install --endpoint 'https://YOUR-DASHBOARD/api/ingest' --user-id "$ccdash_user_id"
else
  printf '%s\n' 'Enter a nonempty telemetry user ID/email before installing.'
fi
)
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
The known personal macOS Collector has an interactive migration path described below.
Other unmanaged telemetry and service conflicts require manual migration.
Custom `CODEX_HOME` or `CLAUDE_CONFIG_DIR` layouts require manual configuration.
The default attribution ID for a fresh installation is your login name; `--user-id`
accepts a chosen nonsecret ID. Legacy macOS migration reuses `user.email` from Claude
settings or the current shell when available; otherwise it asks for the existing ID.
Restart clients after setup.

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

## Automatic token renewal

Installation schedules `install.py renew`: a daily `ccdash-collector-renew.timer` (up to two
hours of random delay) on Linux, or the `org.ccdash.collector.renew` LaunchAgent every six
hours and at login on macOS. Within seven days of expiry the dashboard returns a replacement
token; the renewer saves it privately and restarts the Collector, keeping its queue. The old
token stops working once the replacement is first used. Failed attempts retry on the next
run. `status` shows `renewalScheduled` and `lastRenewal`; the device list shows expiry and
the last renewal. `renew` exits 0 (current or renewed), 1 (retry later) or 2 (rejected).

Earlier installations enable renewal by rerunning the latest installer once:

```bash
python3 install.py install --endpoint 'https://YOUR-DASHBOARD/api/ingest' \
  --user-id 'YOUR-EXISTING-ID' --token-file "$HOME/.local/share/ccdash-collector/token"
```

A device that is off or cannot renew for 30 days expires. Renewal continues until the device
is revoked, so revoke devices explicitly when offboarding.

## Migrate a legacy local Collector

Use this only for a personal installation created by `setup-test-telemetry-all.sh`
or `setup-test-telemetry.sh`. A prepared workshop Collector with
`/etc/otelcol/config.yaml` belongs to the organizer and must not be replaced by this
procedure. Finish and close running clients, resolve exporter errors, and let queued
records drain first. The new package does not import the old disk queue.
Keep `~/.otelcol`, the old binary, and service files for recovery.

### macOS

Run the normal install command with the latest package. No separate service-stop
command is needed for the supported legacy layout. The installer verifies:

- The current user's `com.ccdash.otelcol` LaunchAgent points to their
  `~/.otelcol/config.yaml` using `otelcol-contrib`.
- The loaded job matches that file and command; occupied ports belong to its PID.
- Service/configuration files belong to the current user and are not symlinks or
  writable by other users.

At `Migrate this legacy Collector now? [y/N]:`, enter `y` to approve the transfer.
This also approves replacing Claude telemetry exporter overrides with the package's
loopback defaults and clearing old telemetry authentication headers. Model, provider,
login, and unrelated settings are preserved; changed client files get private backups.
Declining leaves the old service and client settings unchanged. For unattended installation, use
`--migrate-legacy` with `--token-file` and an explicit `--user-id`.
The option approves only the same verified layout; it never forces unknown services
to stop. The installer does not read or reuse a ClickHouse password for device auth.

The installer downloads and validates the replacement before stopping the old
service. It saves a mode-0700 `legacy-backup-*` directory under
`~/.local/share/ccdash-collector/` with mode-0600 copies of the plist, config, env and
shell helper when present. Treat these backups as secrets. The old binary and queue
remain in place. The old LaunchAgent is disabled and unloaded, then the replacement
starts and must pass a local health check. This does not prove remote ingestion.

If startup or local health fails, the installer restores client/managed files and
the previous legacy service enablement/load state. If recovery itself fails, keep
the reported private recovery files and inspect service/port ownership before
manual recovery. Retrying a completed installation updates the new managed service.
After verifying remote receipt and deciding that rollback is no longer needed, remove
only the identified `legacy-backup-*` directory and any obsolete credential-bearing
legacy files under your retention policy. Preserve queued records until delivery or an
explicit discard decision; coordinate revocation of shared credentials with their owner.

For an unrecognized service, inspect without printing its credential environment:

```bash
lsof -nP -iTCP:4317 -iTCP:4318 -iTCP:13133 -sTCP:LISTEN
launchctl list | awk '$3 == "com.ccdash.otelcol" || $3 == "org.ccdash.collector"'
/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$HOME/Library/LaunchAgents/com.ccdash.otelcol.plist"
```

Do not kill the displayed PID or delete settings to bypass the checks. An unfamiliar
launchd diagnostic format also stops automatic migration. `org.ccdash.collector` is
the new package: update it through its installer instead of stopping another service.

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
sudo cp -p /etc/systemd/system/otelcol.service /etc/systemd/system/otelcol.service.ccdash-backup &&
sudo systemctl disable --now otelcol.service &&
sudo rm /etc/systemd/system/otelcol.service &&
sudo systemctl mask otelcol.service
```

An existing backup stops this command. Do not overwrite it; inspect the prior migration
state before proceeding.

### Continue or recover

For manual Linux migration, stop on service-management errors. Repeat the listener
query: all three ports must be free before a first installation. A permissions error is not an empty listener result.
Unknown listeners require their owner's migration procedure; do not kill arbitrary PIDs.
Missing legacy service files can be normal on a new machine.

Return to Install and use the original attribution ID. Keep the legacy
`enable-test-telemetry.sh` shell hook for now to preserve user/team attributes.
The unloaded macOS job or masked Linux service will not be restarted by its guard.
Its printed destination can be stale after migration; confirm the new path through
device receipt and actual dashboard data.

Successful macOS automatic recovery needs no manual commands. If manual recovery is
needed after a new service was created, remove the new managed service:

```bash
python3 "$HOME/.local/share/ccdash-collector/install.py" uninstall
```

Skip this command if that file does not exist. If removal fails or a listener remains,
resolve that before restarting the old service. For macOS, first inspect `migration.json`
in the reported private backup directory. The following command applies only when
`loaded` was `true` and `disabled` was `false`:

```bash
# macOS
launchctl enable "gui/$(id -u)/com.ccdash.otelcol" &&
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.ccdash.otelcol.plist"
```

If `loaded` was `false`, do not bootstrap. Restore enablement with `launchctl enable`
or `launchctl disable` according to the recorded `disabled` value. If both were `true`,
temporarily enable and bootstrap as above, then disable the label again without
booting it out. Stop if any command fails; preserve the recovery files.

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
| `local Collector port is occupied` | This is an older package. Download the updated package for the macOS migration prompt. |
| `local port ... is occupied by an unverified service` | Inspect the reported port/PID; follow the owner's migration procedure. Checks cover 4317, 4318 and health port 13133. |
| `cannot check local port ... EACCES` | Resolve local socket permissions; this is not evidence of an occupied port. |
| `systemd user manager unavailable` | Enable linger, reconnect over SSH, and rerun as the normal user. |
| Missing archive or `install.py` | Use the directory containing the download/extracted package. |
| Download or connection failure | Check HTTPS access to GitHub and the configured dashboard; retain TLS verification. |
| Expired/revoked token or authentication failure | Register a replacement device, install with its token, verify receipt, then revoke the old device. |
| `renew` exits 2 or `lastRenewal` is `unauthorized` | The token expired, was revoked or was superseded; replace the device as above. |
| Healthy local service but no receipt | Restart clients, perform work, inspect exporter errors, check filters, and refresh the device list. |
| `unmanaged Codex [otel] conflicts` | Privately back up `~/.codex/config.toml`. Explicitly migrate only its OTel table to the loopback exporters in `generated/configure-client-telemetry.py`; keep model/provider/login settings. |
| `unmanaged Claude telemetry conflicts` | For the verified legacy macOS service, download the latest package and approve migration. Otherwise review the exporter owner and endpoints, then add `--replace-claude-telemetry` to the install command only if replacing those telemetry settings and clearing old telemetry headers is intended. This option does not stop unknown services. Do not delete `settings.json`. |
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

Uninstall stops/removes the managed service, renewal schedule, local token and renewal state. Revoke
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
