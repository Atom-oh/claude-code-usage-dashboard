// URL 검색 파라미터 <-> 대시보드 상태(range + filters) 매핑. React를 import하지 않는 순수
// 모듈이라 urlState.test.js가 렌더 없이 검증한다.
//
// range는 세 가지 모양뿐이다(useApi.js가 읽는 것과 같은 모양): 프리셋이면 days 하나,
// 이번 달이면 period=month, 드래그 줌·달력으로 만든 커스텀 구간이면 from/to(ISO). useApi가
// RangeContext의 from/to가 아니라 days/custom/month를 보고 자기 구간을 계산하므로, 링크에
// 담아야 하는 것도 그 셋이다.
//
// user는 마스킹이 켜져 있으면 URL에 절대 담지 않는다 — 값이 원본 이메일(FilterContext의 user는
// 입력창 텍스트 그대로이고 서버가 UserEmail과 매칭한다)이라, 공유 링크·브라우저 히스토리·붙여넣은
// 채팅으로 주소가 새어 나가는 경로가 된다. 해시도 절단도 아니라 생략이다.

export const PRESET_DAYS = [1, 2, 7, 30];

const isIso = (s) => !!s && !Number.isNaN(new Date(s).getTime());

export function parseUrlState(searchParams, { defaultDays = 2, piiMask = true } = {}) {
  const get = (k) => searchParams.get(k) || "";

  const fromRaw = get("from");
  const toRaw = get("to");
  // from/to가 둘 다 유효하고 from < to일 때만 커스텀 구간으로 본다 — 한쪽만 있거나 뒤집혀
  // 있으면 프리셋으로 접는다(서버도 from >= to를 400으로 거절한다).
  const customFrom = isIso(fromRaw) ? new Date(fromRaw) : null;
  const customTo = isIso(toRaw) ? new Date(toRaw) : null;
  // 두 경계가 모두 정확히 UTC 자정이면 달력으로 고른 구간이다 — source는 URL에 담지 않고
  // 이렇게 되살린다. 드래그 줌은 버킷 경계에서 온 값이라 자정에 걸리는 일이 사실상 없다.
  const isUtcMidnight = (d) =>
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  const custom =
    customFrom && customTo && customFrom < customTo
      ? { from: customFrom, to: customTo, source: isUtcMidnight(customFrom) && isUtcMidnight(customTo) ? "calendar" : "zoom" }
      : null;

  const daysRaw = Number(get("days"));
  const days = PRESET_DAYS.includes(daysRaw) ? daysRaw : defaultDays;
  // custom이 이기게 둔다 — from/to와 period=month가 같이 온 링크는 명시적인 구간이 우선이다.
  const month = !custom && searchParams.get("period") === "month";

  return {
    range: { days, custom, month },
    filters: {
      group: get("group"),
      user: piiMask ? "" : get("user"),
      model: get("model"),
      project: get("project"),
    },
  };
}

export function serializeUrlState({ range, filters, piiMask = true }) {
  const p = new URLSearchParams();
  if (range?.custom) {
    p.set("from", range.custom.from.toISOString());
    p.set("to", range.custom.to.toISOString());
  } else if (range?.month) {
    p.set("period", "month");
  } else if (range?.days != null) {
    p.set("days", String(range.days));
  }
  if (filters?.group) p.set("group", filters.group);
  if (filters?.model) p.set("model", filters.model);
  if (filters?.project) p.set("project", filters.project);
  // 마스킹이 켜져 있으면 user는 담지 않는다(위 주석 참고).
  if (!piiMask && filters?.user) p.set("user", filters.user);
  return p;
}
