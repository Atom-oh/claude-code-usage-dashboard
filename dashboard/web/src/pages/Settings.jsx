import { richMessage, localizedFormat, translate, useLocale } from "../i18n/index.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, checkAuthentication } from "../api.js";
import { useConfig } from "../ConfigContext.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { Card, Loading } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";

const BUTTON = "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";
const PRIMARY = `${BUTTON} bg-brand-600 text-white hover:bg-brand-700`;
const SECONDARY = `${BUTTON} border border-ink-200 bg-white text-ink-700 hover:bg-ink-50`;
const dateTime = localizedFormat("DateTimeFormat", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const dateOnly = localizedFormat("DateTimeFormat", { year: "numeric", month: "2-digit", day: "2-digit" });

const UNAVAILABLE = {
  basic_auth: "m6c9f98d45131",
  not_cognito: "mccfae6fc377c",
  ingest_disabled: "m3256c952c3a2",
};
const SAVE_ERRORS = {
  invalid_attribute: "mcc75da3889bd",
  duplicate_label: "mde7e132c2622",
  invalid_labels: "mb0274d6fd29d",
  directory_unavailable: "mee1be3227c78",
  store_unavailable: "m24f0226619cb",
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
  useLocale();
  const { session } = useConfig();
  if (!session?.permissions?.includes("settings:manage")) return <div>
    <PageHeader title={translate("m115bced49291")} />
    <div className="p-4 sm:p-8"><Notice>{translate("m865d52f9da0b")}</Notice></div>
  </div>;
  return <TeamMapping />;
}

function TeamMapping() {
  useLocale();
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
      else setSaveError(SAVE_ERRORS[code] ?? "m0ee453b5794b");
    } catch {
      setSaveError("m83ebb5d0dc9a");
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };

  let body;
  if (settings.loading) body = <Loading />;
  else if (settings.error) body = <div className="space-y-3">
    <Notice>{translate("mc442cebc7e44")}</Notice>
    <button type="button" className={SECONDARY} onClick={() => setAttempt(n => n + 1)}>{translate("m196856a662bd")}</button>
  </div>;
  else if (!data.available) body = <Notice tone="warning" role="status">{translate(UNAVAILABLE[data.reason] ?? "m555fb7461e98")}</Notice>;
  else {
    const { status, options } = data;
    const columns = [
      { key: "value", label: translate("mb19ddf94b4c9") },
      { key: "users", label: translate("mda6baf39d0db") },
      { key: "label", label: translate("mbe0cd9bd9b6d"), render: (_, row) => <input type="text" maxLength={80}
        aria-label={translate("m102db82683f0", [row.value])} placeholder={row.value} value={labels[row.value] ?? ""}
        className="w-full min-w-40 rounded-md border border-ink-200 px-2 py-1 text-sm"
        onChange={event => { setSaved(false); setLabels(previous => ({ ...previous, [row.value]: event.target.value })); }} /> },
    ];
    body = <div className="space-y-6">
      <Card title={translate("m3bea8a89ae15")}>
        {status ? <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-ink-500">{translate("m6316e2c8d172")}</dt><dd className="break-all font-medium text-ink-800">{data.poolId}</dd></div>
          <div><dt className="text-ink-500">{translate("m18881e245dff")}</dt><dd className="font-medium text-ink-800">{formatTime(status.lastSync)}</dd></div>
          <div><dt className="text-ink-500">{translate("mda6baf39d0db")}</dt><dd className="font-medium text-ink-800">{status.users}</dd></div>
          <div><dt className="text-ink-500">{translate("m2f178e290973")}</dt><dd className="font-medium text-ink-800">{formatTime(status.historyStart, dateOnly)}</dd></div>
        </dl> : <p className="text-sm text-ink-500">{translate("m074cf57c8c5d")}</p>}
        {status?.stale && <div className="mt-4"><Notice tone="warning" role="status">{translate("m36ac48a27925")}</Notice></div>}
        {status?.reason === "directory_too_large" && <div className="mt-4"><Notice tone="warning" role="status">{translate("mbcd902decf7c")}</Notice></div>}
        {status?.lastError && <div className="mt-4"><Notice tone="warning" role="status">{translate("mc7523b7f9689")}</Notice></div>}
        {data.directoryError && <div className="mt-4"><Notice tone="warning" role="status">{translate("m00bb702d1cab")}</Notice></div>}
      </Card>

      <Card title={translate("m5424f5dd84a1")} subtitle={translate("m783c0d01181a")}>
        {options ? <fieldset className="space-y-2">
          <legend className="sr-only">{translate("m5424f5dd84a1")}</legend>
          {options.map(option => <label key={option} className="flex items-center gap-2 text-sm text-ink-800">
            <input type="radio" name="team-attribute" value={option} checked={selected === option} onChange={() => choose(option)} />
            <span>{option}</span>
            {option === data.current && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">{translate("m72d2bae2a744")}</span>}
          </label>)}
        </fieldset> : <p className="text-sm text-ink-500">{translate("m9d004a4c403a", [data.current ?? translate("m24a3d8ce95ce")])}</p>}
      </Card>

      {options && selected && <>
        {preview.loading && <Loading />}
        {preview.error && <Notice>{translate("m079b5e102e4d")}</Notice>}
        {preview.data && <>
          <DataTable title={translate("mfe7bc674eb23")} columns={columns} rows={preview.data.values} groupKey="" />
          <div className="space-y-1 text-sm text-ink-600">
            <p>{richMessage("mf995216032e2", [<strong>{preview.data.missing}</strong>])}</p>
            <p>{richMessage("m17f6238a230c", [<strong>{preview.data.excluded}</strong>])}</p>
          </div>
        </>}
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-ink-500">{data.current == null
            ? translate("m9a317f8d47c0")
            : translate("m4099095c2117")}</p>
          {conflict && <Notice>{translate("m2b6bc9e24fea")}<button type="button" className={`${SECONDARY} ml-3`} onClick={() => { setSaved(false); setAttempt(n => n + 1); }}>{translate("m5566216e77e6")}</button></Notice>}
          {saveError && <Notice>{translate(saveError)}</Notice>}
          {saved && <p role="status" className="text-sm text-positive-text">{translate("m9a9ec59c0f57")}</p>}
          <button type="button" className={PRIMARY} disabled={saving || conflict || !preview.data} onClick={save}>{saving ? translate("m92c4796cf195") : translate("m5fb926229090")}</button>
        </div>
      </>}
    </div>;
  }

  return <div>
    <PageHeader title={translate("m115bced49291")} subtitle={translate("m66f508b7b7ed")} />
    <div className="p-4 sm:p-8">{body}</div>
  </div>;
}
