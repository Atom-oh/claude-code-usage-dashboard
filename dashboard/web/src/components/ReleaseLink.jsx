import { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { BookOpen, ExternalLink, ScrollText } from "lucide-react";
import { CHANGELOG_PATH, USER_GUIDE_URL } from "../clientNavigation.js";
import { LATEST_RELEASE, hasUnseenRelease } from "../releaseNotes.js";

const LINK = "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-chrome-fg-muted no-underline hover:bg-ink-100 hover:text-chrome-fg";

// User guide: the public documentation site, opened in a new tab.
export function GuideLink() {
  return (
    <a href={USER_GUIDE_URL} target="_blank" rel="noreferrer" aria-label="사용설명서 (새 탭)" className={`mt-3 ${LINK}`}>
      <BookOpen size={14} strokeWidth={1.7} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">사용설명서</span>
      <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
    </a>
  );
}

// Version + changelog entry point. Rendered outside <nav>: the route/nav test pins the nav
// links to the client pages, and this is a utility link rather than a dashboard page.
export function ReleaseLink() {
  const { pathname, search } = useLocation();
  // Re-read storage on navigation so leaving /changelog clears the dot without a reload.
  const unseen = useMemo(() => pathname !== CHANGELOG_PATH && hasUnseenRelease(), [pathname]);
  return (
    <Link to={{ pathname: CHANGELOG_PATH, search }}
      aria-label={`변경 내역, 최신 v${LATEST_RELEASE.version}${unseen ? ", 새 릴리스" : ""}`}
      className={LINK}>
      <ScrollText size={14} strokeWidth={1.7} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">변경 내역 · v{LATEST_RELEASE.version}</span>
      {unseen && <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-hidden="true" title="새 릴리스" />}
    </Link>
  );
}
