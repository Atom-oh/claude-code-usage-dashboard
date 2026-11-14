import { localize, translate, useLocale } from "../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Maximize2, MessageCircle, Minimize2, Send, X } from "lucide-react";
import { cn } from "../cn.js";
import { useChatStream, useStickToBottom } from "../useChatStream.js";
import { ChatTrace } from "./ChatTrace.jsx";
import { ChatCharts } from "./ChatCharts.jsx";
import { DEFAULT_CHAT_SIZE, clampChatSize, expandedChatSize, loadChatSize, saveChatSize } from "../chatWindowSize.js";

// Ask Claude — 우하단 플로팅 챗. POST /api/chat SSE(text/thinking/chart/status/done/error)를 읽는
// 공용 로직은 useChatStream.js에 있다 — Analytics 탭도 같은 훅을 쓴다.

const SUGGESTIONS = localize([
  "지난 7일간 모델별 토큰 사용량을 보여줘",
  "세션 수가 가장 많은 사용자 5명은?",
  "bedrock과 enterprise 채널의 비용을 비교해줘",
]);

export function FloatingChat() {
  const _locale = useLocale();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const { msgs, busy, status, trace, ask, stop: stopStream } = useChatStream();
  const { containerRef, onScroll } = useStickToBottom([msgs, status, trace], trace.turn);
  // 창 크기 — 좌상단 핸들 드래그/화살표 키로 조절하고 브라우저에 기억한다. 우하단 고정이라
  // 왼쪽·위로 끌수록 커진다. 확대 버튼은 직전 크기를 기억했다가 되돌린다.
  const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [size, setSize] = useState(() => clampChatSize(loadChatSize() ?? DEFAULT_CHAT_SIZE, viewport()));
  const [restore, setRestore] = useState(null);
  const drag = useRef(null);
  useEffect(() => {
    const onResize = () => setSize((s) => clampChatSize(s, viewport()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const resizeTo = (next, { persist = true } = {}) => {
    const clamped = clampChatSize(next, viewport());
    setSize(clamped);
    if (persist) saveChatSize(clamped);
    return clamped;
  };
  const onHandleDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
    setRestore(null);
  };
  const onHandleMove = (e) => {
    const d = drag.current;
    if (!d) return;
    resizeTo({ w: d.w + (d.x - e.clientX), h: d.h + (d.y - e.clientY) }, { persist: false });
  };
  const onHandleUp = () => {
    if (!drag.current) return;
    drag.current = null;
    saveChatSize(size);
  };
  const onHandleKey = (e) => {
    const step = e.shiftKey ? 80 : 20;
    const delta = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!delta) return;
    e.preventDefault();
    setRestore(null);
    resizeTo({ w: size.w + delta[0], h: size.h + delta[1] });
  };
  const toggleExpanded = () => {
    if (restore) {
      resizeTo(restore);
      setRestore(null);
    } else {
      setRestore(size);
      // The expanded preset is temporary; only the normal size is remembered.
      resizeTo(expandedChatSize(viewport()), { persist: false });
    }
  };

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
        <div
          role="dialog"
          aria-label="Ask Claude"
          style={{ width: size.w, height: size.h }}
          className="fixed bottom-20 right-6 z-50 flex max-h-[calc(100vh-7rem)] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-xl border border-ink-100 bg-card shadow-xl print:hidden"
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={translate("m4dd65b36a0cf")}
            aria-valuenow={size.w}
            tabIndex={0}
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            onKeyDown={onHandleKey}
            title={translate("m032eeb54d78b")}
            className="absolute left-0 top-0 z-10 h-4 w-4 cursor-nwse-resize touch-none rounded-br-md border-b border-r border-ink-200 bg-ink-100/70 hover:bg-ink-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
            <div>
              <div className="text-[14px] font-semibold text-ink-800">Ask Claude</div>
              <div className="text-[11px] text-ink-400">{translate("m31c5ab0c8282")}</div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={toggleExpanded}
                aria-label={restore ? translate("m660c2f9f44e4") : translate("m528d4ed93294")}
                title={restore ? translate("m660c2f9f44e4") : translate("m528d4ed93294")}
                className="rounded-md p-1 text-ink-400 hover:bg-ink-100"
              >
                {restore ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
              <button onClick={stop} aria-label={translate("m1e8c10206f5b")} className="rounded-md p-1 text-ink-400 hover:bg-ink-100">
                <X size={16} />
              </button>
            </div>
          </div>
          <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            {msgs.length === 0 && (
              <div className="flex flex-col gap-2">
                <div className="text-[11px] uppercase tracking-[0.04em] text-ink-400">{translate("m9e2e82b50b2f")}</div>
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
              if (!m.content && !m.charts?.length && !(busy && i === msgs.length - 1)) return null;
              return (
                <div
                  key={i}
                  className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-relaxed",
                    m.role === "user"
                      ? "self-end whitespace-pre-wrap bg-brand-500 text-white"
                      : "self-start bg-ink-100 text-ink-800 chat-md",
                    // 차트가 있으면 말풍선을 허용 폭까지 넓힌다 — 좁은 위젯에서 축 라벨이 겹친다.
                    m.charts?.length && "w-full"
                  )}
                >
                  {m.role === "user" ? m.content : m.content ? <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown> : busy && i === msgs.length - 1 ? "…" : null}
                  {m.role === "assistant" && <ChatCharts charts={m.charts} />}
                </div>
              );
            })}
            {/* key=단조 증가 턴 번호(trace.turn) — 새 질문마다 리마운트해서 접힘 상태로 되돌린다(이전 trace를
                펼쳐둔 채 다음 질문을 보내면 기본 접힘 의도와 달리 펼쳐진 채 나타난다). */}
            <ChatTrace key={trace.turn} thinking={trace.thinking} sqls={trace.sqls} />
            {status && <div className="self-start text-[11px] text-ink-400">{status}</div>}
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
              placeholder={translate("m57e26d26c5c7")}
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
