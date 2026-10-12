import { useEffect, useState } from "react";
import { RefreshCw, CheckCircle2, AlertCircle, CircleHelp } from "lucide-react";
import { apiGet } from "../api.js";
import { useConfig } from "../ConfigContext.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { Card, Loading } from "../components/Card.jsx";
import { CLIENT_LABELS } from "../ClientContext.jsx";
import { formatClientTimestamp } from "../clientPresentation.js";

const LABELS = {
  reachable: "연결됨", confirmed: "확인됨", receiving: "최근 수신 확인",
  oidc_configured: "조직 SSO 설정됨", shared_credential: "공유 인증 사용 중",
  development_bypass: "로컬 개발 인증 우회", unavailable: "확인 불가",
  not_readonly: "읽기 전용 아님", legacy: "이전 카운터 키 관측",
  unconfirmed: "사용 가능 여부 미확인", not_applicable: "선택한 클라이언트에 해당 없음",
  empty: "최근 7일 수신 없음", stale: "수신 지연",
};
const GOOD = new Set(["reachable", "confirmed", "receiving", "oidc_configured", "not_applicable"]);
const UNKNOWN = new Set(["unavailable", "unconfirmed"]);

function Status({ state }) {
  const good = GOOD.has(state);
  const unknown = UNKNOWN.has(state);
  const Icon = good ? CheckCircle2 : unknown ? CircleHelp : AlertCircle;
  return <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${good
    ? "bg-emerald-50 text-emerald-800" : unknown ? "bg-ink-100 text-ink-700" : "bg-amber-50 text-amber-900"}`}>
    <Icon size={14} aria-hidden="true" />{LABELS[state] || "확인 불가"}
  </span>;
}

function Check({ label, state, children }) {
  return <div className="border-b border-ink-100 py-3 last:border-0">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{label}</h3><Status state={state} /></div>
    {children && <p className="mt-2 text-sm leading-relaxed text-ink-600">{children}</p>}
  </div>;
}

export default function Installation() {
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
  if (!allowed) return <div className="p-8"><h1 className="text-xl font-semibold">설치 상태</h1>
    <p role="alert" className="mt-3 text-sm text-ink-600">조직 관리자만 설치 상태를 확인할 수 있습니다.</p></div>;
  const data = state.data;
  return <div>
    <PageHeader title="설치 상태" subtitle="조직 로그인과 데이터 연결을 확인하고 수집을 시작하세요."
      right={<button type="button" disabled={state.loading} onClick={() => setAttempt(value => value + 1)}
        className="inline-flex items-center gap-2 rounded-md border border-ink-200 bg-white px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">
        <RefreshCw size={15} aria-hidden="true" />상태 새로고침</button>} />
    <div className="space-y-6 p-4 sm:p-8">
      {state.loading && !data && <Loading />}
      {state.error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        설치 상태를 불러오지 못했습니다. 연결·관리자 권한을 확인한 후 새로고침해 주세요.
        {data && " 아래 내용은 이전 확인 결과입니다."}</p>}
      {data && <>
        <div className="rounded-lg border border-ink-200 bg-white p-4">
          <p className="font-medium">{data.state === "operational" ? "현재 연결·수신 상태가 확인되었습니다." : "설정 또는 수집 상태를 확인해 주세요."}</p>
          <p className="mt-2 text-sm text-ink-600">확인 시각: {formatClientTimestamp(data.checkedAt)} · 버전 {data.release?.version || "—"}
            {data.release?.revision ? ` · ${data.release.revision.slice(0, 12)}` : " · 릴리스 식별자 미확인"}</p>
          <p className="mt-2 text-xs text-ink-600">수신 여부가 전체 사용량 수집을 보장하지 않습니다. MFA·실제 스키마 적용·백업 복구는 별도로 검증해야 합니다.</p>
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="조직 로그인·데이터 연결">
            <Check label="인증 방식" state={data.authentication?.state}>조직 SSO의 그룹·초대·MFA 정책은 조직의 인증 제공자에서 관리합니다.</Check>
            <Check label="ClickHouse 연결" state={data.database?.state}>데이터를 조회할 수 있도록 연결·읽기 계정 설정을 확인하세요.</Check>
            <Check label="읽기 전용 계정" state={data.database?.readonly}>읽기 전용 여부가 확인되지 않으면 SQL 채팅은 비활성화됩니다.
              {data.database?.readonlyCheckedAt && ` 검증 시각: ${formatClientTimestamp(data.database.readonlyCheckedAt)}.`}</Check>
          </Card>
          <Card title="클라이언트 수집 상태">
            {(data.clients || []).map(client => <Check key={client.client} label={CLIENT_LABELS[client.client] || client.client} state={client.state}>
              {client.latest ? `마지막 수신: ${formatClientTimestamp(client.latest)}.`
                : client.state === "empty" ? "설정된 수집기로 클라이언트를 연결하고 새 세션을 시작해 주세요."
                  : "접속·권한·클라이언트 설정을 확인하세요. 확인 불가를 사용량 0으로 해석할 수 없습니다."}
            </Check>)}
            <p className="mt-3 text-xs text-ink-600">선택한 클라이언트만 표시합니다. 최근 7일의 수신과 {data.staleAfterMinutes}분 기준이며, 완전한 토큰·비용 집계를 검증하지 않습니다.</p>
          </Card>
          <Card title="스키마 확인">
            <Check label="Claude 카운터 식별자" state={data.schema?.counterIdentity}>이전 키가 관측되면 마이그레이션·롤업 재구축 절차를 관리자와 확인하세요.</Check>
            <Check label="프로젝트 필드" state={data.schema?.projectFields}>선택적 프로젝트 필터는 필드가 확인될 때 사용할 수 있습니다.</Check>
            <p className="mt-3 text-sm text-ink-600">마이그레이션 이력: {Array.isArray(data.schema?.migrations)
              ? data.schema.migrations.length ? data.schema.migrations.join(", ") : "이력 없음" : "확인 불가"}.
              {" "}이력만으로 실제 DDL·데이터 재구축 완료를 판단할 수 없습니다.</p>
          </Card>
          <Card title="수집 시작">
            <ol className="ml-4 list-decimal space-y-3 text-sm leading-relaxed text-ink-700">
              <li>조직 관리자가 승인된 계정과 데이터 접근 범위를 확인합니다.</li>
              <li>조직의 설치 안내에 따라 Collector와 선택한 클라이언트의 텔레메트리를 설정합니다. 수집 인증값은 비밀 관리 도구로 전달합니다.</li>
              <li>새 Claude Code 또는 Codex 세션에서 요청을 실행한 뒤 수신 상태를 새로고침합니다.</li>
              <li>Overview에서 기간·모델·비용 기준과 미확인·부분합 표시를 확인합니다.</li>
            </ol>
          </Card>
        </div>
      </>}
    </div>
  </div>;
}
