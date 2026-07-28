import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { setPiiMask } from "./fmt.js";
import "./index.css";

// 마스킹 여부는 서버 env(PII_MASK_ENABLED)에서 온다 — 렌더 전에 한 번 받아서, 켜진 배포에서
// 원본 이메일이 한 프레임 스쳐 보이는 일이 없게 한다. 실패하면 기본값(마스킹 없음)으로 렌더.
fetch("/api/config")
  .then((r) => r.json())
  .catch(() => ({}))
  .then((cfg) => {
    setPiiMask(cfg.piiMask);
    createRoot(document.getElementById("root")).render(
      <StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrictMode>
    );
  });
