// URL 검색 파라미터 <-> 대시보드 상태(range + filters) 매핑. React를 import하지 않는 순수
// 모듈이라 urlState.test.js가 렌더 없이 검증한다.
//
// range는 두 가지 모양뿐이다(useApi.js가 읽는 것과 같은 모양): 프리셋이면 days 하나,
// 드래그 줌으로 만든 커스텀 구간이면 from/to(ISO). useApi가 RangeContext의 from/to가 아니라
// days/custom을 보고 자기 구간을 계산하므로, 링크에 담아야 하는 것도 그 둘이다.
//
// user는 마스킹이 켜져 있으면 URL에 절대 담지 않는다 — 값이 원본 이메일(FilterContext의 user는
// 입력창 텍스트 그대로이고 서버가 UserEmail과 매칭한다)이라, 공유 링크·브라우저 히스토리·붙여넣은
// 채팅으로 주소가 새어 나가는 경로가 된다. 해시도 절단도 아니라 생략이다.

export const PRESET_DAYS = [1, 2, 7, 14, 30, 90];

const isIso = (s) => !!s && !Number.isNaN(new Date(s).getTime());

export function parseUrlState(searchParams, { defaultDays = 2, piiMask = true } = {}) {
  const get = (k) => searchParams.get(k) || "";

  const fromRaw = get("from");
  const toRaw = get("to");
  // from/to가 둘 다 유효하고 from < to일 때만 커스텀 구간으로 본다 — 한쪽만 있거나 뒤집혀
  // 있으면 프리셋으로 접는다(서버도 from >= to를 400으로 거절한다).
  const custom =
    isIso(fromRaw) && isIso(toRaw) && new Date(fromRaw) < new Date(toRaw)
      ? { from: new Date(fromRaw), to: new Date(toRaw) }
      : null;

  const daysRaw = Number(get("days"));
  const days = PRESET_DAYS.includes(daysRaw) ? daysRaw : defaultDays;

  return {
    range: { days, custom },
    filters: {
      group: get("group"),
      user: piiMask ? "" : get("user"),
      model: get("model"),
    },
  };
}

export function serializeUrlState({ range, filters, piiMask = true }) {
  const p = new URLSearchParams();
  if (range?.custom) {
    p.set("from", range.custom.from.toISOString());
    p.set("to", range.custom.to.toISOString());
  } else if (range?.days != null) {
    p.set("days", String(range.days));
  }
  if (filters?.group) p.set("group", filters.group);
  if (filters?.model) p.set("model", filters.model);
  // 마스킹이 켜져 있으면 user는 담지 않는다(위 주석 참고).
  if (!piiMask && filters?.user) p.set("user", filters.user);
  return p;
}
