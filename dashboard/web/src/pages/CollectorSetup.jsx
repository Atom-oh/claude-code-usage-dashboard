import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Download, KeyRound, Laptop, RefreshCw, ShieldCheck, Terminal, Trash2 } from "lucide-react";
import { apiGet, checkAuthentication, fetchWithCapacityRetry } from "../api.js";
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
const deviceTime = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function DeviceTime({ value }) {
  if (!value) return "—";
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(date.getTime())) return "—";
  return <time dateTime={value} title={value}>{deviceTime.format(date)}</time>;
}

function Notice({ children }) {
  return <p role="alert" className="rounded-md border border-negative-border bg-negative-surface px-3 py-2.5 text-sm leading-relaxed text-negative-text">{children}</p>;
}

function StepTitle({ number, children }) {
  return <div className="flex items-center gap-2.5">
    <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{number}</span>
    <h2>{children}</h2>
  </div>;
}

export default function CollectorSetup() {
  const { session } = useConfig();
  if (!session?.permissions?.includes("collector:manage")) return <div>
    <PageHeader title="수집기 설치" />
    <div className="p-4 sm:p-8"><Notice>기기 등록과 수집기 다운로드 권한이 없습니다. 조직 관리자에게 권한을 요청해 주세요.</Notice></div>
  </div>;
  return <CollectorManager />;
}

