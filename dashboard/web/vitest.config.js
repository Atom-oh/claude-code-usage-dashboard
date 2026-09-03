import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// vite.config.js와 별도 파일로 둔다 — 빌드 설정에 테스트 전용 옵션을 섞지 않는다.
// jsx 변환은 빌드와 같은 @vitejs/plugin-react를 쓴다(플러그인을 빼면 .jsx가 파싱되지 않는다).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{js,jsx}"],
  },
});
