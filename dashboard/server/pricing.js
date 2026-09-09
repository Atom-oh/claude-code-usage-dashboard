// Bedrock/Anthropic per-1M-token USD 단가. 캐시 배율은 cacheWrite(5m) = 입력×1.25,
// cacheWrite1h = 입력×2, cacheRead = 입력×0.1 — 단 fable-5-1/mythos-5-1은 cacheRead가
// 0.025x인 예외라 값을 명시한다(아래 주석). Bedrock cross-region(us./us-gov./eu./apac./jp./au./
// global.) 추론 프로파일은 기본 모델과 동일 단가.
//
// 캐시 쓰기 TTL은 "그룹별 정책"이다(2026-09-09, ADR-008). OTel의 token.usage cacheCreation
// TokenType은 5m/1h 티어를 구분하지 않아 토큰 단위로는 어느 티어인지 알 수 없고, 어느 티어가
// 맞는지는 세션이 어떤 채널로 인증했는지에 달려 있다 — Claude Code의 promptCacheTtl 기본값이
// 구독(Enterprise 로그인)은 1h, Bedrock/API 키는 5m이다(설정 스키마 원문 + 2026-09-07 한화
// 이벤트 실측: Bedrock 응답의 cache_creation이 전량 ephemeral_5m, 대시보드 1h 가정 대비 +17.72%
// 과대계상). 그래서 기본 정책은 bedrock → 5m, enterprise → 1h이고, 그룹별 env로 덮어쓴다.
// 워크샵 CFN이 ccb의 promptCacheTtl을 1h로 고정하는 순간부터는 bedrock도 1h가 정답이 되므로,
// 그룹 값은 단일 티어뿐 아니라 "전환 시각이 있는 스케줄"(예: "5m,2026-09-09T00:00:00Z=1h")을
// 받는다 — 전환 시각을 걸치는 조회 구간은 queries.js가 그 시각에서 쪼개 각각 단가를 매긴다.
// 남는 알려진 오차 하나: 구독 채널의 서브에이전트/헬퍼 호출은 5m인데(subagentPromptCacheTtl
// 기본값) 롤업에 query_source가 없어 메인 대화와 분리하지 못한다 — enterprise 1h 가정이 그
// 분량을 다소 과대계상한다(ADR-008에 기록, 후속: rollup에 QuerySource 승격).
// sonnet-5 단가 보정(실측: Claude Enterprise 청구서 대조): 기존 $3/$15 → $2/$10. 구 단가로는
// 계산 비용이 실제 청구의 1.5배로 과대계상되고 있었다.
// [1m] 접미사 제거는 단가 갭이 아님: Claude 4.6+ 모델은 1M 컨텍스트 전체가 표준 단가
// (2026-09-02 pricing 페이지 확인).
const BASE_PRICING = {
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-haiku-3-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  // fable-5-1 / mythos-5-1: cache read $0.25 (0.025x 예외, 2026-09-02 pricing 페이지 확인)
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  "claude-mythos-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  "claude-opus-4-1": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

// 그룹별 env가 없을 때의 내장 정책 — 값의 근거는 파일 헤더 주석. 전역 PRICING_CACHE_WRITE_TTL을
// 명시적으로 설정하면 그 값이 이 내장 정책보다 우선한다("전부 한 티어" 예전 의미를 보존).
const DEFAULT_GROUP_TTL = { bedrock: "5m", enterprise: "1h" };
const GROUP_ENV = { bedrock: "PRICING_CACHE_WRITE_TTL_BEDROCK", enterprise: "PRICING_CACHE_WRITE_TTL_ENTERPRISE" };
const TTL_VALUES = ["1h", "5m"];

// us.anthropic.claude-sonnet-4-5-20250929-v1:0 / global.anthropic.claude-opus-4-8
// / anthropic.claude-* / claude-sonnet-4-5-20250929 / claude-fable-5[1m] → 단가표 key
export function normalizeModelId(raw) {
  return String(raw || "")
    .replace(/\[[^\]]*\]$/, "") // [1m] 컨텍스트 윈도우 접미사
    .replace(/^(?:us|us-gov|eu|apac|jp|au|global)\./, "") // cross-region 추론 프로파일 접두사
    .replace(/^anthropic\./, "") // bedrock provider 접두사
    .replace(/-v\d+(?::\d+)?$/, "") // bedrock 버전 접미사 -v1:0 / -v1
    .replace(/-\d{8}$/, ""); // 날짜 스냅샷 접미사 -20250929
}

