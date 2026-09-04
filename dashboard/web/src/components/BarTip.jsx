import { useState } from "react";

// 테이블 안 스택 바용 즉시 툴팁 — HTML title은 ~1초 지연 + 브라우저 기본 스타일이라 차트
// 툴팁(tooltipStyles)과 체감이 달랐다. fixed 포지션이라 DataTable의 overflow-x-auto 컨테이너에
// 클리핑되지 않는다(transform 조상이 없는 한 fixed는 뷰포트 기준). 상세 문자열은 접근성/테스트용
// aria-label로도 함께 노출한다 — 호출부가 label을 넘기면 여기서 붙인다.
export function BarTip({ tip, label, children, className }) {
  const [pos, setPos] = useState(null);
  return (
    <span
      className={className}
      aria-label={label}
      onMouseEnter={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && (
        <span
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed whitespace-nowrap"
          style={{ left: pos.x, top: pos.y - 10, background: "var(--chart-tooltip-bg)", color: "var(--chart-tooltip-fg)", boxShadow: "0 6px 24px rgba(0,0,0,.25)" }}
        >
          {tip}
        </span>
      )}
    </span>
  );
}
