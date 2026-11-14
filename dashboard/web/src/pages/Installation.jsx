import { richMessage, localize, translate, useLocale } from "../i18n/index.js";
import { useEffect, useState } from "react";
import { RefreshCw, CheckCircle2, AlertCircle, CircleHelp } from "lucide-react";
import { apiGet } from "../api.js";
import { useConfig } from "../ConfigContext.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { Card, Loading } from "../components/Card.jsx";
import { CLIENT_LABELS } from "../ClientContext.jsx";
import { formatClientTimestamp } from "../clientPresentation.js";

const LABELS = localize({
  reachable: "연결됨", confirmed: "확인됨", receiving: "최근 수신 확인",
  oidc_configured: "조직 SSO 설정됨", shared_credential: "공유 인증 사용 중",
  development_bypass: "로컬 개발 인증 우회", unavailable: "확인 불가",
  not_readonly: "읽기 전용 아님", legacy: "이전 카운터 키 관측",
  unconfirmed: "사용 가능 여부 미확인", not_applicable: "선택한 클라이언트에 해당 없음",
  empty: "최근 7일 수신 없음", stale: "수신 지연",
});
const GOOD = new Set(["reachable", "confirmed", "receiving", "oidc_configured", "not_applicable"]);
const UNKNOWN = new Set(["unavailable", "unconfirmed"]);

function Status({ state }) {
  const _locale = useLocale();
  const good = GOOD.has(state);
  const unknown = UNKNOWN.has(state);
  const Icon = good ? CheckCircle2 : unknown ? CircleHelp : AlertCircle;
  return <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${good
    ? "bg-emerald-50 text-emerald-800" : unknown ? "bg-ink-100 text-ink-700" : "bg-amber-50 text-amber-900"}`}>
    <Icon size={14} aria-hidden="true" />{LABELS[state] || translate("m298859a04696")}
  </span>;
}

function Check({ label, state, children }) {
  const _locale = useLocale();
  return <div className="border-b border-ink-100 py-3 last:border-0">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{label}</h3><Status state={state} /></div>
    {children && <p className="mt-2 text-sm leading-relaxed text-ink-600">{children}</p>}
  </div>;
}

export default function Installation() {
  const _locale = useLocale();
  const { session } = useConfig();
  const allowed = session?.permissions?.includes("installation:read");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    if (!allowed) return;
    const abort = new AbortController();
    setState(previous => ({ ...previous, loading: true, error: null }));
    apiGet("/api/installation", {}, abort.signal).then(data => {
      if (!abort.signal.aborted) setState({ data, loading: false, error: null });
    }, error => {
      if (!abort.signal.aborted) setState(previous => ({ ...previous, loading: false, error }));
    });
    return () => abort.abort();
  }, [allowed, attempt]);
  if (!allowed) return <div className="p-8"><h1 className="text-xl font-semibold">{translate("m3f34928ff1d0")}</h1>
    <p role="alert" className="mt-3 text-sm text-ink-600">{translate("m0e3ecae3bb22")}</p></div>;
  const data = state.data;
  return <div>
    <PageHeader title={translate("m3f34928ff1d0")} subtitle={translate("m1bae0df52a69")}
      right={<button type="button" disabled={state.loading} onClick={() => setAttempt(value => value + 1)}
        className="inline-flex items-center gap-2 rounded-md border border-ink-200 bg-white px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">{richMessage("me0e65951c8f4", [<RefreshCw size={15} aria-hidden="true" />])}</button>} />
    <div className="space-y-6 p-4 sm:p-8">
      {state.loading && !data && <Loading />}
      {state.error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">{richMessage("m8795dd5106b4", [data && translate("md6dd6128067f")])}</p>}
      {data && <>
        <div className="rounded-lg border border-ink-200 bg-white p-4">
          <p className="font-medium">{data.state === "operational" ? translate("m7bc5ed213f9a") : translate("m4efdc38e9b8a")}</p>
          <p className="mt-2 text-sm text-ink-600">{richMessage("m3f9cc0dfc69d", [formatClientTimestamp(data.checkedAt), data.release?.version || "—", data.release?.revision ? ` · ${data.release.revision.slice(0, 12)}` : translate("m0b2e34645a60")])}</p>
          <p className="mt-2 text-xs text-ink-600">{translate("mf6d40279f19e")}</p>
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title={<h2>{translate("mcde6a9268c2a")}</h2>}>
            <Check label={translate("m421d875af642")} state={data.authentication?.state}>{translate("mdb41b5ea855d")}</Check>
            <Check label={translate("mffecb24540c3")} state={data.database?.state}>{translate("m6d5edaedf85f")}</Check>
            <Check label={translate("m022f3cf7e42d")} state={data.database?.readonly}>{translate("m8af24323fd42")}{data.database?.readonlyCheckedAt && translate("m45ba24147422", [formatClientTimestamp(data.database.readonlyCheckedAt)])}</Check>
          </Card>
          <Card title={<h2>{translate("mec7959b2e879")}</h2>}>
            {(data.clients || []).map(client => <Check key={client.client} label={CLIENT_LABELS[client.client] || client.client} state={client.state}>
              {client.latest ? translate("m30a245727fc9", [formatClientTimestamp(client.latest)])
                : client.state === "empty" ? translate("m3a632f40d3de")
                  : translate("m1bcd46f0bcb6")}
            </Check>)}
            <p className="mt-3 text-xs text-ink-600">{richMessage("mffe7d2920aea", [data.staleAfterMinutes])}</p>
          </Card>
          <Card title={<h2>{translate("m872e331271ab")}</h2>}>
            <Check label={translate("m36c0ccae1515")} state={data.schema?.counterIdentity}>{translate("m16f53def3b12")}</Check>
            <Check label={translate("m90ac695e6228")} state={data.schema?.projectFields}>{translate("mb5fb974159a8")}</Check>
            <p className="mt-3 text-sm text-ink-600">{richMessage("ma50d379931bf", [Array.isArray(data.schema?.migrations)
              ? data.schema.migrations.length ? data.schema.migrations.join(", ") : translate("m44492017ff6a") : translate("m298859a04696")])}</p>
          </Card>
          <Card title={<h2>{translate("m2a077c37df27")}</h2>}>
            <ol className="ml-4 list-decimal space-y-3 text-sm leading-relaxed text-ink-700">
              <li>{translate("md6db10b38da0")}</li>
              <li>{translate("m6ac6086033b0")}</li>
              <li>{translate("m6481e30b4913")}</li>
              <li>{translate("mccb05714e11f")}</li>
            </ol>
          </Card>
        </div>
      </>}
    </div>
  </div>;
}