// "5m" | "1h" | "5m,2026-09-09T00:00:00Z=1h,..." → [{since: null|Date, ttl}] (since 오름차순).
// 전환 시각은 타임존이 명시된 ISO-8601이어야 하고(Z 또는 ±hh:mm — 로컬 시간 해석 금지) UTC
// 정각이어야 한다 — queries.js가 이 시각에서 조회 구간을 쪼개는데, 롤업(otel_metrics_sum_hourly)은
// hour 그레인이라 정각이 아닌 경계는 최대 59분의 부분-버킷 오차를 만든다(incFlat 위 주석 참고).
export function parseCacheWriteTtlSchedule(raw, envName) {
  const entries = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (entries.length === 0) throw new Error(`${envName} must be "1h", "5m" or a schedule like "5m,2026-09-09T00:00:00Z=1h"`);
  const out = [];
  for (const [i, entry] of entries.entries()) {
    const eq = entry.indexOf("=");
    const ttl = eq === -1 ? entry : entry.slice(eq + 1);
    if (!TTL_VALUES.includes(ttl)) throw new Error(`${envName}: cache-write TTL must be "1h" or "5m", got "${ttl}"`);
    if (eq === -1) {
      if (i !== 0) throw new Error(`${envName}: only the first schedule entry may omit the "<instant>=" prefix, got "${entry}"`);
      out.push({ since: null, ttl });
      continue;
    }
    const instant = entry.slice(0, eq);
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(instant)) throw new Error(`${envName}: "${instant}" needs an explicit timezone (Z or ±hh:mm)`);
    const since = new Date(instant);
    if (Number.isNaN(since.getTime())) throw new Error(`${envName}: "${instant}" is not an ISO-8601 instant`);
    if (since.getUTCMinutes() !== 0 || since.getUTCSeconds() !== 0 || since.getUTCMilliseconds() !== 0) {
      throw new Error(`${envName}: "${instant}" must be on a UTC hour boundary (the hourly rollup cannot split a bucket)`);
    }
    const prev = out[out.length - 1];
    if (prev && prev.since !== null && since <= prev.since) throw new Error(`${envName}: schedule instants must be strictly increasing, "${instant}" is not`);
    if (!prev) throw new Error(`${envName}: the first schedule entry must be the initial TTL without an instant (e.g. "5m,${instant}=${ttl}")`);
    out.push({ since, ttl });
  }
  return out;
}

