import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageCircle, Send, X } from "lucide-react";
import { cn } from "../cn.js";

// Ask Claude — 우하단 플로팅 챗. POST /api/chat SSE(text/status/done/error)를 그대로 읽는다.
async function streamChat(messages, { onText, onStatus, signal }) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok) throw new Error(`chat -> ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (!event || !data) continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue; // 잘린/깨진 SSE 라인은 무시
      }
      if (event === "text") onText(payload.text);
      else if (event === "status") onStatus(payload.message);
      else if (event === "error") throw new Error(payload.message);
    }
  }
}

const SUGGESTIONS = [
  "지난 7일간 모델별 토큰 사용량을 보여줘",
  "생산성 점수가 가장 높은 유저 5명은?",
  "bedrock과 enterprise 그룹의 비용을 비교해줘",
];

export function FloatingChat() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState([]); // {role, content}
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const bottomRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, status]);

  // 언마운트 시 진행 중인 스트림 취소 — 안 그러면 fetch reader 루프가 계속 돌며 죽은 컴포넌트 state를 갱신한다.
  useEffect(() => () => abortRef.current?.abort(), []);

  // 챗을 닫으면 진행 중인 스트림도 취소하고 상태를 초기화한다.
  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
    setStatus("");
    setOpen(false);
  };

  const ask = async (text) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    setStatus("");
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // 이전 오류 말풍선(error:true)과 빈 assistant placeholder(content 없음)는 서버로 다시
    // 보내지 않는다 — 걸러도 앞선 user 턴이 그대로 남을 수 있다(예: 에러 후 재질문 시
    // [user:Q1, assistant:오류] 에서 오류만 빠지면 [user:Q1, user:Q2]로 연속 user 턴이 되고,
    // Bedrock Converse가 역할 교차를 요구해 거부 → 리로드 전까지 챗이 먹통이 된다(실측: 리뷰에서
    // 확인). 그래서 필터 후 같은 role이 연속되면 하나로 합쳐 항상 user/assistant가 교차하게
    // 만든다 — 어떤 필터 조합에서도 안전하다.
    const history = [];
    for (const m of [...msgs, { role: "user", content: q }]) {
      if (!m.content || m.error) continue;
      const last = history[history.length - 1];
      if (last && last.role === m.role) last.content += "\n" + m.content;
      else history.push({ role: m.role, content: m.content });
    }
    setMsgs([...history, { role: "assistant", content: "" }]);
    try {
      await streamChat(history, {
        signal: ac.signal,
        onText: (t) =>
          setMsgs((m) => {
            const next = [...m];
            next[next.length - 1] = { role: "assistant", content: next[next.length - 1].content + t };
            return next;
          }),
        onStatus: setStatus,
      });
    } catch (err) {
      if (ac.signal.aborted) return; // 사용자가 닫거나 다시 보낸 경우 — 오류로 표시하지 않는다
      setMsgs((m) => {
        const next = [...m];
        next[next.length - 1] = { role: "assistant", content: `오류: ${err.message}`, error: true };
        return next;
      });
    } finally {
      if (!ac.signal.aborted) {
        setBusy(false);
        setStatus("");
      }
    }
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
                    onClick={() => ask(s)}
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
              ask(input);
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
