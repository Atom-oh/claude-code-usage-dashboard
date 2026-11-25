import { translate, useLocale } from "../i18n/index.js";
import { Card, ErrorBox, Loading } from "./Card.jsx";
import { DataTable } from "./DataTable.jsx";
import { useApi } from "../useApi.js";
import { deviceShortId, maskDevice } from "../fmt.js";
import { formatObserved } from "../clientUsage.js";
import { clientName, formatClientTimestamp } from "../clientPresentation.js";

// Devices come from the server-verified ingest identity (`ccdash.device`), so only devices
// enrolled in the device Collector appear; other sessions are counted, never assigned a device.
export function deviceLabel(row, namesAvailable) {
  if (!namesAvailable) return `**·${deviceShortId(row.device)}`;
  if (row.deleted) return `${translate("maedd5145c50e")} **·${deviceShortId(row.device)}`;
  return maskDevice(row.name, row.device);
}

export function UserDevices({ user, clients, bounds = {}, linked = false, stale = false }) {
  const _locale = useLocale();
  const client = clients.length > 1 ? "all" : clients[0];
  const { data, loading, error, stale: old } = useApi("/api/users/devices", { client, userExact: user, ...bounds }, true,
    { unfiltered: true, linkedRange: linked, hold: stale });
  const title = translate("me3299f2d5fed");
  const subtitle = translate("m13932a26bb5d");
  if (error) return <Card title={title} subtitle={subtitle}><ErrorBox error={error} /></Card>;
  if (loading || stale) return <Card title={title} subtitle={subtitle}><Loading /></Card>;
  const named = data?.names_available === true;
  const columns = [
    { key: "device", label: translate("m2834016a200a"), render: (_v, row) => <span className="[overflow-wrap:anywhere]">
      {deviceLabel(row, named)}
      {row.revoked && <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600">{translate("mb6d4dd12b920")}</span>}
    </span> },
    { key: "os_types", label: translate("m8143161f55aa"), render: (v, row) => row.platform || (v || []).join(", ") || "—" },
    { key: "clients", label: translate("mb367c7d58dda"), render: (v) => (v || []).map(clientName).join(", ") || "—" },
    { key: "sessions", label: translate("me600d4f5926e"), render: formatObserved },
    { key: "last_seen", label: translate("m56ba41779428"), render: formatClientTimestamp },
  ];
  const notes = [
    data && !named && !data.names_masked && (data.devices || []).length > 0 && translate("m271e41a65967"),
    data?.devices_truncated && translate("m857c85e0d963", [(data.devices || []).length]),
    data?.unattributed_sessions > 0 && translate("m2d70d433657d", [formatObserved(data.unattributed_sessions)]),
  ].filter(Boolean);
  return <section aria-label={title} className="flex flex-col gap-2">
    <DataTable title={title} subtitle={subtitle} columns={columns} rows={data?.devices || []} stale={old} />
    {notes.map((note) => <p key={note} role="note" className="text-[12px] text-ink-500">{note}</p>)}
  </section>;
}
