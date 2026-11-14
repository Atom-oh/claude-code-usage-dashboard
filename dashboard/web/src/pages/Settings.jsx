import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, checkAuthentication } from "../api.js";
import { useConfig } from "../ConfigContext.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { Card, Loading } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { setTeamMask } from "../fmt.js";

const BUTTON = "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";
const PRIMARY = `${BUTTON} bg-brand-600 text-white hover:bg-brand-700`;
const SECONDARY = `${BUTTON} border border-ink-200 bg-white text-ink-700 hover:bg-ink-50`;
const dateTime = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const dateOnly = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });

const UNAVAILABLE = {
  basic_auth: "팀 매핑은 조직 SSO(OIDC) 로그인에서만 사용할 수 있습니다.",
  not_cognito: "현재 로그인 제공자가 Cognito 사용자 풀이 아니어서 팀 매핑을 사용할 수 없습니다.",
  ingest_disabled: "기기 수집 저장소가 설정되지 않아 팀 매핑을 사용할 수 없습니다.",
};
const SAVE_ERRORS = {
  invalid_attribute: "선택한 속성을 사용할 수 없습니다. 다른 속성을 선택해 주세요.",
  duplicate_label: "서로 다른 값에 같은 표시 이름을 쓸 수 없습니다.",
  invalid_labels: "표시 이름은 1~80자여야 하고, 값이 너무 긴 항목에는 이름을 붙일 수 없습니다.",
  directory_unavailable: "사용자 디렉터리에 연결할 수 없어 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  store_unavailable: "설정 저장소를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
};

function formatTime(value, formatter = dateTime) {
  if (value == null) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatter.format(date) : "—";
}

function Notice({ tone = "negative", children, role = "alert" }) {
  const styles = tone === "warning"
    ? "border-warning-border bg-warning-surface text-warning-text"
    : "border-negative-border bg-negative-surface text-negative-text";
  return <p role={role} className={`rounded-md border px-3 py-2.5 text-sm leading-relaxed ${styles}`}>{children}</p>;
}

export default function Settings() {
  const { session } = useConfig();
  if (!session?.permissions?.includes("settings:manage")) return <div>
    <PageHeader title="설정" />
    <div className="p-4 sm:p-8"><Notice>팀 매핑 설정 권한이 없습니다. 조직 관리자에게 권한을 요청해 주세요.</Notice></div>
  </div>;
  return <TeamMapping />;
}

const MASK_CHOICES = [
  { value: "default", label: "배포 설정 따름" },
  { value: "on", label: "켜기" },
  { value: "off", label: "끄기" },
];
const choiceOf = override => (override === true ? "on" : override === false ? "off" : "default");
const overrideOf = choice => (choice === "on" ? true : choice === "off" ? false : null);
const onOff = value => (value ? "켜짐" : "꺼짐");

// Team-name masking for shared screens such as public demos: the deployment chooses the default,
// an administrator may override it. Screens and CSV only; API responses keep raw values.
function TeamMasking() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ loading: true, data: null, error: false });
  const [choice, setChoice] = useState("default");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ tone: null, text: "" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, data: null, error: false });
    apiGet("/api/settings/display", {}, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (!data?.teamMask) throw new Error("invalid display settings");
      setState({ loading: false, data, error: false });
      setChoice(choiceOf(data.teamMask.override));
    }).catch(() => {
      if (!controller.signal.aborted) setState({ loading: false, data: null, error: true });
    });
    return () => controller.abort();
  }, [attempt]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setMessage({ tone: null, text: "" });
    try {
      const response = await fetch("/api/settings/display", {
        method: "PUT", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamMask: overrideOf(choice), version: state.data.version }),
      });
      checkAuthentication(response);
      if (response.ok) {
        const next = await response.json();
        setState({ loading: false, data: next, error: false });
        setTeamMask(next.teamMask.effective);
        setMessage({ tone: "positive", text: "저장했습니다. 이 화면에는 바로, 다른 사용자에게는 새로 고침 후(최대 30초) 적용됩니다." });
        return;
      }
      const code = (await response.json().catch(() => ({}))).error;
      setMessage({ tone: "negative", text: code === "version_conflict"
        ? "다른 곳에서 설정이 먼저 바뀌었습니다. 최신 설정을 불러온 뒤 다시 저장해 주세요."
        : "저장하지 못했습니다. 잠시 후 다시 시도해 주세요." });
      if (code === "version_conflict") setAttempt(n => n + 1);
    } catch {
      setMessage({ tone: "negative", text: "저장하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요." });
    } finally {
      setSaving(false);
    }
  };

  const data = state.data;
  return <Card title="팀 이름 마스킹" subtitle="여러 사람이 보는 화면(데모 등)에서 팀 이름을 앞 두 글자와 짧은 식별값으로 가립니다. 화면과 CSV 표시만 바꾸며 API 응답은 그대로입니다. 표시 이름을 붙인 팀은 그 이름을 그대로 보여 줍니다.">
    {state.loading ? <Loading /> : state.error ? <div className="space-y-3">
      <Notice>팀 이름 마스킹 설정을 불러오지 못했습니다.</Notice>
      <button type="button" className={SECONDARY} onClick={() => setAttempt(n => n + 1)}>다시 시도</button>
    </div> : <div className="space-y-3">
      <p className="text-sm text-ink-700">현재 적용: <strong>{onOff(data.teamMask.effective)}</strong>
        <span className="text-ink-500"> · 배포 설정: {onOff(data.teamMask.deployment)}</span></p>
      {data.available ? <>
        <fieldset className="space-y-2">
          <legend className="sr-only">팀 이름 마스킹</legend>
          {MASK_CHOICES.map(option => <label key={option.value} className="flex items-center gap-2 text-sm text-ink-800">
            <input type="radio" name="team-mask" value={option.value} checked={choice === option.value}
              onChange={() => { setChoice(option.value); setMessage({ tone: null, text: "" }); }} />
            <span>{option.value === "default" ? `${option.label} (${onOff(data.teamMask.deployment)})` : option.label}</span>
          </label>)}
        </fieldset>
        {message.text && (message.tone === "positive"
          ? <p role="status" className="text-sm text-positive-text">{message.text}</p> : <Notice>{message.text}</Notice>)}
        <button type="button" className={PRIMARY} disabled={saving || choice === choiceOf(data.teamMask.override)}
          onClick={save}>{saving ? "저장 중..." : "마스킹 설정 저장"}</button>
      </> : <Notice tone="warning" role="status">설정 저장소가 없어 배포 설정을 따릅니다. 배포 시 TEAM_MASK_ENABLED(Terraform team_mask_enabled)로 바꿀 수 있습니다.</Notice>}
    </div>}
  </Card>;
}

