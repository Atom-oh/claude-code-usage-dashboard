import { richMessage, localizedMessage, messageText, localizedFormat, translate, useLocale } from "../i18n/index.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, Laptop, RefreshCw, ShieldCheck, Terminal, Trash2 } from "lucide-react";
import { apiGet, checkAuthentication } from "../api.js";
import { useConfig } from "../ConfigContext.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { Card, Loading } from "../components/Card.jsx";
import { CollectorPreparation, CollectorVerification } from "./CollectorGuide.jsx";

const BUTTON = "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";
const SECONDARY = `${BUTTON} border border-ink-200 bg-white text-ink-700 hover:bg-ink-50`;
const PRIMARY = `${BUTTON} bg-brand-600 text-white hover:bg-brand-700`;
const PLATFORMS = { linux: { label: "Linux", hint: "EC2 · systemd", icon: Terminal },
  darwin: { label: "macOS", hint: "Apple Silicon · Intel", icon: Laptop } };
const quoteShell = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
const deviceTime = localizedFormat("DateTimeFormat", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function DeviceTime({ value }) {
  const _locale = useLocale();
  if (!value) return "—";
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(date.getTime())) return "—";
  return <time dateTime={value} title={value}>{deviceTime.format(date)}</time>;
}

function Notice({ children }) {
  const _locale = useLocale();
  return <p role="alert" className="rounded-md border border-negative-border bg-negative-surface px-3 py-2.5 text-sm leading-relaxed text-negative-text">{children}</p>;
}

function StepTitle({ number, children }) {
  const _locale = useLocale();
  return <div className="flex items-center gap-2.5">
    <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{number}</span>
    <h2>{children}</h2>
  </div>;
}

export default function CollectorSetup() {
  const _locale = useLocale();
  const { session } = useConfig();
  if (!session?.permissions?.includes("collector:manage")) return <div>
    <PageHeader title={translate("m8398b2a440cd")} />
    <div className="p-4 sm:p-8"><Notice>{translate("m0612b78edcb3")}</Notice></div>
  </div>;
  return <CollectorManager />;
}

