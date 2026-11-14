import { localizedFormat, localizedMessage, messageText, translate, useLocale } from "../i18n/index.js";
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
const time = localizedFormat("DateTimeFormat", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const OUTCOMES = {
  approved: { tone: "positive", icon: CheckCircle2, title: localizedMessage("m4255231225e0"),
    body: localizedMessage("meb72dff507fa") },
  denied: { tone: "neutral", icon: XCircle, title: localizedMessage("m931f638e7cf4"),
    body: localizedMessage("m4028871ca349") },
  expired: { tone: "neutral", icon: XCircle, title: localizedMessage("m8a0405ac674a"),
    body: localizedMessage("m6d552e111029") },
  unavailable: { tone: "neutral", icon: ShieldAlert, title: localizedMessage("me7fd0c8c21d6"),
    body: localizedMessage("md2ee656f6c89") },
  missing: { tone: "neutral", icon: ShieldAlert, title: localizedMessage("m405ea0e9b706"),
    body: localizedMessage("md5fd17871d71") },
};
const DECISION_ERRORS = { 409: "unavailable", 410: "expired", 404: "missing" };

function Notice({ children }) {
  return <p role="alert" className="rounded-md border border-negative-border bg-negative-surface px-3 py-2.5 text-sm leading-relaxed text-negative-text">{children}</p>;
}

/** Browser half of collector enrollment: shows the terminal's request and decides it on explicit click only. */
export default function CollectorConnect({ handle }) {
  const _locale = useLocale();
  const { session } = useConfig();
  if (!session?.permissions?.includes("collector:manage")) return <div>
    <PageHeader title={translate("m6764097b8122")} />
    <div className="p-4 sm:p-8"><Notice>{translate("m2a09af43bf3b")}</Notice></div>
  </div>;
  return <ConnectRequest key={handle} handle={handle} account={session.name} />;
}

function ConnectRequest({ handle, account }) {
  const _locale = useLocale();
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
      else setDecisionError(localizedMessage(decision === "approve" ? "m03668fb71235" : "m3a8532ca84a5"));
    } catch {
      if (!controller.signal.aborted) setDecisionError(localizedMessage("m4885ee938ad3"));
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
    <PageHeader title={translate("m6764097b8122")} subtitle={translate("mf7bffc9d0bd5")} />
    <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-8">
      {request.loading && <Loading />}
      {request.error && <div className="space-y-3">
        <Notice>{translate("m585859f953e1")}</Notice>
        <button type="button" className={`${BUTTON} border border-ink-200 bg-white text-ink-700 hover:bg-ink-50`}
          onClick={() => setAttempt(value => value + 1)}>{translate("m196856a662bd")}</button>
      </div>}
      {result && <section role="status" aria-label={translate("m0f1e7c513a3f")}
        className={`flex items-start gap-3 rounded-lg border p-4 ${result.tone === "positive" ? "border-positive-border bg-positive-surface" : "border-ink-200 bg-ink-50"}`}>
        <ResultIcon size={22} aria-hidden="true" className={`mt-0.5 shrink-0 ${result.tone === "positive" ? "text-positive-text" : "text-ink-500"}`} />
        <div><p className="font-semibold">{messageText(result.title)}</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-600">{messageText(result.body)}</p>
          <a href={COLLECTOR_PAGE.to} className="mt-2 inline-block text-sm font-medium text-brand-700 underline-offset-2 hover:underline">{translate("m68e9a68adb30")}</a></div>
      </section>}
      {data && !result && <Card>
        <p className="text-sm text-ink-600">{translate("m94461a51dc58")}</p>
        <p aria-label={translate("m638e824e0adb")} className="mt-2 font-mono text-3xl font-semibold tracking-[0.2em] text-ink-900">{data.code}</p>
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
          <div><dt className="text-ink-500">{translate("m2834016a200a")}</dt><dd className="mt-1 break-all font-medium">{data.name}</dd></div>
          <div><dt className="text-ink-500">{translate("m8143161f55aa")}</dt>
            <dd className="mt-1 flex items-center gap-1.5 font-medium"><PlatformIcon size={15} aria-hidden="true" />{platform?.label || data.platform}</dd></div>
          <div><dt className="text-ink-500">{translate("m6db0ca070b91")}</dt><dd className="mt-1 break-all font-medium">{account || translate("m6d6d656f264c")}</dd></div>
          <div><dt className="text-ink-500">{translate("me7bcfd8c0da5")}</dt><dd className="mt-1 break-all font-medium">{data.userId
            || translate("m4cc5d017e93f")}</dd></div>
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-ink-500">{translate("m4aedc6c8a845")}
          {data.createdAt && <> {translate("mb086ba78e90e")} <time dateTime={data.createdAt}>{time.format(new Date(data.createdAt))}</time> ·</>}
          {" "}{translate("m27163bc7d640")} <time dateTime={data.expiresAt}>{time.format(new Date(data.expiresAt))}</time>.{" "}
          {translate("m3ecfd87791c6")}</p>
        <div className="mt-5 rounded-md border border-warning-border bg-warning-surface p-3 text-sm leading-relaxed text-warning-text">
          <p className="font-semibold">{translate("mc9f3a984874b")}</p>
          <p className="mt-1">{translate("mf9350292b2b3")}</p>
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button type="button" className={`${BUTTON} flex-1 bg-brand-600 text-white hover:bg-brand-700`} disabled={deciding !== null}
            onClick={() => decide("approve")}>{deciding === "approve" ? translate("m8a7ae84a7a05") : translate("m97f3259ce64e")}</button>
          <button type="button" className={`${BUTTON} border border-ink-200 bg-white text-ink-700 hover:bg-ink-50`} disabled={deciding !== null}
            onClick={() => decide("deny")}>{deciding === "deny" ? translate("m877746feea04") : translate("me3ecc00b93af")}</button>
        </div>
        {decisionError && <div className="mt-3"><Notice>{messageText(decisionError)}</Notice></div>}
      </Card>}
    </div>
  </div>;
}