// env(테스트 가능하도록 process.env를 직접 읽지 않고 인자로만 받음)로부터 실효 단가표를 만든다.
// PRICING_CACHE_WRITE_TTL*과 PRICING_JSON을 여기서 한 번만 파싱 — 두 번째 파싱 경로를 만들지 않는다.
export function buildPricing(env) {
  const ttlRaw = env.PRICING_CACHE_WRITE_TTL;
  let cacheWriteTtl = "1h";
  const globalSet = ttlRaw !== undefined && ttlRaw !== "";
  if (globalSet) {
    if (!TTL_VALUES.includes(ttlRaw)) {
      throw new Error(`PRICING_CACHE_WRITE_TTL must be "1h" or "5m", got "${ttlRaw}"`);
    }
    cacheWriteTtl = ttlRaw;
  }
  // 우선순위: 그룹별 env > 명시된 전역 env > 내장 그룹 정책(bedrock 5m / enterprise 1h).
  // 그룹 정책이 없는 그룹(unknown, group 컬럼이 없는 행)은 전역 값을 쓴다.
  const cacheWriteTtlByGroup = {};
  for (const [group, envName] of Object.entries(GROUP_ENV)) {
    const raw = env[envName];
    if (raw !== undefined && raw !== "") cacheWriteTtlByGroup[group] = parseCacheWriteTtlSchedule(raw, envName);
    else cacheWriteTtlByGroup[group] = [{ since: null, ttl: globalSet ? cacheWriteTtl : DEFAULT_GROUP_TTL[group] }];
  }

  // 리터럴을 깊은 복사 후 cacheWrite1h를 파생 — buildPricing을 여러 번 호출해도 BASE_PRICING을
  // 공유 오염시키지 않는다(테스트가 같은 프로세스에서 반복 호출).
  const table = {};
  for (const [model, p] of Object.entries(BASE_PRICING)) {
    table[model] = { ...p, cacheWrite1h: p.input * 2 };
  }

  const overriddenModels = [];
  const jsonRaw = env.PRICING_JSON;
  if (jsonRaw !== undefined && jsonRaw !== "") {
    let parsed;
    try {
      parsed = JSON.parse(jsonRaw);
    } catch (err) {
      throw new Error(`PRICING_JSON is not valid JSON: ${err.message}`);
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("PRICING_JSON must be a JSON object of model key → rates");
    }
    for (const [key, row] of Object.entries(parsed)) {
      // 정규화되지 않은 key는 priceFor()의 PRICING[normalizeModelId(model)] 조회에서 절대
      // 매치되지 않아 오버라이드가 조용히 무시된다 — R2가 금지하는 "조용한 오가격" 그 자체이므로
      // 문서화만 하지 않고 하드 에러로 막는다.
      const normalized = normalizeModelId(key);
      if (normalized !== key) {
        throw new Error(`PRICING_JSON key "${key}" must be the normalized model id "${normalized}"`);
      }
      if (row === null || Array.isArray(row) || typeof row !== "object") {
        throw new Error(`PRICING_JSON["${key}"] must be an object of rates`);
      }
      if (typeof row.input !== "number" || !Number.isFinite(row.input) || typeof row.output !== "number" || !Number.isFinite(row.output)) {
        throw new Error(`PRICING_JSON["${key}"] requires numeric input and output`);
      }
      for (const field of ["input", "output", "cacheWrite", "cacheRead", "cacheWrite1h"]) {
        if (row[field] === undefined) continue;
        if (typeof row[field] !== "number" || !Number.isFinite(row[field]) || row[field] < 0) {
          throw new Error(`PRICING_JSON["${key}"].${field} must be a non-negative number`);
        }
      }
      // ??(not ||): cacheWrite/cacheRead/cacheWrite1h에 값 0을 명시적으로 설정(무료/프로모션
      // 티어)해도 그대로 살아남아야 한다.
      table[key] = {
        input: row.input,
        output: row.output,
        cacheWrite: row.cacheWrite ?? row.input * 1.25,
        cacheRead: row.cacheRead ?? row.input * 0.1,
        cacheWrite1h: row.cacheWrite1h ?? row.input * 2,
      };
      overriddenModels.push(key);
    }
  }

  return { table, cacheWriteTtl, cacheWriteTtlByGroup, overriddenModels };
}

const {
  table: PRICING,
  cacheWriteTtl: CACHE_WRITE_TTL,
  cacheWriteTtlByGroup: CACHE_WRITE_TTL_BY_GROUP,
  overriddenModels: OVERRIDDEN_MODELS,
} = buildPricing(process.env);

// /api/config가 그대로 내려주는 값 — 단가(negotiated rate)는 고객의 사업 조건이라 절대 노출하지
// 않고, TTL 정책과 오버라이드된 모델 key 목록만 노출한다(R5: no secrets). since는 ISO 문자열.
export const pricingConfig = {
  cacheWriteTtl: CACHE_WRITE_TTL,
  cacheWriteTtlByGroup: Object.fromEntries(
    Object.entries(CACHE_WRITE_TTL_BY_GROUP).map(([g, sched]) => [g, sched.map((e) => ({ since: e.since ? e.since.toISOString() : null, ttl: e.ttl }))])
  ),
  overriddenModels: OVERRIDDEN_MODELS,
};

