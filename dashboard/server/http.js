// route()가 쓰는 요청 파라미터 검증 헬퍼. index.js가 아니라 별도 모듈인 이유는 index.js가
// 모듈 로드 시점에 app.listen()을 부르기 때문 — 테스트에서 import할 수 없다. 여기 있는 함수는
// 전부 순수 함수라 http.test.js가 서버를 띄우지 않고 그대로 검증한다.

// 버킷 상한 24*31시간 = 31일 한 버킷. 이보다 큰 값은 의미 있는 시계열을 만들지 못한다.
export const MAX_INTERVAL_HOURS = 24 * 31;

// 기본 구간과 상한은 서버 부팅 시 env(DEFAULT_RANGE_DAYS / RANGE_CAP_DAYS)에서 정해져
// index.js가 호출마다 넘긴다 — 예전에는 여기 하드코딩된 2일과 index.js의 WARM_DAYS,
// RangeContext.jsx의 기본 days가 서로 따라다녀야 하는 세 개의 2였다.

// 검증 실패를 내부 오류(500)와 구분하려고 상태코드를 예외에 실어 보낸다 — route()의 catch가
// 이 타입만 400으로 매핑하고 나머지는 전부 500이다.
export class ValidationError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
    this.detail = detail;
  }
}

// detail에 사용자가 보낸 값을 되돌려 담지 않는다 — 무엇이 틀렸는지만 알려준다(에러 본문이
// 임의 문자열의 반사 채널이 되지 않게).
// String() 강제: Express는 ?to=a&to=b를 배열로, ?to[x]=y를 객체로 파싱하므로 raw 값을 그대로
// new Date()에 넘기면 안 된다(index.js groupParam과 같은 규약). 빈 문자열(?to=)은 미지정과
// 같게 본다 — 기존 `req.query.to ? … : new Date()`의 동작을 그대로 유지한다.
export function parseRange(query, { defaultDays = 2, capDays = Infinity } = {}) {
  const to = query.to ? new Date(String(query.to)) : new Date();
  if (Number.isNaN(to.getTime())) {
    throw new ValidationError("invalid range", "'to' is not a valid ISO 8601 datetime");
  }
  const from = query.from ? new Date(String(query.from)) : new Date(to.getTime() - defaultDays * 86400000);
  if (Number.isNaN(from.getTime())) {
    throw new ValidationError("invalid range", "'from' is not a valid ISO 8601 datetime");
  }
  if (from.getTime() >= to.getTime()) {
    throw new ValidationError("invalid range", "'from' must be strictly earlier than 'to'");
  }
  // 상한이 없으면 인증된 클라이언트가 from을 아주 오래전으로 잡아 반복 호출하는 것만으로
  // 대형 스캔을 계속 유발할 수 있다(intervalHours 하한과 같은 종류의 신뢰 경계 문제).
  // 초과 판정은 strictly greater — 상한과 정확히 같은 길이(예: 90일 프리셋에 90일 상한)는
  // 통과해야 한다.
  if (to.getTime() - from.getTime() > capDays * 86400000) {
    throw new ValidationError("range too long", `'to' - 'from' must be at most ${capDays} days`);
  }
  return { from, to };
}

// intervalHours는 bucket() SQL의 버킷 크기로 그대로 들어간다. 예전 `Number(x) || 24`는
// "abc"와 0을 조용히 24로 바꿔 잘못된 요청을 성공처럼 응답했고, 음수/분수 음수는 그대로
// toStartOfInterval 인자까지 도달했다 — 이제 거부한다.
export function parseIntervalHours(raw, fallback = 24) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_INTERVAL_HOURS) {
    throw new ValidationError(
      "invalid intervalHours",
      `'intervalHours' must be a finite number in (0, ${MAX_INTERVAL_HOURS}]`
    );
  }
  return n;
}

// GROUP_MODE — "ab"는 bedrock/enterprise 두 채널을 나란히 비교하는 이 대시보드의 기본 모드,
// "single"은 채널이 하나인 조직용(프론트가 빈 두 번째 카드를 안 그린다). 미설정/빈 문자열은
// "ab"로 접는다 — 기존 배포가 env 없이 그대로 돌아야 한다. 대소문자는 관대하게 받지 않는다:
// "AB"를 조용히 통과시키면 오타 "sngle"도 통과시켜야 논리가 맞고, 부팅 시 거부가 더 안전하다.
export function parseGroupMode(raw) {
  if (raw === undefined || raw === "") return "ab";
  if (raw === "ab" || raw === "single") return raw;
  throw new Error(`GROUP_MODE must be "ab" or "single", got "${raw}"`);
}

// 부팅 시 읽는 정수 env용. Number(x) || fallback은 "abc"와 0을 조용히 fallback으로 바꿔
// 오설정을 성공처럼 만든다(parseIntervalHours 위 주석과 같은 이유) — 여기서는 throw한다.
export function parsePositiveInt(raw, fallback, { min = 1 } = {}) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}
