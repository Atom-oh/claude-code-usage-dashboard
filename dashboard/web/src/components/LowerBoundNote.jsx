import { Info } from "lucide-react";

export default function LowerBoundNote() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-surface px-4 py-3 shadow-sm">
      <Info size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <p className="tabular text-[12px] leading-relaxed text-warning-text">
        <span className="font-semibold">대시보드 비용은 실청구의 하한선이다</span> — (1) 텔레메트리 env가 없는
        경로(IDE 확장, 비로그인 셸 등)로 실행된 Claude Code 프로세스는 계측되지 않음(실측: 같은 사용자·같은 날
        콘솔 요청 수가 OTel의 11.6배), (2) <code>claude --resume</code>은 같은 session.id로 카운터를 0부터 다시
        올려 세션 경계 차분에서 이전 구간이 유실됨(실측: 14일 cost.usage 기준 15%), (3) 200K 초과 롱컨텍스트
        요청의 프리미엄 단가(입력 2배·출력 1.5배)는 계산 비용에 미반영, (4) claude.ai 웹 등 비계측 채널 미포함.
        thinking 토큰은 output에 포함된다(실측: 세션 transcript 합 127,204 vs OTel 129,419).
      </p>
    </div>
  );
}
