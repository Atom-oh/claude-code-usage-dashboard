import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Laptop, ShieldAlert, Terminal, XCircle } from "lucide-react";
import { apiGet, checkAuthentication } from "../api.js";
import { useConfig } from "../ConfigContext.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { Card, Loading } from "../components/Card.jsx";
import { COLLECTOR_PAGE } from "../clientNavigation.js";

const BUTTON = "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";
const PLATFORMS = { linux: { label: "Linux", icon: Terminal }, darwin: { label: "macOS", icon: Laptop } };
const HANDLE = /^[a-f0-9]{32}$/;
const time = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const OUTCOMES = {
  approved: { tone: "positive", icon: CheckCircle2, title: "이 기기를 연결했습니다.",
    body: "터미널로 돌아가면 설치가 이어집니다. 이 창은 닫아도 됩니다." },
  denied: { tone: "neutral", icon: XCircle, title: "연결을 거부했습니다.",
    body: "기기는 등록되지 않았습니다. 본인이 시작한 설치라면 터미널에서 설치 명령을 다시 실행하세요." },
  expired: { tone: "neutral", icon: XCircle, title: "승인 시간이 지났습니다.",
    body: "기기는 등록되지 않았습니다. 터미널에서 설치 명령을 다시 실행해 새 코드를 받으세요." },
  unavailable: { tone: "neutral", icon: ShieldAlert, title: "이미 처리된 요청입니다.",
    body: "다른 계정이 이 요청을 처리했습니다. 본인이 시작한 설치라면 터미널에서 설치 명령을 다시 실행하세요." },
  missing: { tone: "neutral", icon: ShieldAlert, title: "연결 요청을 찾을 수 없습니다.",
    body: "주소가 잘렸거나 오래된 요청입니다. 터미널에 표시된 승인 주소를 다시 열어 주세요." },
};
const DECISION_ERRORS = { 409: "unavailable", 410: "expired", 404: "missing" };

function Notice({ children }) {
  return <p role="alert" className="rounded-md border border-negative-border bg-negative-surface px-3 py-2.5 text-sm leading-relaxed text-negative-text">{children}</p>;
}

/** Browser half of collector enrollment: shows the terminal's request and decides it on explicit click only. */
export default function CollectorConnect({ handle }) {
  const { session } = useConfig();
  if (!session?.permissions?.includes("collector:manage")) return <div>
    <PageHeader title="기기 연결 승인" />
    <div className="p-4 sm:p-8"><Notice>기기를 연결할 권한이 없습니다. 수집기 설치 권한이 있는 계정으로 로그인하거나 조직 관리자에게 요청해 주세요.</Notice></div>
  </div>;
  return <ConnectRequest key={handle} handle={handle} account={session.name} />;
}