function CollectorManager() {
  const [attempt, setAttempt] = useState(0);
  const [setup, setSetup] = useState({ loading: true, data: null, error: false });
  const [platform, setPlatform] = useState("linux");
  const [name, setName] = useState("");
  const [issued, setIssued] = useState(null);
  const [tokenMessage, setTokenMessage] = useState("");
  const [commandMessage, setCommandMessage] = useState("");
  const [issueError, setIssueError] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [download, setDownload] = useState({ pending: false, error: false, complete: false });
  const [devices, setDevices] = useState({ items: [], nextCursor: null, requestedCursor: null, loading: true, loaded: false, error: false });
  const [confirmId, setConfirmId] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [revokeError, setRevokeError] = useState("");
  const [deviceMessage, setDeviceMessage] = useState("");
  const [clock, setClock] = useState(Date.now);
  const requests = useRef(new Set());
  const issuePending = useRef(false);
  const downloadPending = useRef(false);
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
    setTokenMessage("화면에서 토큰을 지웠습니다. 다시 표시할 수 없습니다.");
  };
  const copy = async (value, kind) => {
    const generation = ++copyGeneration.current;
    const feedback = kind === "token" ? setTokenMessage : setCommandMessage;
    try {
      await navigator.clipboard.writeText(value);
      if (copyGeneration.current !== generation) return;
      feedback(kind === "token" ? "토큰을 복사했습니다." : "설치 명령을 복사했습니다.");
    } catch {
      if (copyGeneration.current !== generation) return;
      feedback("복사하지 못했습니다. 내용을 직접 선택해 복사해 주세요.");
    }
  };
  const issue = async event => {
    event.preventDefault();
    if (issuePending.current || listPending.current || revokePending.current || issued) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
      setIssueError("기기 이름을 제어 문자 없이 1~64자로 입력해 주세요.");
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
      if (!controller.signal.aborted) setIssueError("토큰을 발급하지 못했습니다. 연결과 권한을 확인해 주세요. 응답을 받지 못한 기기가 목록에 있다면 해지한 후 다시 등록하세요.");
    } finally {
      requests.current.delete(controller);
      issuePending.current = false;
      if (!controller.signal.aborted) setIssuing(false);
    }
  };
  const downloadPackage = async () => {
    if (downloadPending.current) return;
    downloadPending.current = true;
    const controller = new AbortController();
    requests.current.add(controller);
    setDownload({ pending: true, error: false, complete: false });
    try {
      const response = await fetchWithCapacityRetry(`/api/collector/package/${platform}`, {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      checkAuthentication(response);
      const type = response.headers?.get("Content-Type")?.split(";")[0].trim().toLowerCase();
      if (!response.ok || !["application/gzip", "application/x-gzip", "application/octet-stream"].includes(type))
        throw new Error("download_failed");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `ccdash-collector-${platform}.tar.gz`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setDownload({ pending: false, error: false, complete: true });
    } catch {
      if (!controller.signal.aborted) setDownload({ pending: false, error: true, complete: false });
    } finally {
      requests.current.delete(controller);
      downloadPending.current = false;
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
      setDeviceMessage(`${device.name} 기기를 해지했습니다. 수집 중단까지 최대 10초가 걸릴 수 있습니다.`);
    } catch {
      if (!controller.signal.aborted) setRevokeError("기기를 해지하지 못했습니다. 연결과 권한을 확인한 후 다시 시도해 주세요.");
    } finally {
      requests.current.delete(controller);
      revokePending.current = false;
      if (!controller.signal.aborted) setRevoking(null);
    }
  };
  const activePlatform = PLATFORMS[platform];
  const prerequisite = platform === "linux" ? 'sudo loginctl enable-linger "$USER"\n' : "";
  const command = setup.data?.endpoint
    ? `(
set -e
${prerequisite}tar -xzf ccdash-collector-${platform}.tar.gz
printf '수집 사용자 ID/이메일 (기존 설치는 동일한 값): '
IFS= read -r ccdash_user_id
test -n "$ccdash_user_id" || { printf '사용자 ID를 입력한 뒤 다시 실행하세요.\\n' >&2; exit 1; }
python3 ccdash-collector/install.py install --endpoint ${quoteShell(setup.data.endpoint)} --user-id "$ccdash_user_id"
)`
    : "";
  const busy = issuing || devices.loading || revoking !== null;

  return <div>
    <PageHeader title="수집기 설치" subtitle="내 기기에 Claude Code와 Codex 수집을 연결하고, 기기별로 관리하세요." />
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      {setup.loading && <Loading />}
      {setup.error && <div className="space-y-3">
        <Notice>수집기 설정을 불러오지 못했습니다. 연결과 권한을 확인한 후 다시 시도해 주세요.</Notice>
        <button type="button" className={SECONDARY} onClick={() => setAttempt(value => value + 1)}>다시 시도</button>
      </div>}
      {setup.data && !setup.data.enabled && <Card>
        <div className="flex items-start gap-3"><ShieldCheck size={22} className="shrink-0 text-ink-400" aria-hidden="true" />
          <div><h2 className="font-semibold">기기 수집이 아직 활성화되지 않았습니다.</h2>
            <p className="mt-2 text-sm text-ink-600">조직 관리자에게 수집기 연결 설정을 요청해 주세요.</p></div></div>
      </Card>}
      {setup.data?.enabled && <>
        <div className="flex items-start gap-3 rounded-lg border border-brand-100 bg-brand-50 p-4 sm:p-5">
          <ShieldCheck size={23} className="mt-0.5 shrink-0 text-brand-600" aria-hidden="true" />
          <div><p className="font-medium text-brand-900">한 번의 설치로 Claude Code와 Codex를 연결하세요.</p>
            <p className="mt-1 text-sm leading-relaxed text-brand-800">기기 토큰은 수집 전용이며 대시보드 조회 권한이 없습니다.
              유효기간은 {setup.data.tokenLifetimeDays}일로 브라우저 로그인 세션과 별개입니다.</p>
          </div>
        </div>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Card title={<StepTitle number="1">운영체제와 다운로드</StepTitle>} subtitle="수집할 기기의 운영체제를 선택하세요.">
            <div className="grid grid-cols-2 gap-3">
              {Object.entries(PLATFORMS).filter(([key]) => setup.data.platforms?.includes(key)).map(([key, item]) => {
                const Icon = item.icon;
                return <button type="button" key={key} aria-label={`${item.label} 선택`} aria-pressed={key === platform}
                  disabled={issuing || download.pending || !!issued}
                  onClick={() => { setPlatform(key); setCommandMessage(""); setDownload({ pending: false, error: false, complete: false }); }}
                  className={`flex min-w-0 flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${key === platform ? "border-brand-500 bg-brand-50 text-brand-800" : "border-ink-200 hover:border-brand-300"}`}>
                  <Icon size={23} strokeWidth={1.6} aria-hidden="true" />
                  <span className="font-semibold">{item.label}</span>
                  <span className="text-xs text-ink-500">{item.hint}</span>
                </button>;
              })}
            </div>
            <button type="button" className={`${PRIMARY} mt-4 w-full`} disabled={download.pending} onClick={downloadPackage}>
              <Download size={16} aria-hidden="true" />{download.pending ? "다운로드 중..." : `${activePlatform.label} 패키지 다운로드`}
            </button>
            <p className="mt-3 text-xs leading-relaxed text-ink-500">amd64 / arm64 지원 · Python 3.9+ 필요 · Collector {setup.data.collectorVersion}</p>
            {download.error && <div className="mt-3"><Notice>패키지를 다운로드하지 못했습니다. 연결과 권한을 확인한 후 다시 다운로드해 주세요.</Notice></div>}
            {download.complete && <p role="status" className="mt-3 text-sm text-positive-text">다운로드를 시작했습니다. 수집할 기기로 파일을 옮겨 주세요.</p>}
          </Card>
          <Card title={<StepTitle number="2">기기 등록과 토큰 발급</StepTitle>} subtitle="어느 기기인지 알아볼 수 있는 이름을 입력하세요.">
            <form onSubmit={issue}>
              <label htmlFor="collector-device-name" className="block text-sm font-medium">기기 이름</label>
              <input id="collector-device-name" autoComplete="off" maxLength={64} required value={name}
                disabled={issuing || !!issued} placeholder="예: 작업용 Mac, EC2 개발"
                onChange={event => setName(event.target.value)}
                className="mt-2 w-full rounded-md border border-ink-200 bg-white px-3 py-2.5 text-sm placeholder:text-ink-500 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-ink-50" />
              <p className="mt-2 text-xs text-ink-500">{activePlatform.label} 기기로 등록합니다. 이름은 최대 64자입니다.</p>
              <button type="submit" className={`${PRIMARY} mt-4 w-full`} disabled={busy || !!issued || !name.trim()}>
                <KeyRound size={16} aria-hidden="true" />{issuing ? "발급 중..." : "기기 등록 및 토큰 발급"}
              </button>
            </form>
            {issueError && <div className="mt-3"><Notice>{issueError}</Notice></div>}
            {issued && <section aria-label="발급된 기기 토큰" className="mt-4 rounded-lg border border-positive-border bg-positive-surface p-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-positive-text"><Check size={16} aria-hidden="true" />토큰은 지금 한 번만 표시됩니다.</p>
              <p className="mt-2 text-xs leading-relaxed text-ink-600">{issued.device.name} · 만료 <DeviceTime value={issued.device.expiresAt} /></p>
              <textarea readOnly aria-label="기기 수집 토큰" value={issued.token} rows={3} spellCheck={false}
                className="mt-3 w-full resize-none rounded-md border border-positive-border bg-white p-2.5 font-mono text-xs leading-relaxed text-ink-800" />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={SECONDARY} onClick={() => copy(issued.token, "token")}><Copy size={14} aria-hidden="true" />토큰 복사</button>
                <button type="button" className={SECONDARY} onClick={clearToken}>화면에서 토큰 지우기</button>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-600">설치할 때 붙여 넣으세요. 화면을 떠나거나 지우면 다시 볼 수 없습니다. 잃어버리면 이 기기를 해지하고 새로 등록하세요.</p>
            </section>}
            {tokenMessage && <p role="status" className="mt-3 text-sm text-ink-600">{tokenMessage}</p>}
          </Card>
        </div>
        <Card title={<StepTitle number="3">설치 전 확인</StepTitle>}>
          <CollectorPreparation platform={platform} />
        </Card>
        <Card title={<StepTitle number="4">터미널에서 설치</StepTitle>} subtitle="수집할 기기에서 다운로드한 파일이 있는 폴더를 여세요.">
          {platform === "linux" && <p className="mb-3 text-sm leading-relaxed text-ink-600">SSH 로그아웃·재부팅 후에도 수집을 유지하려면 첫 명령으로 사용자 서비스의 지속 실행을 설정하세요.
            이 설정에만 sudo 권한이 필요하며, 수집기 설치 명령은 일반 사용자로 실행하세요.</p>}
          <div className="overflow-hidden rounded-lg bg-ink-900 text-ink-50">
            <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
              <span className="flex items-center gap-2 text-xs text-ink-300"><Terminal size={14} aria-hidden="true" />{activePlatform.label} 터미널</span>
              <button type="button" onClick={() => copy(command, "command")} className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-ink-100 hover:bg-ink-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400">
                <Copy size={13} aria-hidden="true" />설치 명령 복사</button>
            </div>
            <pre aria-label="설치 명령" className="overflow-x-auto p-4 font-mono text-xs leading-7 sm:text-sm"><code>{command}</code></pre>
          </div>
          {commandMessage && <p role="status" className="mt-3 text-sm text-ink-600">{commandMessage}</p>}
          <ol className="mt-4 space-y-2 text-sm leading-relaxed text-ink-600">
            <li>사용자 ID에는 기존 수집에 사용하던 ID/이메일을 입력하세요. 처음 설치한다면 조직에서 사용할 식별값을 입력하세요. 영문·숫자와 . _ + @ -만 사용할 수 있습니다.</li>
            {platform === "linux" && <li>사용자 서비스 연결 오류가 나면 다시 로그인한 뒤 수집기 설치 명령을 실행하세요.</li>}
            <li>명령을 실행한 뒤 토큰 입력 안내가 나오면 복사한 토큰을 붙여 넣고 Enter를 누르세요. 입력 내용은 화면에 표시되지 않습니다.</li>
            <li>설치 후 터미널을 새로 열고 Claude Code와 Codex에서 새 세션을 시작하세요.</li>
          </ol>
          <p className="mt-3 text-xs leading-relaxed text-ink-500">토큰을 명령에 직접 넣지 마세요. 실행 중인 기기는 만료 7일 전부터 토큰을 자동으로 갱신합니다.
            만료·해지된 기기는 새 토큰으로 설치를 다시 실행하세요. 이전 패키지 설치는 README 안내대로 다시 설치해야 갱신이 켜집니다.</p>
        </Card>
        <Card title={<StepTitle number="5">수신 확인</StepTitle>}>
          <CollectorVerification platform={platform} />
        </Card>
        <Card title={<h2>내 기기</h2>} subtitle="내가 등록한 기기의 만료일과 최근 수신을 확인하세요."
          right={<button type="button" className={SECONDARY} disabled={busy} onClick={() => loadDevices()}>
            <RefreshCw size={14} aria-hidden="true" /><span>목록 새로고침</span></button>}>
          {devices.loading && !devices.loaded && <Loading />}
          {devices.error && <div className="mb-4 space-y-3"><Notice>기기 목록을 불러오지 못했습니다.
            {devices.loaded && " 아래 내용은 이전 확인 결과입니다."}</Notice>
            <button type="button" className={SECONDARY} disabled={busy} onClick={() => loadDevices(devices.requestedCursor)}>기기 목록 다시 시도</button></div>}
          {devices.loaded && !devices.items.length && <div className="rounded-md bg-ink-50 px-4 py-7 text-center">
            <Laptop size={26} className="mx-auto text-ink-400" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium">등록한 기기가 없습니다.</p>
            <p className="mt-1 text-sm text-ink-500">위에서 기기를 등록하고 설치를 시작하세요.</p>
          </div>}
          <div className="divide-y divide-ink-100">
            {devices.items.map(device => {
              const expired = Date.parse(device.expiresAt) <= Math.max(clock, Date.now());
              const disabled = !!device.revokedAt || expired;
              return <section key={device.id} aria-label={`${device.name} 기기`} className="py-4 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="break-all text-sm font-semibold">{device.name}</h3>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${disabled ? "bg-ink-100 text-ink-600" : "bg-brand-50 text-brand-700"}`}>
                        {device.revokedAt ? "해지됨" : expired ? "만료됨" : "등록됨"}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">{PLATFORMS[device.platform]?.label || device.platform}</p>
                  </div>
                  {!disabled && <button type="button" className={SECONDARY} aria-label={`${device.name} 해지`} disabled={busy}
                    onClick={() => { setConfirmId(device.id); setRevokeError(""); }}>
                    <Trash2 size={14} aria-hidden="true" />해지</button>}
                </div>
                <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
                  <div><dt className="text-ink-500">등록</dt><dd className="mt-1 text-ink-700"><DeviceTime value={device.createdAt} /></dd></div>
                  <div><dt className="text-ink-500">만료</dt><dd className="mt-1 text-ink-700"><DeviceTime value={device.expiresAt} /></dd></div>
                  <div><dt className="text-ink-500">최근 수신</dt><dd className="mt-1 text-ink-700">{device.lastSeenAt ? <DeviceTime value={device.lastSeenAt} /> : "수신 기록 없음"}</dd></div>
                </dl>
                {device.revokedAt && <p className="mt-2 text-xs text-ink-500">해지 시각: <DeviceTime value={device.revokedAt} /></p>}
                {device.renewedAt && <p className="mt-2 text-xs text-ink-500">자동 갱신 <DeviceTime value={device.renewedAt} /></p>}
                {confirmId === device.id && !disabled && <div role="group" aria-label={`${device.name} 해지 확인`}
                  className="mt-3 rounded-md border border-warning-border bg-warning-surface p-3">
                  <p className="text-sm text-warning-text">이 기기의 수집을 중단할까요? 다시 연결하려면 새 토큰이 필요합니다.</p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className={`${BUTTON} bg-negative text-white`} disabled={busy} onClick={() => revoke(device)}>
                      {revoking === device.id ? "해지 중..." : "해지 확인"}</button>
                    <button type="button" className={SECONDARY} disabled={revoking !== null} onClick={() => setConfirmId(null)}>취소</button>
                  </div>
                  {revokeError && <div className="mt-3"><Notice>{revokeError}</Notice></div>}
                </div>}
              </section>;
            })}
          </div>
          {devices.nextCursor && <button type="button" className={`${SECONDARY} mt-4 w-full`} disabled={busy}
            onClick={() => loadDevices(devices.nextCursor)}>{devices.loading ? "불러오는 중..." : "기기 더 보기"}</button>}
          {deviceMessage && <p role="status" className="mt-3 text-sm text-positive-text">{deviceMessage}</p>}
          <p className="mt-4 border-t border-ink-100 pt-4 text-xs leading-relaxed text-ink-500">표시 시간대: {deviceTime.resolvedOptions().timeZone}. 로그아웃해도 기기 수집은 계속됩니다. 중단하려면 기기를 해지하세요.
            최근 수신이 전체 사용량의 수집이나 집계 완료를 보장하지는 않습니다.</p>
        </Card>
      </>}
    </div>
  </div>;
}