function TeamMapping() {
  const [attempt, setAttempt] = useState(0);
  const [settings, setSettings] = useState({ loading: true, data: null, error: false });
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState({ loading: false, data: null, error: false });
  const [labels, setLabels] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const previewController = useRef(null);
  const savePending = useRef(false);

  const loadPreview = useCallback((attribute, savedLabels) => {
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    setPreview({ loading: true, data: null, error: false });
    apiGet("/api/settings/teams/preview", { attribute }, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setPreview({ loading: false, data, error: false });
      setLabels(Object.fromEntries(data.values.filter(row => Object.hasOwn(savedLabels, row.value))
        .map(row => [row.value, savedLabels[row.value]])));
    }, () => {
      if (!controller.signal.aborted) setPreview({ loading: false, data: null, error: true });
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSettings({ loading: true, data: null, error: false });
    setConflict(false);
    apiGet("/api/settings/teams", {}, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setSettings({ loading: false, data, error: false });
      setSelected(data.current);
      if (data.available && data.options && data.current) loadPreview(data.current, data.labels);
    }, () => {
      if (!controller.signal.aborted) setSettings({ loading: false, data: null, error: true });
    });
    return () => controller.abort();
  }, [attempt, loadPreview]);
  useEffect(() => () => previewController.current?.abort(), []);

  const data = settings.data;
  const choose = attribute => {
    if (attribute === selected) return;
    setSelected(attribute);
    setSaved(false);
    setSaveError("");
    // Labels are keyed by raw value, so stored names prefill any attribute's matching values.
    loadPreview(attribute, data.labels);
  };

  const save = async () => {
    if (savePending.current || !selected || !preview.data) return;
    savePending.current = true;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      // PUT replaces the whole map: keep stored names for values outside this preview, let rows override or clear theirs.
      const merged = new Map(Object.entries(data.labels));
      for (const row of preview.data.values) {
        const label = (labels[row.value] ?? "").trim();
        if (label) merged.set(row.value, label); else merged.delete(row.value);
      }
      const body = { attribute: selected, version: data.version, labels: Object.fromEntries(merged) };
      const response = await fetch("/api/settings/teams", {
        method: "PUT", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      checkAuthentication(response);
      if (response.ok) {
        const next = await response.json();
        setSettings({ loading: false, data: next, error: false });
        setSaved(true);
        return;
      }
      const code = (await response.json().catch(() => ({}))).error;
      if (code === "version_conflict") setConflict(true);
      else setSaveError(SAVE_ERRORS[code] ?? "저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } catch {
      setSaveError("저장하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.");
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };

  let body;
  if (settings.loading) body = <Loading />;
  else if (settings.error) body = <div className="space-y-3">
    <Notice>팀 매핑 설정을 불러오지 못했습니다.</Notice>
    <button type="button" className={SECONDARY} onClick={() => setAttempt(n => n + 1)}>다시 시도</button>
  </div>;
  else if (!data.available) body = <Notice tone="warning" role="status">{UNAVAILABLE[data.reason] ?? "팀 매핑을 사용할 수 없습니다."}</Notice>;
  else {
    const { status, options } = data;
    const columns = [
      { key: "value", label: "값" },
      { key: "users", label: "사용자 수" },
      { key: "label", label: "표시 이름", render: (_, row) => <input type="text" maxLength={80}
        aria-label={`${row.value} 표시 이름`} placeholder={row.value} value={labels[row.value] ?? ""}
        className="w-full min-w-40 rounded-md border border-ink-200 px-2 py-1 text-sm"
        onChange={event => { setSaved(false); setLabels(previous => ({ ...previous, [row.value]: event.target.value })); }} /> },
    ];
    body = <div className="space-y-6">
      <Card title="디렉터리 상태">
        {status ? <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-ink-500">사용자 풀</dt><dd className="break-all font-medium text-ink-800">{data.poolId}</dd></div>
          <div><dt className="text-ink-500">마지막 동기화</dt><dd className="font-medium text-ink-800">{formatTime(status.lastSync)}</dd></div>
          <div><dt className="text-ink-500">사용자 수</dt><dd className="font-medium text-ink-800">{status.users}</dd></div>
          <div><dt className="text-ink-500">이력 시작일</dt><dd className="font-medium text-ink-800">{formatTime(status.historyStart, dateOnly)}</dd></div>
        </dl> : <p className="text-sm text-ink-500">동기화 상태를 확인할 수 없습니다.</p>}
        {status?.stale && <div className="mt-4"><Notice tone="warning" role="status">디렉터리 동기화가 오래되었습니다. 팀 정보가 최신이 아닐 수 있습니다.</Notice></div>}
        {status?.reason === "directory_too_large" && <div className="mt-4"><Notice tone="warning" role="status">디렉터리 이력 항목이 너무 많아 디렉터리 기반 팀 적용을 일시 중단했습니다.</Notice></div>}
        {status?.lastError && <div className="mt-4"><Notice tone="warning" role="status">디렉터리 또는 저장소 동기화에 실패했습니다. 마지막으로 성공한 데이터를 유지합니다.</Notice></div>}
        {data.directoryError && <div className="mt-4"><Notice tone="warning" role="status">사용자 디렉터리에 일시적으로 연결할 수 없어 속성을 바꿀 수 없습니다. 저장된 설정은 그대로 표시합니다.</Notice></div>}
      </Card>

      <Card title="팀 기준 속성" subtitle="사용자 풀의 속성 하나를 팀으로 사용합니다.">
        {options ? <fieldset className="space-y-2">
          <legend className="sr-only">팀 기준 속성</legend>
          {options.map(option => <label key={option} className="flex items-center gap-2 text-sm text-ink-800">
            <input type="radio" name="team-attribute" value={option} checked={selected === option} onChange={() => choose(option)} />
            <span>{option}</span>
            {option === data.current && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">현재</span>}
          </label>)}
        </fieldset> : <p className="text-sm text-ink-500">현재 기준: {data.current ?? "설정 안 됨"}</p>}
      </Card>

      {options && selected && <>
        {preview.loading && <Loading />}
        {preview.error && <Notice>미리보기를 불러오지 못했습니다.</Notice>}
        {preview.data && <>
          <DataTable title="값별 사용자와 표시 이름" columns={columns} rows={preview.data.values} groupKey="" />
          <div className="space-y-1 text-sm text-ink-600">
            <p>값 없음: <strong>{preview.data.missing}</strong>명 — 이 속성에 값이 없는 사용자입니다.</p>
            <p>제외: <strong>{preview.data.excluded}</strong>명 — 이메일이 없거나 여러 계정이 같은 이메일을 쓰는 사용자입니다.</p>
          </div>
        </>}
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-ink-500">{data.current == null
            ? "첫 저장 시 지금 디렉터리 값이 이전 사용량 전체에도 적용됩니다. 이후 기준을 바꾸면 저장한 시점부터 적용됩니다."
            : "저장하면 이 기준이 지금부터 적용됩니다. 이전 사용량의 팀은 바뀌지 않습니다."}</p>
          {conflict && <Notice>다른 곳에서 설정이 먼저 바뀌었습니다. 최신 설정을 불러온 뒤 다시 저장해 주세요.
            <button type="button" className={`${SECONDARY} ml-3`} onClick={() => { setSaved(false); setAttempt(n => n + 1); }}>최신 설정 불러오기</button></Notice>}
          {saveError && <Notice>{saveError}</Notice>}
          {saved && <p role="status" className="text-sm text-positive-text">저장했습니다. 다음 동기화부터 적용됩니다.</p>}
          <button type="button" className={PRIMARY} disabled={saving || conflict || !preview.data} onClick={save}>{saving ? "저장 중..." : "저장"}</button>
        </div>
      </>}
    </div>;
  }

  return <div>
    <PageHeader title="설정" subtitle="팀 이름 표시와 Cognito 사용자 속성 기반 팀 매핑을 설정합니다." />
    <div className="space-y-6 p-4 sm:p-8"><TeamMasking />{body}</div>
  </div>;
}