// ClickHouse 드라이버는 DateTime을 타임존 없는 'YYYY-MM-DD HH:MM:SS' 문자열로 돌려준다 —
// new Date()에 그대로 넣으면 V8이 로컬 시간으로 해석하므로 UTC로 고정해서 읽는다(서버 TZ가
// UTC가 아닌 로컬 개발 환경에서 TTL 전환 판정이 시간대만큼 밀리는 것을 막는다).
export function toInstant(v) {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  const s = String(v);
  return new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(s) ? s : s.replace(" ", "T") + "Z");
}

function resolveTtl(schedule, at) {
  let ttl = schedule[0].ttl;
  for (const e of schedule) if (e.since === null || e.since <= at) ttl = e.ttl;
  return ttl;
}

// 그룹 + 시각 → 이 행의 cache_write_tokens에 적용할 TTL 티어. group이 없거나 정책이 없는
// 그룹(unknown)은 전역 값. at 생략 시 "지금"의 정책 — 시각 정보가 없는 호출자는 반드시 구간
// 시작 시각을 넘겨야 한다(queries.js가 전환 시각에서 구간을 쪼개므로 구간 시작 하나로 충분).
export function cacheWriteTtlFor(group, at = new Date()) {
  const schedule = CACHE_WRITE_TTL_BY_GROUP[group];
  if (!schedule) return CACHE_WRITE_TTL;
  return resolveTtl(schedule, toInstant(at));
}

// 모든 그룹 정책의 전환 시각(중복 제거, 오름차순). queries.js의 acrossTtlSegments가 조회 구간을
// 이 시각들에서 쪼갠다 — 어느 그룹의 전환이든 한 SQL이 두 그룹을 함께 집계하므로 전부 쪼갠다.
export function cacheWriteTtlBoundaries() {
  const ms = new Set();
  for (const sched of Object.values(CACHE_WRITE_TTL_BY_GROUP)) for (const e of sched) if (e.since) ms.add(e.since.getTime());
  return [...ms].sort((a, b) => a - b).map((t) => new Date(t));
}

// [from, to)를 boundaries 중 구간 "안"에 있는 시각에서 쪼갠다(경계와 같은 시각은 쪼갤 게 없다).
// 순수 함수 — queries.js가 cacheWriteTtlBoundaries()를 넘긴다.
export function ttlSegments(from, to, boundaries) {
  const edges = [from, ...boundaries.filter((d) => d > from && d < to), to];
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) out.push({ from: edges[i], to: edges[i + 1] });
  return out;
}

// 구간을 쪼개 각각 단가를 매긴 행 집합들을 키 컬럼 단위로 다시 합친다. 누적 카운터의 구간 diff는
// 인접 구간에 대해 가산적이라(diff[a,c) = diff[a,b) + diff[b,c)) 토큰/보고비용/세션 수는 그냥
// 더하면 되고, cost는 각 조각이 자기 TTL 단가로 이미 계산돼 있으니 역시 더한다 — 합친 뒤 토큰에
// 단가를 다시 곱으면 안 된다(조각마다 단가가 다르다). 드라이버가 집계값을 문자열로 돌려주는
// 경우가 있어 숫자형 문자열도 더한다(rollupComputedCost와 동일 이유).
export function mergeSegments(parts, keys) {
  const out = new Map();
  const numeric = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
  for (const r of parts.flat()) {
    const k = keys.map((key) => String(r[key])).join(" ");
    const acc = out.get(k);
    if (!acc) {
      out.set(k, { ...r });
      continue;
    }
    for (const [field, v] of Object.entries(r)) {
      if (keys.includes(field)) continue;
      if (field === "unpriced") acc.unpriced = Boolean(acc.unpriced) || Boolean(v);
      else if (field === "cache_write_ttl") {
        if (acc.cache_write_ttl == null) acc.cache_write_ttl = v;
        else if (v != null && v !== acc.cache_write_ttl) acc.cache_write_ttl = "mixed";
      } else if (v === null || acc[field] === null) acc[field] = null;
      else if (numeric(v) && numeric(acc[field])) acc[field] = Number(acc[field]) + Number(v);
    }
  }
  return [...out.values()];
}

