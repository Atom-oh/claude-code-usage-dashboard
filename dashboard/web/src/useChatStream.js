import { useEffect, useRef, useState } from "react";

// Ask Claude 챗 공용 로직 — FloatingChat(우하단 위젯)과 Analytics(전용 탭)가 공유한다.
// POST /api/chat SSE(text/status/done/error)를 그대로 읽는다.
export async function streamChat(messages, { onText, onStatus, onThinking, signal }) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok) {
    // 429/503은 서버가 이미 한국어 안내 문구를 JSON body에 담아 보낸다(index.js/chat.js) —
    // 버리지 않고 그대로 쓴다. body 파싱이 실패하면(예상 밖 5xx) 상태코드로 폴백.
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `chat -> ${res.status}`);
  }
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
      else if (event === "thinking") onThinking?.(payload.text);
      else if (event === "status") onStatus(payload.message, payload.sql);
      else if (event === "error") throw new Error(payload.message);
    }
  }
}

export function useChatStream() {
  const [msgs, setMsgs] = useState([]); // {role, content}
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // 진행 중인 턴의 사고 과정과 실행한 SQL — 답변 말풍선과 별개로 접이식 영역에 렌더한다.
  // 답변이 시작되면 지우지 않는다(무엇을 근거로 답했는지 확인하려는 게 이 기능의 목적).
  const [trace, setTrace] = useState({ thinking: "", sqls: [] });
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
    setTrace({ thinking: "", sqls: [] }); // 새 질문마다 초기화 — 이전 턴의 추론/쿼리가 섞이면 오해를 부른다
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
        onText: (t) => {
          // 실제 답변 텍스트가 오면 직전 hop의 상태 문구("쿼리 작성 중..." 등)는 이미 낡은
          // 정보다 — 안 지우면 답변이 스트리밍되는 동안 위/아래에 안 맞는 상태줄이 계속 남아
          // 있는 것처럼 보인다.
          setStatus("");
          setMsgs((m) => {
            const next = [...m];
            next[next.length - 1] = { role: "assistant", content: next[next.length - 1].content + t };
            return next;
          });
        },
        onThinking: (t) => setTrace((tr) => ({ ...tr, thinking: tr.thinking + t })),
        onStatus: (message, sql) => {
          setStatus(message);
          if (sql) setTrace((tr) => ({ ...tr, sqls: [...tr.sqls, sql] }));
        },
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

  return { msgs, busy, status, trace, ask, stop };
}
