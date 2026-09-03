import { Info } from "lucide-react";
import { useConfig } from "../ConfigContext.jsx";

export default function LowerBoundNote() {
  // 세그먼트 인식 SeriesKey가 확인된(=== true) 클러스터에서만 --resume 원인을 뺀다 — 미확인
  // 상태(false/null/undefined/구버전 서버/config fetch 실패)를 "적용됨"으로 오인하면 실제 비용
  // 과소집계 경고가 조용히 사라진다. 설정은 main.jsx가 첫 렌더 전에 받아둔 것을 쓴다.
  const { schema } = useConfig();
  const migrated = schema?.segmentAwareSeriesKey === true;

  const causes = [
    "텔레메트리 env가 없는 경로(IDE 확장, 비로그인 셸 등)로 실행된 Claude Code 프로세스는 계측되지 않음(실측: 같은 사용자·같은 날 콘솔 요청 수가 OTel의 11.6배)",
    ...(migrated
      ? []
      : [
          <>
            <code>claude --resume</code>은 같은 session.id로 카운터를 0부터 다시 올려 세션 경계
            차분에서 이전 구간이 유실됨(clickhouse-migration-003 미적용 클러스터에 해당, 실측: 14일
            cost.usage 기준 15%)
          </>,
        ]),
    "단가표에 없는 모델(Bedrock의 비-Anthropic 모델 등)의 토큰은 계산 비용에서 제외되고 unpriced로 별도 표기됨",
    "claude.ai 웹 등 비계측 채널 미포함",
  ];

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-surface px-4 py-3 shadow-sm">
      <Info size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <p className="tabular text-[12px] leading-relaxed text-warning-text">
        <span className="font-semibold">대시보드 비용은 실청구의 하한선이다</span>
        {" — "}
        {causes.map((cause, i) => (
          <span key={i}>
            {i > 0 && ", "}({i + 1}) {cause}
          </span>
        ))}
        . thinking 토큰은 output에 포함된다(실측: 세션 transcript 합 127,204 vs OTel 129,419).
      </p>
    </div>
  );
}
