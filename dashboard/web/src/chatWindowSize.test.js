import { expect, test } from "vitest";
import { CHAT_SIZE_KEY, DEFAULT_CHAT_SIZE, MIN_CHAT_SIZE, clampChatSize, expandedChatSize, loadChatSize, saveChatSize } from "./chatWindowSize.js";

const memory = (initial = {}) => {
  const data = { ...initial };
  return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
};

test("sizes are clamped between the minimum and the viewport minus the window margins", () => {
  const viewport = { w: 1280, h: 800 };
  expect(clampChatSize({ w: 100, h: 100 }, viewport)).toEqual(MIN_CHAT_SIZE);
  expect(clampChatSize({ w: 5000, h: 5000 }, viewport)).toEqual({ w: 1232, h: 688 });
  expect(clampChatSize({ w: 640.4, h: 600.6 }, viewport)).toEqual({ w: 640, h: 601 });
});

test("invalid sizes fall back to the default and tiny viewports keep the minimum", () => {
  expect(clampChatSize({ w: NaN, h: undefined }, { w: 1280, h: 800 })).toEqual(DEFAULT_CHAT_SIZE);
  expect(clampChatSize(DEFAULT_CHAT_SIZE, { w: 300, h: 300 })).toEqual(MIN_CHAT_SIZE);
});

test("the expanded preset is wide enough for charts but capped at 960px", () => {
  expect(expandedChatSize({ w: 1920, h: 1080 })).toEqual({ w: 960, h: 968 });
  expect(expandedChatSize({ w: 800, h: 700 })).toEqual({ w: 752, h: 588 });
});

test("the remembered size round-trips and malformed storage is ignored", () => {
  const storage = memory();
  saveChatSize({ w: 720, h: 640 }, storage);
  expect(JSON.parse(storage.data[CHAT_SIZE_KEY])).toEqual({ w: 720, h: 640 });
  expect(loadChatSize(storage)).toEqual({ w: 720, h: 640 });
  expect(loadChatSize(memory({ [CHAT_SIZE_KEY]: "{not json" }))).toBeNull();
  expect(loadChatSize(memory({ [CHAT_SIZE_KEY]: '{"w":"wide"}' }))).toBeNull();
  expect(() => saveChatSize({ w: 1, h: 1 }, { setItem: () => { throw new Error("quota"); } })).not.toThrow();
});
