// Floating Ask Claude window size: clamped to the viewport and remembered per browser.
export const CHAT_SIZE_KEY = "ccdash.chatWindowSize";
export const DEFAULT_CHAT_SIZE = { w: 400, h: 520 };
export const MIN_CHAT_SIZE = { w: 340, h: 380 };
// The window sits 1.5rem from the right edge and 5rem above the bottom (launcher button).
const MARGIN = { w: 48, h: 112 };

export function clampChatSize(size, viewport) {
  const maxW = Math.max(MIN_CHAT_SIZE.w, viewport.w - MARGIN.w);
  const maxH = Math.max(MIN_CHAT_SIZE.h, viewport.h - MARGIN.h);
  const pick = (value, min, max, fallback) =>
    Math.round(Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback)));
  return {
    w: pick(size?.w, MIN_CHAT_SIZE.w, maxW, DEFAULT_CHAT_SIZE.w),
    h: pick(size?.h, MIN_CHAT_SIZE.h, maxH, DEFAULT_CHAT_SIZE.h),
  };
}

// Expanded preset: wide enough for chart axes, but never wider than 960px.
export function expandedChatSize(viewport) {
  return clampChatSize({ w: Math.min(960, viewport.w), h: viewport.h }, viewport);
}

// Resolve localStorage inside try: some browsers throw SecurityError from the getter itself.
export function loadChatSize(storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    const parsed = JSON.parse(store?.getItem(CHAT_SIZE_KEY) ?? "null");
    return parsed && Number.isFinite(parsed.w) && Number.isFinite(parsed.h) ? { w: parsed.w, h: parsed.h } : null;
  } catch {
    return null;
  }
}

export function saveChatSize(size, storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    store?.setItem(CHAT_SIZE_KEY, JSON.stringify({ w: size.w, h: size.h }));
  } catch {
    // Private mode or a full quota only loses the remembered size.
  }
}
