import { Inbox } from "lucide-react";
import { cn } from "../cn.js";
import { useFreshness } from "../FreshnessContext.jsx";

// 차트/표가 빈 배열을 받았을 때의 단일 표현. 예전에는 카드마다 "표시할 데이터가 없습니다"를
// 직접 렌더하거나(GroupCharts/Users) 아무 것도 안 그려서(Executive) 신규 설치가 $0·0%를 실제
// 측정값처럼 보여줬다.
//
// 문구는 신선도에 따라 갈린다: unknown이면 아직 수집 자체가 안 된 상태일 수 있으니 collector를
// 보라고 하고, ok/stale이면 조직에는 데이터가 있고 이 구간에만 없다는 뜻이다. 둘을 한 문구로
// 뭉치면 "설치가 잘못됐나"와 "기간을 늘려보자"가 구별되지 않는다. loading은 ok와 같이 다룬다 —
// 첫 응답 전에 설치 실패를 암시하는 문구가 깜빡이면 그게 더 큰 오해다.
// 레이아웃 클래스는 FreshnessBanner의 콜아웃과 같지만 색은 warning이 아니라
// 중립(ink)이다 — 데이터가 없는 건 장애가 아니다.
export default function EmptyState({ className }) {
  const { status } = useFreshness();
  const neverCollected = status === "unknown";
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-ink-100 bg-ink-50 px-4 py-3",
        className
      )}
    >
      <Inbox size={15} className="mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
      <div className="text-[13px] leading-relaxed text-ink-400">
        <div>{neverCollected ? "아직 수집된 데이터가 없습니다." : "선택한 기간에 데이터가 없습니다."}</div>
        {neverCollected && (
          <div className="mt-0.5 text-[12px]">
            텔레메트리 수집기가 실행 중인지 확인하세요.
          </div>
        )}
      </div>
    </div>
  );
}
