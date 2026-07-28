import { useState } from "react";

// Ask Claude 챗의 사고 과정(thinking)과 실행한 SQL을 접이식으로 보여준다 — FloatingChat과
// Analytics가 공유. 기본은 접힘: 대부분의 질문에서 답변만 보면 되고, 근거를 확인하려는
// 사용자만 펼친다(둘 다 펼쳐두면 답변이 스크롤 밖으로 밀린다).
export function ChatTrace({ thinking, sqls = [] }) {
  const [open, setOpen] = useState(false);
  if (!thinking && !sqls.length) return null;
  return (
    <div className="self-start w-full max-w-[85%] text-[11px]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-ink-400 hover:text-ink-600"
      >
        {/* thinking 없이 SQL만 있는 턴도 있다(모델이 추론 없이 바로 쿼리) — 그때 "사고 과정"은 거짓 라벨 */}
        {open ? "▾" : "▸"} {thinking ? "사고 과정" : "실행한 쿼리"}
        {sqls.length > 0 && thinking && ` · 쿼리 ${sqls.length}개`}
        {sqls.length > 0 && !thinking && ` ${sqls.length}개`}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-2 rounded-lg border border-ink-100 bg-ink-50 p-2">
          {thinking && <div className="whitespace-pre-wrap text-ink-500">{thinking}</div>}
          {sqls.map((sql, i) => (
            // SQL은 길고 줄바꿈이 의미를 가지므로 가로 스크롤로 두고 줄바꿈만 보존한다 —
            // 자동 줄바꿈하면 들여쓰기가 깨져 읽기 더 어려워진다.
            <pre
              key={i}
              className="overflow-x-auto rounded border border-ink-100 bg-white p-2 font-mono text-[10px] leading-relaxed text-ink-600"
            >
              {sql}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}
