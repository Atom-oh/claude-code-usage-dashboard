import { useEffect, useRef, useState } from "react";

// Ask Claude 챗 공용 로직 — FloatingChat(우하단 위젯)과 Analytics(전용 탭)가 공유한다.
// POST /api/chat SSE(text/status/done/error)를 그대로 읽는다.
export async function streamChat(messages, { onText, onStatus, signal }) {
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

export function useChatStream() {
  const [msgs, setMsgs] = useState([]); // {role, content}
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const abortRef = useRef(null);

  // 언마운트 시 진행 중인 스트림 취소 — 안 그러면 fetch reader 루프가 계속 돌며 죽은 컴포넌트 state를 갱신한다.
  useEffect(() => () => abortRef.current?.abort(), []);

  // 진행 중인 스트림만 취소한다 — 대화 내용(msgs)은 지우지 않는다(FloatingChat을 닫았다 다시 열어도
  // 이전 대화가 남아있는 기존 동작을 유지).
  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
    setStatus("");
  };

  const ask = async (text) => {
    const q = text.trim();
    if (!q || busy) return;
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

  return { msgs, busy, status, ask, stop };
}
