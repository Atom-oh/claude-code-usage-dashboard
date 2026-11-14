import { richMessage, localizedMessage, messageText, translate, useLocale } from "../i18n/index.js";
import { useState } from "react";
import { Copy } from "lucide-react";

const INSTALL_ROOT = '"$HOME/.local/share/ccdash-collector/install.py"';
const LEGACY_MAC = '"gui/$(id -u)/com.ccdash.otelcol"';
const COMMANDS = {
  darwin: {
    inspect: `lsof -nP -iTCP:4317 -iTCP:4318 -iTCP:13133 -sTCP:LISTEN
launchctl list | awk '$3 == "com.ccdash.otelcol" || $3 == "org.ccdash.collector"'
/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$HOME/Library/LaunchAgents/com.ccdash.otelcol.plist"`,
    restore: `launchctl enable ${LEGACY_MAC} &&
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.ccdash.otelcol.plist"`,
    logs: 'tail -n 50 "$HOME/.local/share/ccdash-collector/collector.log"',
  },
  linux: {
    inspect: `sudo ss -ltnp '( sport = :4317 or sport = :4318 or sport = :13133 )'
systemctl show otelcol.service --property=FragmentPath,ExecStart
systemctl --user is-active ccdash-collector.service`,
    stop: `sudo test ! -e /etc/systemd/system/otelcol.service.ccdash-backup &&
sudo cp -p /etc/systemd/system/otelcol.service /etc/systemd/system/otelcol.service.ccdash-backup &&
sudo systemctl disable --now otelcol.service &&
sudo rm /etc/systemd/system/otelcol.service &&
sudo systemctl mask otelcol.service`,
    restore: `sudo test -f /etc/systemd/system/otelcol.service.ccdash-backup &&
sudo systemctl unmask otelcol.service &&
sudo mv /etc/systemd/system/otelcol.service.ccdash-backup /etc/systemd/system/otelcol.service &&
sudo systemctl daemon-reload &&
sudo systemctl enable --now otelcol.service`,
    logs: "journalctl --user -u ccdash-collector.service -n 50 --no-pager",
  },
};

function GuideCommand({ label, command }) {
  const _locale = useLocale();
  const [message, setMessage] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setMessage(localizedMessage("md9381128c086"));
    } catch {
      setMessage(localizedMessage("m7fff1edfdbcd"));
    }
  }
  return <div className="my-3 overflow-hidden rounded-lg border border-ink-200">
    <div className="flex items-center justify-between gap-3 bg-ink-50 px-3 py-2">
      <span className="text-xs font-medium text-ink-600">{label}</span>
      <button type="button" aria-label={translate("mdf6884bfb323", [label])} onClick={copy}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-700 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">{richMessage("m4ff2dfa86d34", [<Copy size={13} aria-hidden="true" />])}</button>
    </div>
    <pre aria-label={label} className="overflow-x-auto bg-ink-900 p-3 text-xs leading-6 text-ink-50"><code>{command}</code></pre>
    {message && <p role="status" className="px-3 py-2 text-xs text-ink-600">{messageText(message)}</p>}
  </div>;
}