const rateFor = (p, ttl) => (ttl === "1h" ? p.cacheWrite1h : p.cacheWrite);

// Ask Claude 챗의 SYSTEM 프롬프트(chat.js)가 이 문자열을 그대로 인용한다 — Cost 페이지 카드가
// 보여주는 "계산 비용"(withComputedCost, 아래)과 챗이 답하는 비용이 서로 다른 숫자를 쓰게
// 드리프트하지 않도록, 단가를 PRICING에서만 유지하고 여기서 렌더링만 한다.
// cacheWrite는 두 티어를 다 적고 어느 그룹이 어느 티어인지 정책 줄로 못 박는다 — 티어가 그룹에
// 따라 갈리므로 열 하나로는 계산 공식을 쓸 수 없다(chat.js의 공식 문단이 이 정책 줄을 참조).
function renderSchedule(sched) {
  return sched.map((e) => (e.since ? `${e.since.toISOString()}부터 ${e.ttl}` : e.ttl)).join(", ");
}
export const PRICING_PROMPT_TABLE =
  Object.entries(PRICING)
    .map(([model, p]) => `${model}: input $${p.input}, output $${p.output}, cacheWrite5m $${p.cacheWrite}, cacheWrite1h $${p.cacheWrite1h}, cacheRead $${p.cacheRead} (1M 토큰당 USD)`)
    .join("\n") +
  `\n캐시 쓰기 TTL 정책(세션 그룹 grp 기준 — 캐시 쓰기 토큰에 cacheWrite5m/cacheWrite1h 중 어느 열을 곱할지): ` +
  Object.entries(CACHE_WRITE_TTL_BY_GROUP)
    .map(([g, sched]) => `${g} → ${renderSchedule(sched)}`)
    .join("; ") +
  `; 그 외(unknown) → ${CACHE_WRITE_TTL}` +
  `\n(서버 env PRICING_CACHE_WRITE_TTL / PRICING_CACHE_WRITE_TTL_BEDROCK / PRICING_CACHE_WRITE_TTL_ENTERPRISE — 전환 시각이 있는 정책은 그 시각 전후로 나눠 계산)`;

export function priceFor(model) {
  return PRICING[normalizeModelId(model)] || null;
}

// 행의 TTL 판정 시각 — opts.at은 Date 또는 (row) => Date|string. costByModelDaily처럼 행마다
// 버킷 시각이 있으면 함수를, 스냅샷 쿼리는 구간 시작 Date를 넘긴다.
const atOf = (opts, r) => (typeof opts.at === "function" ? opts.at(r) : opts.at);

// Cost 페이지 "캐시 티어별 지출" 카드용 — costByModel() 같은 행 배열(모델별 4토큰 합계)을 받아
// 토큰 티어(비캐시 입력/캐시 읽기/캐시 쓰기/출력) 단위로 $ 총합을 묶는다. 단가표에 없는 모델은
// 조용히 건너뛴다(withComputedCost의 unpriced 플래그와 동일 정책 — 전체가 깨지지 않게).
// 이미 withComputedCost를 거친 행(cache_write_cost 보유)은 그 값을 그대로 쓴다 — 전환 시각을
// 걸쳐 합쳐진 행은 토큰 합계에 단가 하나를 곱해서는 복원할 수 없기 때문.
export function tierCosts(rows, opts = {}) {
  const t = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const r of rows) {
    const p = priceFor(r.model);
    if (!p) continue;
    t.uncachedInput += (Number(r.input_tokens) * p.input) / 1e6;
    t.cacheRead += (Number(r.cache_read_tokens) * p.cacheRead) / 1e6;
    t.cacheWrite +=
      r.cache_write_cost !== undefined && r.cache_write_cost !== null
        ? Number(r.cache_write_cost)
        : (Number(r.cache_write_tokens) * rateFor(p, cacheWriteTtlFor(r.group, atOf(opts, r)))) / 1e6;
    t.output += (Number(r.output_tokens) * p.output) / 1e6;
  }
  return t;
}

