import { translateSource, translate, useLocale } from "./i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { checkAuthentication } from "./api.js";
import { validChatChart } from "./chatCharts.js";

// Ask Claude 챗 공용 로직 — FloatingChat(우하단 위젯)과 Analytics(전용 탭)가 공유한다.
// POST /api/chat SSE(text/thinking/chart/status/done/error)를 그대로 읽는다.
export async function streamChat(messages, { onText, onStatus, onThinking, onChart, signal }) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  checkAuthentication(res);
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
      // 서버(chatCharts.js)가 이미 검증한 템플릿이지만 렌더 전에 같은 모양을 다시 확인한다 —
      // 모델이 만든 코드/임의 데이터는 어떤 경로로도 그리지 않고, 깨진 chart 이벤트는 버린다.
      else if (event === "chart" && validChatChart(payload)) onChart?.(payload);
      else if (event === "thinking") onThinking?.(payload.text);
      else if (event === "status") onStatus(payload.message, payload.sql);
      else if (event === "error") throw new Error(payload.message);
    }
  }
}

// 새 내용이 오면 맨 아래로 따라가되, 사용자가 위로 스크롤해 읽고 있으면 따라가지 않는다.
// thinking은 델타마다 오므로(한 턴에 수십 번) 무조건 scrollIntoView하면 위로 스크롤 자체가
// 불가능해진다(리뷰에서 확인). FloatingChat/Analytics가 같은 로직을 쓰므로 여기서 공유한다.
// resetKey(턴 번호)가 바뀌면 다시 따라가기 시작한다 — 위로 올려 읽던 상태에서 새 질문을 보내면
// 새 답변은 따라가야 한다(안 그러면 FloatingChat에서 응답이 온 걸 못 본다).
export function useStickToBottom(deps, resetKey) {
  const _locale = useLocale();
  const containerRef = useRef(null);
  const stick = useRef(true);

  // 자동 스크롤은 즉시 이동(scrollTop = scrollHeight)이다 — behavior:"smooth"를 쓰면 스크롤이
  // 끝날 때까지 중간 scroll 이벤트가 계속 나오고, 그 순간 distance는 아직 80px보다 커서 사용자
  // 스크롤로 오인된다. 그래서 원래는 "자동 스크롤 직후 700ms는 무시"하는 시간 창을 뒀는데,
  // thinking 델타가 700ms보다 촘촘히 와 창이 스트리밍 내내 재연장됐고 결국 사용자 스크롤이
  // 전부 무시됐다 — wheel/touch만 예외 처리해도 스크롤바 드래그와 키보드(PgUp/↑/Space)는
  // 여전히 막혔다(리뷰에서 MAJOR 2회 확인). 즉시 이동은 중간 이벤트를 만들지 않으므로 창이
  // 아예 필요 없다: 자동 스크롤이 만든 유일한 scroll 이벤트는 distance≈0이라 stick을 유지하고,
  // 사용자가 어떤 방식으로 올리든 그 즉시 실제 위치로 판정된다.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; // 하단 80px 이내면 따라간다
  };

  useEffect(() => {
    stick.current = true;
  }, [resetKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (!stick.current || !el) return;
    el.scrollTop = el.scrollHeight;
  }, deps);

  return { containerRef, onScroll };
}

export function useChatStream() {
  const _locale = useLocale();
  const [msgs, setMsgs] = useState([]); // {role, content, charts?, error?}
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // 진행 중인 턴의 사고 과정과 실행한 SQL — 답변 말풍선과 별개로 접이식 영역에 렌더한다.
  // 답변이 시작되면 지우지 않는다(무엇을 근거로 답했는지 확인하려는 게 이 기능의 목적).
  // turn은 단조 증가하는 턴 번호 — 렌더 쪽 <ChatTrace key>로 쓴다. msgs.length는 key가 될 수 없다:
  // ask()가 오류 말풍선을 걸러내고 연속 user 턴을 합치므로 재질문 후 길이가 그대로일 수 있고,
  // 그러면 리마운트가 안 돼 이전 턴의 펼침 상태가 남는다(리뷰에서 확인).
  const [trace, setTrace] = useState({ thinking: "", sqls: [], turn: 0 });
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
    // 새 질문마다 초기화 — 이전 턴의 추론/쿼리가 섞이면 오해를 부른다
    setTrace((t) => ({ thinking: "", sqls: [], turn: t.turn + 1 }));
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // 이전 오류 말풍선(error:true, 차트 없음)과 빈 assistant placeholder(content·charts 없음)는 서버로 다시
    // 보내지 않는다 — 걸러도 앞선 user 턴이 그대로 남을 수 있다(예: 에러 후 재질문 시
    // [user:Q1, assistant:오류] 에서 오류만 빠지면 [user:Q1, user:Q2]로 연속 user 턴이 되고,
    // Bedrock Converse가 역할 교차를 요구해 거부 → 리로드 전까지 챗이 먹통이 된다(실측: 리뷰에서
    // 확인). 그래서 필터 후 같은 role이 연속되면 하나로 합쳐 항상 user/assistant가 교차하게
    // 만든다 — 어떤 필터 조합에서도 안전하다. 차트는 화면 기록(history)에만 남기고 서버로 보내는
    // 본문(modelHistory)에서는 뺀다 — 차트 배열을 모델 히스토리에 되돌려보내지 않는다(agent-llm.md).
    const history = [];
    for (const m of [...msgs, { role: "user", content: q }]) {
      if ((!m.content && !m.charts?.length) || (m.error && !m.charts?.length)) continue;
      // Retain observed charts after a failed writer, without replaying its error.
      const content = m.error ? "" : m.content;
      const last = history[history.length - 1];
      if (last && last.role === m.role && !last.charts?.length && !m.charts?.length) last.content += "\n" + content;
      else history.push({ role: m.role, content, ...(m.charts?.length ? { charts: m.charts } : {}) });
    }
    setMsgs([...history, { role: "assistant", content: "" }]);
    try {
      const modelHistory = [];
      for (const m of history) {
        if (!m.content) continue;
        const last = modelHistory[modelHistory.length - 1];
        if (last && last.role === m.role) last.content += "\n" + m.content;
        else modelHistory.push({ role: m.role, content: m.content });
      }
      await streamChat(modelHistory, {
        signal: ac.signal,
        onText: (t) => {
          if (ac.signal.aborted) return;
          // 실제 답변 텍스트가 오면 직전 hop의 상태 문구("쿼리 작성 중..." 등)는 이미 낡은
          // 정보다 — 안 지우면 답변이 스트리밍되는 동안 위/아래에 안 맞는 상태줄이 계속 남아
          // 있는 것처럼 보인다.
          setStatus("");
          setMsgs((m) => {
            const next = [...m];
            next[next.length - 1] = { ...next[next.length - 1], content: next[next.length - 1].content + t };
            return next;
          });
        },
        // 차트는 답변 말풍선에 붙여 보관한다(최대 3개 — 서버 MAX_CHARTS와 동일). 이후 writer가
        // 실패해도 이미 받은 차트는 남긴다(아래 catch가 기존 필드를 보존).
        onChart: (chart) => {
          if (ac.signal.aborted) return;
          setMsgs((m) => {
            const next = [...m];
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, charts: [...(last.charts || []), chart].slice(0, 3) };
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
        next[next.length - 1] = { ...next[next.length - 1], role: "assistant", content: translate("m7f0cde8733f9", [err.message]), error: true };
        return next;
      });
    } finally {
      if (!ac.signal.aborted) {
        setBusy(false);
        setStatus("");
      }
    }
  };

  return { msgs, busy, status: translateSource(status), trace, ask, stop };
}
