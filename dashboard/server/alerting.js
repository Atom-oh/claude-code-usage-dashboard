// 텔레메트리가 멈춘 걸 화면 밖으로 밀어내는 발신 경로. /api/health/data는 이미 stale/unknown을
// 503으로 알리지만 아무도 폴링하지 않으면 조용하다 — README "Telemetry Ingestion"이 기록한
// ~43시간 공백이 정확히 그 상태였다(대시보드는 정상, 데이터 창만 줄어듦).
//
// ALERT_WEBHOOK_URL이 없으면 이 모듈은 아무것도 하지 않는다: index.js가 startAlertLoop을
// 아예 부르지 않으므로 타이머도 import 시점 부작용도 없다(app.test.js가 index.js를 import한다).

// 웹훅 URL에는 토큰이 들어 있다 — 어떤 로그 줄에도 들어가면 안 된다. 아래 console.warn이
// 상태코드/에러 이름만 찍는 이유다.
export function formatAlert(kind, snapshot, { hostname } = {}) {
  const host = hostname || "unknown-host";
  if (kind === "recovered") {
    return `[ccdash] telemetry recovered on ${host}: last row ${snapshot.ageMinutes} min ago`;
  }
  const label = snapshot.status === "unknown" ? "UNKNOWN" : "STALE";
  const head = kind === "repeat" ? `still ${label}` : label;
  const detail =
    snapshot.status === "unknown"
      ? "ClickHouse probe failed or no rows in the probe window"
      : `last row ${snapshot.ageMinutes} min ago (threshold ${snapshot.staleAfterMinutes})`;
  return `[ccdash] telemetry ${head} on ${host}: ${detail}. See docs/runbooks/alerting.md`;
}

export const initialAlertState = () => ({ status: null, notOkTicks: 0, lastSentMs: 0, alerted: false });

// 두 틱 연속 non-ok에서만 발송한다(디바운스). 롤아웃 중 파드가 ClickHouse보다 먼저 뜨거나
// DNS가 한 번 튀는 것만으로 호출기가 울리면 아무도 이 알림을 신뢰하지 않게 되고, 그러면
// 이 기능이 막으려던 43시간 공백을 다시 놓친다.
//
// 순수 함수다: state를 변형하지 않고 새 객체를 돌려준다 — 테스트가
// `state = planAlert(state, …).state`로 직접 굴린다.
export function planAlert(state, snapshot, nowMs, repeatMs, { hostname } = {}) {
  const next = { ...state, status: snapshot.status };
  const say = (kind) => formatAlert(kind, snapshot, { hostname });
  if (snapshot.status === "ok") {
    next.notOkTicks = 0;
    if (state.alerted) {
      next.alerted = false;
      next.lastSentMs = nowMs;
      return { state: next, message: say("recovered") };
    }
    return { state: next, message: null };
  }
  next.notOkTicks = state.notOkTicks + 1;
  if (!state.alerted && next.notOkTicks >= 2) {
    next.alerted = true;
    next.lastSentMs = nowMs;
    return { state: next, message: say("firing") };
  }
  // 한 건의 장애 안에서 stale↔unknown이 오가도 두 번째 firing은 없다 — 같은 사건이다.
  if (state.alerted && nowMs - state.lastSentMs >= repeatMs) {
    next.lastSentMs = nowMs;
    return { state: next, message: say("repeat") };
  }
  return { state: next, message: null };
}

// 절대 throw하지 않는다: 알림 발송 실패가 대시보드 프로세스를 흔들면 안 된다.
export async function postWebhook(url, text, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ac.signal,
    });
    if (res.ok) return true;
    console.warn(`alert webhook failed: ${res.status}`);
    return false;
  } catch (err) {
    console.warn(`alert webhook failed: ${err.name}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// tick/stop을 돌려주는 이유: 테스트가 타이머를 기다리지 않고 tick()을 직접 굴릴 수 있어야 한다.
// 첫 tick은 60초 뒤다 — 여기서 즉시 한 번 부르면 ClickHouse가 아직 응답하지 않는 부팅 직후
// 상태를 매 롤아웃마다 알림으로 내보내게 된다.
export function startAlertLoop({
  url,
  getSnapshot,
  hostname,
  repeatMs,
  intervalMs = 60_000,
  fetchImpl,
  now = Date.now,
}) {
  let state = initialAlertState();
  const tick = async () => {
    const snapshot = await getSnapshot();
    const planned = planAlert(state, snapshot, now(), repeatMs, { hostname });
    state = planned.state;
    if (planned.message) await postWebhook(url, planned.message, { fetchImpl });
  };
  const timer = setInterval(() => {
    tick().catch(() => {});
  }, intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