// tierCosts()를 bedrock/enterprise로 나눠서 — costByModel()이 이미 group 컬럼을 갖고 있으니
// 그룹별로 필터링만 하면 된다. bedrock/enterprise 사용자의 캐시 티어 지출 구성비를 나란히 비교.
export function tierCostsByGroup(rows, opts = {}) {
  return {
    bedrock: tierCosts(rows.filter((r) => r.group === "bedrock"), opts),
    enterprise: tierCosts(rows.filter((r) => r.group === "enterprise"), opts),
  };
}

// rows는 input_tokens/output_tokens/cache_read_tokens/cache_write_tokens를 갖고 있어야 한다.
// cost(계산 비용, 미산정 모델이면 null) + unpriced 플래그 + 이 행에 적용한 cache_write_ttl과
// 그 항의 금액 cache_write_cost를 추가한다(TTL 가정을 API 응답에서 바로 볼 수 있게 — 2026-09-09
// 비용 오차 분석이 이 값을 역산으로 추정해야 했다). reported_cost는 그대로 통과.
export function withComputedCost(rows, opts = {}) {
  return rows.map((r) => {
    const p = priceFor(r.model);
    if (!p) return { ...r, cost: null, unpriced: true, cache_write_ttl: null, cache_write_cost: null };
    const ttl = cacheWriteTtlFor(r.group, atOf(opts, r));
    const cacheWriteCost = (Number(r.cache_write_tokens) * rateFor(p, ttl)) / 1e6;
    const cost =
      (Number(r.input_tokens) * p.input + Number(r.output_tokens) * p.output + Number(r.cache_read_tokens) * p.cacheRead) / 1e6 +
      cacheWriteCost;
    return { ...r, cost, unpriced: false, cache_write_ttl: ttl, cache_write_cost: cacheWriteCost };
  });
}

// effortMix/agentCost처럼 "그룹 컬럼 × model" 그레인으로 나온 쿼리 결과를 그룹 컬럼(keys) 단위로
// 접는다. 단가 계산(withComputedCost)은 반드시 접기 전에 끝나야 한다 — model 컬럼이 사라진
// 뒤에는 어느 단가를 쓸지 고를 수 없다. 그래서 SQL에서 바로 합계를 내지 않고 두 단계로 나눈다.
// 단가표에 없는 모델은 cost에 0을 더하고(null이 아니다 — 합계가 null이 되면 도넛/표가 통째로
// 비어 버린다) tokens/unpriced_tokens/reported_cost에는 그대로 반영한다.
export function rollupComputedCost(rows, keys, opts = {}) {
  const out = new Map();
  for (const r of withComputedCost(rows, opts)) {
    // 구분자는 " "(NUL) — agent 이름은 Attributes['agent.name']에서 온 자유 문자열이라 공백을
    // 포함할 수 있고, 공백을 구분자로 쓰면 ("a", "b c")와 ("a b", "c")가 한 키로 뭉개진다(실측).
    const k = keys.map((key) => String(r[key])).join(" ");
    let acc = out.get(k);
    if (!acc) {
      acc = {};
      for (const key of keys) acc[key] = r[key];
      Object.assign(acc, { cost: 0, reported_cost: 0, tokens: 0, unpriced_tokens: 0 });
      out.set(k, acc);
    }
    // 드라이버가 집계값을 문자열로 돌려주는 경우가 있어 전부 Number()로 강제한다 — 빠뜨리면
    // += 가 문자열 연결이 되어 "37" 같은 값이 나온다.
    const tokens =
      Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens);
    if (!r.unpriced) acc.cost += Number(r.cost);
    acc.reported_cost += Number(r.reported_cost);
    acc.tokens += tokens;
    if (r.unpriced) acc.unpriced_tokens += tokens;
  }
  return [...out.values()];
}
