import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { setPiiMask } from "./fmt.js";
import "./index.css";

// 마스킹 여부는 서버 env(PII_MASK_ENABLED)에서 온다 — 렌더 전에 한 번 받아서, 마스킹 배포에서
// 원본 이메일이 한 프레임 스쳐 보이는 일이 없게 한다. 두 가지 실패 모드를 같이 막는다
// (둘 다 리뷰에서 MAJOR로 확인):
//   1) fail-open: 예전엔 실패 시 마스킹 OFF로 렌더돼 공개 데모에서 원본이 노출됐다 —
//      fmt.js 초기값이 ON이고, 명시적 {piiMask:false}일 때만 끈다(r.ok 검증 포함).
//   2) 영구 blank screen: fetch가 hang하면 .catch는 못 잡는다 — AbortController로 3초 컷,
//      그 뒤엔 (마스킹 ON 상태로) 무조건 렌더한다. 비필수 config가 앱 availability를
//      좌우해선 안 된다.
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 3_000);

fetch("/api/config", { signal: ac.signal })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)
  .then((cfg) => {
    clearTimeout(timer);
    if (cfg?.piiMask === false) setPiiMask(false);
    createRoot(document.getElementById("root")).render(
      <StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrictMode>
    );
  });