export function CollectorPreparation({ platform }) {
  const _locale = useLocale();
  const [expanded, setExpanded] = useState(false);
  const commands = COMMANDS[platform];
  return <div className="space-y-4 text-sm leading-relaxed text-ink-600">
    <p>{richMessage("mbb7b27593c14", [<code>python3 --version</code>])}</p>
    <p>{translate("m851acb0c75b8")}</p>
    <div className="rounded-lg border border-ink-200 p-4">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
        className="w-full text-left font-semibold text-ink-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">{translate("m3f221794642c")}</button>
      {expanded && <div className="mt-3">
        <p>{richMessage("mc3f922699719", [<code>local Collector port is occupied</code>, <code>occupied by an unverified service</code>, <code>cannot check local port</code>, <code>setup-test-telemetry-all.sh</code>, <code>setup-test-telemetry.sh</code>])}</p>
        {platform === "darwin" && <div className="mt-3 rounded-lg bg-brand-50 p-3 text-ink-800">
          <p>{translate("m72bddf6e1eb8")}</p>
          <p className="mt-2">{richMessage("mb4a81550825a", [<code>Migrate this legacy Collector now? [y/N]</code>, <code>y</code>])}</p>
          <p className="mt-2">{translate("m9c79d00d6918")}</p>
        </div>}
        <h3 className="mt-4 font-semibold text-ink-800">{platform === "darwin" ? translate("me581acc187ed") : translate("ma4b77fefd2eb")}</h3>
        <GuideCommand key={`inspect-${platform}`} label={translate("ma1f1b9c1cf8b")} command={commands.inspect} />
        <p>{richMessage("m94e53ad0f57d", [platform === "darwin"
          ? <>{translate("me3783d2d100f")}<code>com.ccdash.otelcol</code>{translate("mfff2d9d5b027")}<code>~/.otelcol/config.yaml</code>{translate("m273139d8bc17")}</>
          : <>{translate("mf4f1527261ee")}<code>/etc/systemd/system/otelcol.service</code>{translate("ma6cc1a32046f")}<code>~/.otelcol/config.yaml</code>{translate("m273139d8bc17")}</>, platform === "linux" && translate("me2a086ea1a28")])}</p>
        <p className="mt-2">{richMessage("m3b38640a9b8c", [platform === "darwin" ? <code>org.ccdash.collector</code> : <code>ccdash-collector.service</code>])}</p>
        {platform === "linux" && <>
        <h3 className="mt-4 font-semibold text-ink-800">{translate("m2e06a824b479")}</h3>
        <p>{translate("m1d77a0be8d92")}</p>
        <p className="mt-2">{richMessage("m294a7f123e06", [<code>.ccdash-backup</code>])}</p>
        <GuideCommand key={`stop-${platform}`} label={translate("m38c2d6b9554e")} command={commands.stop} />
        <p>{translate("m4517aad22b9c")}</p>
        </>}
        <p className="mt-2">{richMessage("m2dc239655e27", [<code>~/.otelcol</code>, <code>enable-test-telemetry.sh</code>])}</p>
        <details className="mt-4 border-t border-ink-100 pt-3">
          <summary className="cursor-pointer font-medium text-ink-800">{translate("mf54107a2451c")}</summary>
          {platform === "darwin" && <p className="mt-2">{richMessage("maa823db42c35", [<code>migration.json</code>, <code>loaded: true</code>, <code>disabled: false</code>])}</p>}
          <p className="mt-2">{translate("m531fcc38ad08")}</p>
          <GuideCommand label={translate("me814c69ad2dc")} command={`python3 ${INSTALL_ROOT} uninstall`} />
          <p>{translate("m115e52631c71")}</p>
          <GuideCommand key={`restore-${platform}`} label={translate("m2ef406d09ee6")} command={commands.restore} />
          <p>{richMessage("me92f59f86105", [<code>*.ccdash-backup-*</code>])}</p>
        </details>
      </div>}
    </div>
    <details className="rounded-lg border border-ink-200 p-4">
      <summary className="cursor-pointer font-semibold text-ink-800">{translate("ma4eff212c97f")}</summary>
      <p className="mt-3">{richMessage("m4e5d6f580dcb", [<code>/etc/otelcol/config.yaml</code>])}</p>
      <p className="mt-2">{translate("m6bcd90c50830")}</p>
    </details>
  </div>;
}

export function CollectorVerification({ platform }) {
  const _locale = useLocale();
  return <div className="text-sm leading-relaxed text-ink-600">
    <ol className="list-decimal space-y-2 pl-5">
      <li>{translate("m2adfb55853bc")}</li>
      <li>{translate("ma5b9d3702c69")}</li>
    </ol>
    <GuideCommand label={translate("mfd402933b3ed")} command={`python3 ${INSTALL_ROOT} status`} />
    <details className="mb-4 rounded-lg border border-ink-200 p-4">
      <summary className="cursor-pointer font-medium text-ink-800">{translate("m832884d3af2e")}</summary>
      <p className="mt-2">{richMessage("m547514cc3ff0", [<code>codex</code>])}</p>
      <GuideCommand label={translate("m198c7adcbf8b")} command={'python3 "$HOME/.local/share/ccdash-collector/launch-codex.py"'} />
    </details>
    <p>{richMessage("mc26f6837cd0d", [<strong>{translate("m621006fb0397")}</strong>])}</p>
    <details className="mt-4 rounded-lg border border-ink-200 p-4">
      <summary className="cursor-pointer font-medium text-ink-800">{translate("m96e15f8694bf")}</summary>
      <GuideCommand key={`logs-${platform}`} label={translate("m0ac4ec4c0c08")} command={COMMANDS[platform].logs} />
      <ul className="list-disc space-y-2 pl-5">
        <li>{translate("m652763357d2c")}</li>
        <li>{translate("md56dc0745cb8")}</li>
        <li>{richMessage("m827f2f136dc1", [<code>tar</code>])}</li>
        <li>{translate("md56cd2523559")}</li>
        <li>{translate("m0f8b83790858")}</li>
        <li>{translate("m2e47f0ab0a85")}</li>
        {platform === "linux" && <li>{richMessage("m2c97b214733e", [<code>sudo loginctl enable-linger "$USER"</code>])}</li>}
      </ul>
    </details>
  </div>;
}
