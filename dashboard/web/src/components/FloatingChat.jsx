import { useEffect, useRef, useState } from "react";
import { MessageCircle, Send, X } from "lucide-react";
import { cn } from "../cn.js";

// Ask Claude — 우하단 플로팅 챗. POST /api/chat SSE(text/status/done/error)를 그대로 읽는다.
// markdown 렌더러는 안 붙인다(표는 원문 그대로 보여도 충분) — 필요해지면 그때 추가.
async function streamChat(messages, { onText, onStatus }) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
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
      const payload = JSON.parse(data);
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, status]);

  const ask = async (text) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    setStatus("");
    const history = [...msgs, { role: "user", content: q }];
    setMsgs([...history, { role: "assistant", content: "" }]);
    try {
      await streamChat(history, {
        onText: (t) =>
          setMsgs((m) => {
            const next = [...m];
            next[next.length - 1] = { role: "assistant", content: next[next.length - 1].content + t };
            return next;
          }),
        onStatus: setStatus,
      });
    } catch (err) {
      setMsgs((m) => {
        const next = [...m];
        next[next.length - 1] = { role: "assistant", content: `오류: ${err.message}` };
        return next;
      });
    } finally {
      setBusy(false);
      setStatus("");
    }
  };

  return (
    <>
      {open && (
        <div className="fixed bottom-20 right-6 z-50 flex h-[520px] w-[400px] flex-col overflow-hidden rounded-xl border border-ink-100 bg-card shadow-xl">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
            <div>
              <div className="text-[14px] font-semibold text-ink-800">Ask Claude</div>
              <div className="text-[11px] text-ink-400">sonnet-5 · ClickHouse 직접 조회</div>
            </div>
            <button onClick={() => setOpen(false)} className="rounded-md p-1 text-ink-400 hover:bg-ink-100">
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
            {msgs.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-[13px] leading-relaxed",
                  m.role === "user" ? "self-end bg-brand-500 text-white" : "self-start bg-ink-100 text-ink-800"
                )}
              >
                {m.content || (busy && i === msgs.length - 1 ? "…" : "")}
              </div>
            ))}
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
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-brand-500 px-4 py-3 text-[13px] font-semibold text-white shadow-lg hover:bg-brand-600 print:hidden"
      >
        <MessageCircle size={16} />
        Ask Claude
      </button>
    </>
  );
}
