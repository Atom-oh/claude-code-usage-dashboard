import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowRight, ExternalLink } from "lucide-react";
import { PageHeader } from "../components/PageHeader.jsx";
import { Badge } from "../components/Badge.jsx";
import { useClient } from "../ClientContext.jsx";
import { LATEST_RELEASE, RELEASES, markSeen, releaseLink } from "../releaseNotes.js";

const KIND = {
  new: { label: "새 기능", tone: "brand" },
  improved: { label: "개선", tone: "positive" },
  fixed: { label: "수정", tone: "neutral" },
};
const REPO = "https://github.com/Atom-oh/claude-code-usage-dashboard";

function ReleaseItem({ item, search, enabledClients }) {
  const kind = KIND[item.kind] || KIND.improved;
  const target = releaseLink(item, search, enabledClients);
  return (
    <li className="border-b border-ink-100 py-3.5 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={kind.tone}>{kind.label}</Badge>
        <h3 className="text-[14px] font-semibold text-ink-800">{item.title}</h3>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-600">{item.body}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-500">
        <span>위치: {item.where}</span>
        {target && (
          <Link to={target} className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
            바로 가기<ArrowRight size={12} aria-hidden="true" />
          </Link>
        )}
        {item.refs.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {item.refs.map((n) => (
              <a key={n} href={`${REPO}/pull/${n}`} target="_blank" rel="noreferrer" className="hover:underline">#{n}</a>
            ))}
          </span>
        )}
      </div>
    </li>
  );
}

export default function Changelog() {
  const { search } = useLocation();
  const { enabledClients } = useClient();
  // Opening the page acknowledges the latest release; the sidebar dot clears on navigation.
  useEffect(() => markSeen(LATEST_RELEASE.version), []);
  return (
    <div>
      <PageHeader title="변경 내역" subtitle="릴리스마다 바뀐 점과 새 기능을 어디서 쓰는지 정리했습니다. 전체 기술 변경 기록은 CHANGELOG에 있습니다."
        right={<a href={`${REPO}/blob/main/CHANGELOG.md`} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-700 hover:bg-ink-50">
          CHANGELOG<ExternalLink size={13} aria-hidden="true" />
        </a>} />
      <div className="space-y-5 px-8 py-6">
        {RELEASES.map((release) => (
          <section key={release.version} aria-labelledby={`release-${release.version}`}
            className="rounded-lg border border-ink-100 bg-card shadow-card">
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-ink-100 px-4 pt-4 pb-3">
              <h2 id={`release-${release.version}`} className="text-[16px] font-semibold text-ink-800">
                <a href={`${REPO}/releases/tag/v${release.version}`} target="_blank" rel="noreferrer" className="hover:underline">v{release.version}</a>
              </h2>
              <time dateTime={release.date} className="text-[12px] text-ink-500">{release.date}</time>
              {release === LATEST_RELEASE && <Badge tone="brand" dot>최신</Badge>}
              <p className="w-full text-[13px] text-ink-600">{release.summary}</p>
            </header>
            <ul className="px-4">
              {release.items.map((item) => (
                <ReleaseItem key={item.title} item={item} search={search} enabledClients={enabledClients} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