function ConnectRequest({ handle, account }) {
  const valid = HANDLE.test(handle || "");
  const [request, setRequest] = useState({ loading: valid, data: null, error: false });
  const [attempt, setAttempt] = useState(0);
  const [deciding, setDeciding] = useState(null);
  const [outcome, setOutcome] = useState(valid ? null : "missing");
  const [decisionError, setDecisionError] = useState("");
  const pending = useRef(false);
  const controllers = useRef(new Set());

  useEffect(() => () => { for (const controller of controllers.current) controller.abort(); }, []);
  useEffect(() => {
    if (!valid) return undefined;
    const controller = new AbortController();
    setRequest({ loading: true, data: null, error: false });
    apiGet(`/api/collector/enrollments/${handle}`, {}, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setRequest({ loading: false, data, error: false });
      if (data.status !== "pending") setOutcome(OUTCOMES[data.status] ? data.status : "unavailable");
    }, error => {
      if (controller.signal.aborted) return;
      if (/-> 404$/.test(error?.message || "")) { setRequest({ loading: false, data: null, error: false }); setOutcome("missing"); }
      else setRequest({ loading: false, data: null, error: true });
    });
    return () => controller.abort();
  }, [handle, valid, attempt]);

  const decide = async decision => {
    if (pending.current) return;
    pending.current = true;
    const controller = new AbortController();
    controllers.current.add(controller);
    setDeciding(decision);
    setDecisionError("");
    try {
      const response = await fetch(`/api/collector/enrollments/${handle}/${decision}`, {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      checkAuthentication(response);
      if (controller.signal.aborted) return;
      if (response.ok) { setOutcome(decision === "approve" ? "approved" : "denied"); return; }
      const body = await response.json().catch(() => ({}));
      if (body.error === "enrollment_denied") setOutcome("denied");
      else if (DECISION_ERRORS[response.status]) setOutcome(DECISION_ERRORS[response.status]);
      else setDecisionError(decision === "approve"
        ? "연결하지 못했습니다. 잠시 후 다시 눌러 주세요. 다시 눌러도 기기가 중복 등록되지 않습니다."
        : "거부를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } catch {
      if (!controller.signal.aborted) setDecisionError("요청을 보내지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.");
    } finally {
      controllers.current.delete(controller);
      pending.current = false;
      if (!controller.signal.aborted) setDeciding(null);
    }
  };

  const data = request.data;
  const platform = PLATFORMS[data?.platform];
  const PlatformIcon = platform?.icon || Laptop;
  const result = outcome && OUTCOMES[outcome];
  const ResultIcon = result?.icon;
  return <div>
    <PageHeader title="기기 연결 승인" subtitle="터미널에서 시작한 수집기 설치를 이 계정에 연결합니다." />
    <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-8">
      {request.loading && <Loading />}
      {request.error && <div className="space-y-3">
        <Notice>연결 요청을 불러오지 못했습니다. 연결과 권한을 확인한 후 다시 시도해 주세요.</Notice>
        <button type="button" className={`${BUTTON} border border-ink-200 bg-white text-ink-700 hover:bg-ink-50`}
          onClick={() => setAttempt(value => value + 1)}>다시 시도</button>
      </div>}
      {result && <section role="status" aria-label="연결 결과"
        className={`flex items-start gap-3 rounded-lg border p-4 ${result.tone === "positive" ? "border-positive-border bg-positive-surface" : "border-ink-200 bg-ink-50"}`}>
        <ResultIcon size={22} aria-hidden="true" className={`mt-0.5 shrink-0 ${result.tone === "positive" ? "text-positive-text" : "text-ink-500"}`} />
        <div><p className="font-semibold">{result.title}</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-600">{result.body}</p>
          <a href={COLLECTOR_PAGE.to} className="mt-2 inline-block text-sm font-medium text-brand-700 underline-offset-2 hover:underline">내 기기 보기</a></div>
      </section>}
      {data && !result && <Card>
        <p className="text-sm text-ink-600">터미널에 표시된 확인 코드와 같은지 확인하세요.</p>
        <p aria-label="확인 코드" className="mt-2 font-mono text-3xl font-semibold tracking-[0.2em] text-ink-900">{data.code}</p>
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
          <div><dt className="text-ink-500">기기 이름</dt><dd className="mt-1 break-all font-medium">{data.name}</dd></div>
          <div><dt className="text-ink-500">운영체제</dt>
            <dd className="mt-1 flex items-center gap-1.5 font-medium"><PlatformIcon size={15} aria-hidden="true" />{platform?.label || data.platform}</dd></div>
          <div><dt className="text-ink-500">연결할 계정</dt><dd className="mt-1 break-all font-medium">{account || "조직 사용자"}</dd></div>
          <div><dt className="text-ink-500">수집 사용자 ID</dt><dd className="mt-1 break-all font-medium">{data.userId
            || "설치 기기의 로그인 이름"}</dd></div>
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-ink-500">이미 수집기가 설치된 기기는 기존 수집 사용자 ID를 그대로 사용합니다.
          승인 기한 <time dateTime={data.expiresAt}>{time.format(new Date(data.expiresAt))}</time>.</p>
        <div className="mt-5 rounded-md border border-warning-border bg-warning-surface p-3 text-sm leading-relaxed text-warning-text">
          <p className="font-semibold">본인이 방금 터미널에서 시작한 설치만 연결하세요.</p>
          <p className="mt-1">다른 사람이 보낸 링크나 코드는 연결하지 마세요. 연결한 기기는 대시보드 조회 권한 없이 사용량 수집만 할 수 있습니다.
            수집 권한은 30일마다 만료되지만 수집기가 동작하는 동안 자동으로 갱신되며, '내 기기'에서 해지해야 끝납니다.</p>
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button type="button" className={`${BUTTON} flex-1 bg-brand-600 text-white hover:bg-brand-700`} disabled={deciding !== null}
            onClick={() => decide("approve")}>{deciding === "approve" ? "연결 중..." : "이 기기 연결"}</button>
          <button type="button" className={`${BUTTON} border border-ink-200 bg-white text-ink-700 hover:bg-ink-50`} disabled={deciding !== null}
            onClick={() => decide("deny")}>{deciding === "deny" ? "거부 중..." : "거부"}</button>
        </div>
        {decisionError && <div className="mt-3"><Notice>{decisionError}</Notice></div>}
      </Card>}
    </div>
  </div>;
}
