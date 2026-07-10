import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Send } from "lucide-react";
import { cn } from "../cn.js";
import { PageHeader } from "../components/PageHeader.jsx";
import { Card } from "../components/Card.jsx";
import { useChatStream } from "../useChatStream.js";
import { useRange } from "../RangeContext.jsx";

// 카테고리별 미리 준비된 분석 질문 — 클릭하면 그대로 /api/chat 에이전트(chat.js의 run_sql
// 툴콜 루프)에게 물어본다. 질문 범위는 SYSTEM 프롬프트가 실제로 아는 스키마
// (otel_metrics_sum/otel_logs, 누적 카운터 diff) 안으로만 한정한다.
const CATEGORIES = [
  {
    label: "비용",
    prompts: [
      (days) => `최근 ${days}일간 bedrock과 enterprise 그룹의 모델별 비용을 비교해줘`,
      (days) => `최근 ${days}일간 일별 비용이 급증한 구간이 있는지 찾아줘`,
      (days) => `캐시 토큰(cache_read/cache_write)이 최근 ${days}일 비용에 얼마나 영향을 줬는지 알려줘`,
    ],
  },
  {
    label: "도입 · 활동",
    prompts: [
      (days) => `최근 ${days}일간 활성 사용자 추이와 그룹별 도입률을 알려줘`,
      (days) => `최근 ${days}일간 세션 수 기준 상위 10명의 사용자를 보여줘`,
    ],
  },
  {
    label: "생산성",
    prompts: [
      (days) => `최근 ${days}일간 사용자별 코드 제안 수락률을 비교해줘`,
      (days) => `최근 ${days}일간 커밋과 PR 지표를 요약해줘`,
    ],
  },
  {
    label: "이상 탐지",
    prompts: [
      (days) => `최근 ${days}일간 텔레메트리 수집이 끊긴 구간이 있는지 찾아줘`,
      (days) => `최근 ${days}일간 비정상적으로 비용이 높은 세션이 있는지 찾아줘`,
    ],
  },
];

export default function Analytics() {
  const { days } = useRange();
  const [input, setInput] = useState("");
  const { msgs, busy, status, ask } = useChatStream();
  const bottomRef = useRef(null);
  const started = msgs.length > 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, status]);

  const submit = (text) => {
    if (!text.trim() || busy) return;
    setInput("");
    ask(text);
  };

  return (
    <div>
      <PageHeader title="Analytics" subtitle="미리 준비된 질문을 누르면 에이전트가 ClickHouse를 직접 조회해 답합니다." />
      <div className="p-8 flex flex-col gap-5">
        {started ? (
          // 대화가 시작되면 카테고리 그리드 대신, 이어서 물어볼 수 있도록 한 줄 스트립으로 압축.
          <div className="flex gap-2 overflow-x-auto whitespace-nowrap pb-1">
            {CATEGORIES.flatMap((c) => c.prompts).map((p, i) => (
              <button
                key={i}
                onClick={() => submit(p(days))}
                disabled={busy}
                className="shrink-0 rounded-full border border-ink-100 bg-white px-3 py-1.5 text-[12px] text-ink-600 hover:border-brand-500 hover:text-ink-800 disabled:opacity-40"
              >
                {p(days)}
              </button>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {CATEGORIES.map((c) => (
              <Card key={c.label} title={c.label}>
                <div className="flex flex-col gap-2">
                  {c.prompts.map((p, i) => (
                    <button
                      key={i}
                      onClick={() => submit(p(days))}
                      className="rounded-lg border border-ink-100 bg-white px-3 py-2 text-left text-[13px] text-ink-600 hover:border-brand-500 hover:text-ink-800"
                    >
                      {p(days)}
                    </button>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}

        {started && (
          <Card padded={false} className="flex flex-col">
            <div className="flex flex-col gap-3 p-4 max-h-[60vh] overflow-y-auto">
              {msgs.map((m, i) => {
                // 첫 토큰 도착 전 빈 assistant placeholder는 진행 중이 아니면 렌더하지 않는다.
                if (!m.content && !(busy && i === msgs.length - 1)) return null;
                // 서버가 인증 미설정으로 503을 주면(dashboard/server/index.js) 안내 문구로 대체.
                const authDisabled = m.error && /503$/.test(m.content);
                return (
                  <div
                    key={i}
                    className={cn(
                      "max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-relaxed",
                      m.role === "user"
                        ? "self-end whitespace-pre-wrap bg-brand-500 text-white"
                        : "self-start bg-ink-100 text-ink-800 chat-md"
                    )}
                  >
                    {m.role === "user" ? (
                      m.content
                    ) : authDisabled ? (
                      "챗이 비활성화되어 있습니다 — 관리자가 BASIC_AUTH를 설정해야 사용할 수 있습니다."
                    ) : m.content ? (
                      <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown>
                    ) : (
                      "…"
                    )}
                  </div>
                );
              })}
              {status && <div className="self-start text-[11px] text-ink-400">{status}</div>}
              <div ref={bottomRef} />
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit(input);
              }}
              className="flex items-center gap-2 border-t border-ink-100 p-3"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="추가로 물어보고 싶은 것이 있나요?"
                className="min-w-0 flex-1 rounded-lg border border-ink-200 bg-white px-3 py-2 text-[13px] focus:border-brand-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                className="rounded-lg bg-brand-500 p-2 text-white disabled:opacity-40"
              >
                <Send size={15} />
              </button>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
