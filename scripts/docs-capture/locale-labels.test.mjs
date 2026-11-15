import assert from "node:assert/strict";
import { test } from "node:test";
import { label, message, supportedLocales } from "./locale-labels.mjs";

test("uses the dashboard catalogs for capture selectors and positional labels", () => {
  assert.deepEqual(supportedLocales, ["ko", "en", "ja", "zh-CN", "es"]);
  assert.equal(label("작업 목록 · 상위 20개", "en"), "Task list · Top 20");
  assert.equal(label("작업 목록 · 상위 20개", "ko"), "작업 목록 · 상위 20개");
  assert.equal(message("m6aca100eeed4", "en", ["macOS"]), "Select macOS");
  assert.equal(message("m6cc3cfaaaeb1", "en", ["Explore #1"]), "Explore #1 lanes");
  assert.throws(() => label("없는 캡처 레이블", "en"), /Unknown source label/);
  assert.throws(() => label("작업 상세", "unknown"), /Unsupported locale/);
});