function CollectorManager() {
  const _locale = useLocale();
  const [attempt, setAttempt] = useState(0);
  const [setup, setSetup] = useState({ loading: true, data: null, error: false });
  const [platform, setPlatform] = useState("linux");
  const [name, setName] = useState("");
  const [issued, setIssued] = useState(null);
  const [tokenMessage, setTokenMessage] = useState("");
  const [commandMessage, setCommandMessage] = useState("");
  const [issueError, setIssueError] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [devices, setDevices] = useState({ items: [], nextCursor: null, requestedCursor: null, loading: true, loaded: false, error: false });
  const [confirmId, setConfirmId] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [revokeError, setRevokeError] = useState("");
  const [deviceMessage, setDeviceMessage] = useState("");
  const [clock, setClock] = useState(Date.now);
  const requests = useRef(new Set());
  const issuePending = useRef(false);
  const listPending = useRef(false);
  const revokePending = useRef(false);
  const copyGeneration = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => () => {
    for (const request of requests.current) request.abort();
    requests.current.clear();
    copyGeneration.current++;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSetup({ loading: true, data: null, error: false });
    apiGet("/api/collector", {}, controller.signal).then(data => {
      if (!controller.signal.aborted) setSetup({ loading: false, data, error: false });
    }, () => {
      if (!controller.signal.aborted) setSetup({ loading: false, data: null, error: true });
    });
    return () => controller.abort();
  }, [attempt]);

  const loadDevices = useCallback(async (cursor = null) => {
    if (listPending.current) return;
    listPending.current = true;
    const controller = new AbortController();
    requests.current.add(controller);
    setDevices(previous => ({ ...previous, requestedCursor: cursor, loading: true, error: false }));
    try {
      const data = await apiGet("/api/collector/devices", cursor ? { cursor } : {}, controller.signal);
      if (controller.signal.aborted) return;
      setDevices(previous => ({
        items: cursor
          ? [...previous.items, ...data.devices.filter(item => !previous.items.some(existing => existing.id === item.id))]
          : data.devices,
        nextCursor: data.nextCursor, requestedCursor: cursor, loading: false, loaded: true, error: false,
      }));
    } catch {
      if (!controller.signal.aborted) setDevices(previous => ({ ...previous, loading: false, error: true }));
    } finally {
      requests.current.delete(controller);
      listPending.current = false;
    }
  }, []);
  useEffect(() => {
    if (setup.data?.enabled) void loadDevices();
  }, [setup.data, loadDevices]);

  const clearToken = () => {
    copyGeneration.current++;
    setIssued(null);
    setTokenMessage(localizedMessage("m7ee914a8f309"));
  };
  const copy = async (value, kind) => {
    const generation = ++copyGeneration.current;
    const feedback = kind === "token" ? setTokenMessage : setCommandMessage;
    try {
      await navigator.clipboard.writeText(value);
      if (copyGeneration.current !== generation) return;
      feedback(kind === "token" ? localizedMessage("mc159433c5f9c") : localizedMessage("mc1a369351b59"));
    } catch {
      if (copyGeneration.current !== generation) return;
      feedback(localizedMessage("m781e74d9ccef"));
    }
  };
  const issue = async event => {
    event.preventDefault();
    if (issuePending.current || listPending.current || revokePending.current || issued) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
      setIssueError(localizedMessage("m083b26f6625a"));
      return;
    }
    issuePending.current = true;
    const controller = new AbortController();
    requests.current.add(controller);
    setIssuing(true);
    setIssueError("");
    setTokenMessage("");
    try {
      const response = await fetch("/api/collector/devices", {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: trimmed, platform }),
      });
      checkAuthentication(response);
      if (!response.ok) throw new Error("issue_failed");
      const data = await response.json();
      if (controller.signal.aborted) return;
      setIssued(data);
      setDevices(previous => ({ ...previous, items: [data.device, ...previous.items], loaded: true }));
      setName("");
    } catch {
      if (!controller.signal.aborted) setIssueError(localizedMessage("m2513ea2d6b0f"));
    } finally {
      requests.current.delete(controller);
      issuePending.current = false;
      if (!controller.signal.aborted) setIssuing(false);
    }
  };
  const revoke = async device => {
    if (revokePending.current || listPending.current || issuePending.current) return;
    revokePending.current = true;
    const controller = new AbortController();
    requests.current.add(controller);
    setRevoking(device.id);
    setRevokeError("");
    setDeviceMessage("");
    try {
      const response = await fetch(`/api/collector/devices/${encodeURIComponent(device.id)}`, {
        method: "DELETE", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      checkAuthentication(response);
      if (!response.ok) throw new Error("revoke_failed");
      if (controller.signal.aborted) return;
      setDevices(previous => ({ ...previous, items: previous.items.map(item => item.id === device.id
        ? { ...item, revokedAt: new Date().toISOString() } : item) }));
      if (issued?.device.id === device.id) clearToken();
      setConfirmId(null);
      setDeviceMessage(localizedMessage("m1d48334bb262", [device.name]));
    } catch {
      if (!controller.signal.aborted) setRevokeError(localizedMessage("m6cbdc506336f"));
    } finally {
      requests.current.delete(controller);
      revokePending.current = false;
      if (!controller.signal.aborted) setRevoking(null);
    }
  };
  const activePlatform = PLATFORMS[platform];
  const prerequisite = platform === "linux" ? 'sudo loginctl enable-linger "$USER" &&\n' : "";
  // The served script detects the OS and downloads the package with the device token itself.
  const command = setup.data?.installScriptUrl
    ? `${prerequisite}curl -fsSL ${quoteShell(setup.data.installScriptUrl)} | sh`
    : "";
  const busy = issuing || devices.loading || revoking !== null;

  return <div>
    <PageHeader title={translate("m8398b2a440cd")} subtitle={translate("mfb85dfcdfba7")} />
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      {setup.loading && <Loading />}
      {setup.error && <div className="space-y-3">
        <Notice>{translate("mf4fbc13fea44")}</Notice>
        <button type="button" className={SECONDARY} onClick={() => setAttempt(value => value + 1)}>{translate("m196856a662bd")}</button>
      </div>}
      {setup.data && !setup.data.enabled && <Card>
        <div className="flex items-start gap-3"><ShieldCheck size={22} className="shrink-0 text-ink-400" aria-hidden="true" />
          <div><h2 className="font-semibold">{translate("m0e0ce5bac1c8")}</h2>
            <p className="mt-2 text-sm text-ink-600">{translate("m1142d013f90a")}</p></div></div>
      </Card>}
      {setup.data?.enabled && <>
        <div className="flex items-start gap-3 rounded-lg border border-brand-100 bg-brand-50 p-4 sm:p-5">
          <ShieldCheck size={23} className="mt-0.5 shrink-0 text-brand-600" aria-hidden="true" />
          <div><p className="font-medium text-brand-900">{translate("m78ab8c55b036")}</p>
            <p className="mt-1 text-sm leading-relaxed text-brand-800">{richMessage("m46e99af071cf", [setup.data.tokenLifetimeDays])}</p>
          </div>
        </div>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Card title={<StepTitle number="1">{translate("mec051fdf6d04")}</StepTitle>} subtitle={translate("mcf5e6d79c468")}>
            <div className="grid grid-cols-2 gap-3">
              {Object.entries(PLATFORMS).filter(([key]) => setup.data.platforms?.includes(key)).map(([key, item]) => {
                const Icon = item.icon;
                return <button type="button" key={key} aria-label={translate("m6aca100eeed4", [item.label])} aria-pressed={key === platform}
                  disabled={issuing || !!issued}
                  onClick={() => { setPlatform(key); setCommandMessage(""); }}
                  className={`flex min-w-0 flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${key === platform ? "border-brand-500 bg-brand-50 text-brand-800" : "border-ink-200 hover:border-brand-300"}`}>
                  <Icon size={23} strokeWidth={1.6} aria-hidden="true" />
                  <span className="font-semibold">{item.label}</span>
                  <span className="text-xs text-ink-500">{item.hint}</span>
                </button>;
              })}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-ink-500">{richMessage("m10b497709383", [setup.data.collectorVersion])}</p>
          </Card>
          <Card title={<StepTitle number="2">{translate("m86703e2a17a1")}</StepTitle>} subtitle={translate("m7554649d3881")}>
            <form onSubmit={issue}>
              <label htmlFor="collector-device-name" className="block text-sm font-medium">{translate("m2834016a200a")}</label>
              <input id="collector-device-name" autoComplete="off" maxLength={64} required value={name}
                disabled={issuing || !!issued} placeholder={translate("m78d5db1b18eb")}
                onChange={event => setName(event.target.value)}
                className="mt-2 w-full rounded-md border border-ink-200 bg-white px-3 py-2.5 text-sm placeholder:text-ink-500 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-ink-50" />
              <p className="mt-2 text-xs text-ink-500">{richMessage("m571e8daa1327", [activePlatform.label])}</p>
              <button type="submit" className={`${PRIMARY} mt-4 w-full`} disabled={busy || !!issued || !name.trim()}>
                <KeyRound size={16} aria-hidden="true" />{issuing ? translate("ma723c53b87a2") : translate("m0bc5b9c69a9c")}
              </button>
            </form>
            {issueError && <div className="mt-3"><Notice>{messageText(issueError)}</Notice></div>}
            {issued && <section aria-label={translate("meb8b292d38fc")} className="mt-4 rounded-lg border border-positive-border bg-positive-surface p-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-positive-text">{richMessage("m42282a15c5a4", [<Check size={16} aria-hidden="true" />])}</p>
              <p className="mt-2 text-xs leading-relaxed text-ink-600">{richMessage("m863f1f19d005", [issued.device.name, <DeviceTime value={issued.device.expiresAt} />])}</p>
              <textarea readOnly aria-label={translate("m1384460df5c7")} value={issued.token} rows={3} spellCheck={false}
                className="mt-3 w-full resize-none rounded-md border border-positive-border bg-white p-2.5 font-mono text-xs leading-relaxed text-ink-800" />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={SECONDARY} onClick={() => copy(issued.token, "token")}>{richMessage("m738bd42c00c9", [<Copy size={14} aria-hidden="true" />])}</button>
                <button type="button" className={SECONDARY} onClick={clearToken}>{translate("mffac6cd46a72")}</button>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-600">{translate("mbf67948bb243")}</p>
            </section>}
            {tokenMessage && <p role="status" className="mt-3 text-sm text-ink-600">{messageText(tokenMessage)}</p>}
          </Card>
        </div>
        <Card title={<StepTitle number="3">{translate("mf3b7242cce41")}</StepTitle>}>
          <CollectorPreparation platform={platform} />
        </Card>
        <Card title={<StepTitle number="4">{translate("m7864c23f62a6")}</StepTitle>} subtitle={translate("mae0c2f5f3c26")}>
          {platform === "linux" && <p className="mb-3 text-sm leading-relaxed text-ink-600">{translate("mabc396cb50eb")}</p>}
          <div className="overflow-hidden rounded-lg bg-ink-900 text-ink-50">
            <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
              <span className="flex items-center gap-2 text-xs text-ink-300">{richMessage("me88a9611d2c4", [<Terminal size={14} aria-hidden="true" />, activePlatform.label])}</span>
              <button type="button" onClick={() => copy(command, "command")} className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-ink-100 hover:bg-ink-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400">{richMessage("mf82b8171e154", [<Copy size={13} aria-hidden="true" />])}</button>
            </div>
            <pre aria-label={translate("m3086d9bb06c6")} className="overflow-x-auto p-4 font-mono text-xs leading-7 sm:text-sm"><code>{command}</code></pre>
          </div>
          {commandMessage && <p role="status" className="mt-3 text-sm text-ink-600">{messageText(commandMessage)}</p>}
          <ol className="mt-4 space-y-2 text-sm leading-relaxed text-ink-600">
            <li>{translate("m4a32040bfd23")}</li>
            {platform === "linux" && <li>{translate("me464149bea91")}</li>}
            <li>{translate("m309f6073e255")}</li>
            <li>{translate("m579c2c702a6e")}</li>
          </ol>
          <p className="mt-3 text-xs leading-relaxed text-ink-500">{translate("md1a9f9274589")}</p>
        </Card>
        <Card title={<StepTitle number="5">{translate("m6bbeb44e673f")}</StepTitle>}>
          <CollectorVerification platform={platform} />
        </Card>
        <Card title={<h2>{translate("me3b0f13d702f")}</h2>} subtitle={translate("mb3225bc29528")}
          right={<button type="button" className={SECONDARY} disabled={busy} onClick={() => loadDevices()}>
            <RefreshCw size={14} aria-hidden="true" /><span>{translate("mb9254a0b59f1")}</span></button>}>
          {devices.loading && !devices.loaded && <Loading />}
          {devices.error && <div className="mb-4 space-y-3"><Notice>{translate("mc46564b51815")}{devices.loaded && translate("md6dd6128067f")}</Notice>
            <button type="button" className={SECONDARY} disabled={busy} onClick={() => loadDevices(devices.requestedCursor)}>{translate("mb171f7ca3226")}</button></div>}
          {devices.loaded && !devices.items.length && <div className="rounded-md bg-ink-50 px-4 py-7 text-center">
            <Laptop size={26} className="mx-auto text-ink-400" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium">{translate("m262329fddc4f")}</p>
            <p className="mt-1 text-sm text-ink-500">{translate("mb14c9b0c804f")}</p>
          </div>}
          <div className="divide-y divide-ink-100">
            {devices.items.map(device => {
              const expired = Date.parse(device.expiresAt) <= Math.max(clock, Date.now());
              const disabled = !!device.revokedAt || expired;
              return <section key={device.id} aria-label={translate("m68557178a053", [device.name])} className="py-4 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="break-all text-sm font-semibold">{device.name}</h3>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${disabled ? "bg-ink-100 text-ink-600" : "bg-brand-50 text-brand-700"}`}>
                        {device.revokedAt ? translate("mb6d4dd12b920") : expired ? translate("mf0aaba281f34") : translate("m1b9cb0328ad9")}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">{PLATFORMS[device.platform]?.label || device.platform}</p>
                  </div>
                  {!device.revokedAt && <button type="button" className={SECONDARY} aria-label={translate("medace76aa167", [device.name])} disabled={busy}
                    onClick={() => { setConfirmId(device.id); setRevokeError(""); }}>{richMessage("mdc9d03f7ee1b", [<Trash2 size={14} aria-hidden="true" />])}</button>}
                </div>
                <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
                  <div><dt className="text-ink-500">{translate("mbb216f104fde")}</dt><dd className="mt-1 text-ink-700"><DeviceTime value={device.createdAt} /></dd></div>
                  <div><dt className="text-ink-500">{translate("mc64674dc5592")}</dt><dd className="mt-1 text-ink-700"><DeviceTime value={device.expiresAt} /></dd></div>
                  <div><dt className="text-ink-500">{translate("m56ba41779428")}</dt><dd className="mt-1 text-ink-700">{device.lastSeenAt ? <DeviceTime value={device.lastSeenAt} /> : translate("mf28cf1b64817")}</dd></div>
                </dl>
                {device.revokedAt && <p className="mt-2 text-xs text-ink-500">{richMessage("m79c35add742c", [<DeviceTime value={device.revokedAt} />])}</p>}
                {device.renewedAt && <p className="mt-2 text-xs text-ink-500">{richMessage("m3f65984a5fad", [<DeviceTime value={device.renewedAt} />])}</p>}
                {device.reuseDetectedAt && !device.revokedAt && <p role="alert" className="mt-2 rounded-md border border-warning-border bg-warning-surface p-2 text-xs text-warning-text">{richMessage("md792b5666314", [<DeviceTime value={device.reuseDetectedAt} />])}</p>}
                {confirmId === device.id && !device.revokedAt && <div role="group" aria-label={translate("m0454b3a47f2b", [device.name])}
                  className="mt-3 rounded-md border border-warning-border bg-warning-surface p-3">
                  <p className="text-sm text-warning-text">{translate("m2800dc1c7ff6")}</p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className={`${BUTTON} bg-negative text-white`} disabled={busy} onClick={() => revoke(device)}>
                      {revoking === device.id ? translate("m00b12b48ffbc") : translate("m5ec81f076613")}</button>
                    <button type="button" className={SECONDARY} disabled={revoking !== null} onClick={() => setConfirmId(null)}>{translate("mbe876433993a")}</button>
                  </div>
                  {revokeError && <div className="mt-3"><Notice>{messageText(revokeError)}</Notice></div>}
                </div>}
              </section>;
            })}
          </div>
          {devices.nextCursor && <button type="button" className={`${SECONDARY} mt-4 w-full`} disabled={busy}
            onClick={() => loadDevices(devices.nextCursor)}>{devices.loading ? translate("m1035a5731b39") : translate("ma03efdadf195")}</button>}
          {deviceMessage && <p role="status" className="mt-3 text-sm text-positive-text">{messageText(deviceMessage)}</p>}
          <p className="mt-4 border-t border-ink-100 pt-4 text-xs leading-relaxed text-ink-500">{richMessage("m7612bf864609", [deviceTime.resolvedOptions().timeZone])}</p>
        </Card>
      </>}
    </div>
  </div>;
}
