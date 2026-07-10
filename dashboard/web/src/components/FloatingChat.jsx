import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageCircle, Send, X } from "lucide-react";
import { cn } from "../cn.js";
import { useChatStream } from "../useChatStream.js";

// Ask Claude — 우하단 플로팅 챗. POST /api/chat SSE(text/status/done/error)를 읽는
// 공용 로직은 useChatStream.js에 있다 — Analytics 탭도 같은 훅을 쓴다.

const SUGGESTIONS = [
  "지난 7일간 모델별 토큰 사용량을 보여줘",
  "생산성 점수가 가장 높은 유저 5명은?",
  "bedrock과 enterprise 그룹의 비용을 비교해줘",
];

export function FloatingChat() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const { msgs, busy, status, ask, stop: stopStream } = useChatStream();
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, status]);

  // 챗을 닫으면 진행 중인 스트림도 취소한다(대화 내용은 유지 — useChatStream 참고).
  const stop = () => {
    stopStream();
    setOpen(false);
  };

  const submit = (text) => {
    if (!text.trim() || busy) return;
    setInput("");
    ask(text);
  };

  return (
    <>
      {open && (
        <div className="fixed bottom-20 right-6 z-50 flex h-[520px] max-h-[calc(100vh-7rem)] w-[400px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-xl border border-ink-100 bg-card shadow-xl print:hidden">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
            <div>
              <div className="text-[14px] font-semibold text-ink-800">Ask Claude</div>
              <div className="text-[11px] text-ink-400">sonnet-5 · ClickHouse 직접 조회</div>
            </div>
            <button onClick={stop} className="rounded-md p-1 text-ink-400 hover:bg-ink-100">
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            {msgs.length === 0 && (
              <div className="flex flex-col gap-2">
                <div className="text-[11px] uppercase tracking-[0.04em] text-ink-400">이렇게 물어보세요</div>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => submit(s)}
                    className="rounded-lg border border-ink-100 bg-white px-3 py-2 text-left text-[12px] text-ink-600 hover:border-brand-500 hover:text-ink-800"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {msgs.map((m, i) => {
              // 첫 토큰 도착 전 닫혔다가 다시 열린 빈 assistant placeholder는 진행 중이 아니면
              // 렌더하지 않는다 — 그냥 두면 빈 회색 버블이 잔상으로 남는다.
              if (!m.content && !(busy && i === msgs.length - 1)) return null;
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
                  {m.role === "user" ? m.content : m.content ? <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown> : "…"}
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
              placeholder="사용량에 대해 무엇이든..."
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
        </div>
      )}
      <button
        onClick={() => (open ? stop() : setOpen(true))}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-brand-500 px-4 py-3 text-[13px] font-semibold text-white shadow-lg hover:bg-brand-600 print:hidden"
      >
        <MessageCircle size={16} />
        Ask Claude
      </button>
    </>
  );
}
