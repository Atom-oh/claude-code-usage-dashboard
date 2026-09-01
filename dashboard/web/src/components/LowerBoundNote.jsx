import { Info } from "lucide-react";

export default function LowerBoundNote() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-surface px-4 py-3 shadow-sm">
      <Info size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <p className="tabular text-[12px] leading-relaxed text-warning-text">
        <span className="font-semibold">대시보드 비용은 실청구의 하한선이다</span> — (1) thinking 토큰이 Claude Code
        텔레메트리 token.usage/cost.usage에 미포함(업스트림 이슈 #16943, 실측: xhigh effort 세션에서 콘솔 output이
        OTel의 2.16배), (2) claude.ai 웹 등 비계측 채널 사용분 미포함.
      </p>
    </div>
  );
}
