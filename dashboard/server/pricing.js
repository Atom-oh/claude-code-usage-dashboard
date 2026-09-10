// Bedrock/Anthropic per-1M-token USD 단가. 캐시 배율은 cacheWrite(5m) = 입력×1.25,
// cacheWrite1h = 입력×2, cacheRead = 입력×0.1 — 단 fable-5-1/mythos-5-1은 cacheRead가
// 0.025x인 예외라 값을 명시한다(아래 주석). Bedrock cross-region(us./us-gov./eu./apac./jp./au./
// global.) 추론 프로파일은 기본 모델과 동일 단가.
// 캐시 쓰기 TTL 기본값 "1h"는 과거 운영 조사(2026-09-01/02: opus-5 메인 스레드 $10/M)를
// 바탕으로 유지하는 계산 비용의 진단 가정이다. 모든 요청이나 메인 스레드의 실제 청구 TTL을
// 보장하지 않으며, 5m·혼합 TTL 요청에는 과대계상할 수 있다. PRICING_CACHE_WRITE_TTL=5m은
// 대체 계산 가정이고 공급자 TTL 설정을 변경하지 않는다.
// OTel의 token.usage cacheCreation TokenType은 5m/1h 티어를 구분하지 않으므로, 토큰 단위로 어느
// 티어인지 알 수 없다 — 그래서 위와 같은 명시적 가정이 필요하다.
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

// env(테스트 가능하도록 process.env를 직접 읽지 않고 인자로만 받음)로부터 실효 단가표를 만든다.
// PRICING_CACHE_WRITE_TTL과 PRICING_JSON을 여기서 한 번만 파싱 — 두 번째 파싱 경로를 만들지 않는다.
export function buildPricing(env) {
  const ttlRaw = env.PRICING_CACHE_WRITE_TTL;
  let cacheWriteTtl = "1h";
  if (ttlRaw !== undefined && ttlRaw !== "") {
    if (ttlRaw !== "1h" && ttlRaw !== "5m") {
      throw new Error(`PRICING_CACHE_WRITE_TTL must be "1h" or "5m", got "${ttlRaw}"`);
    }
    cacheWriteTtl = ttlRaw;
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

  return { table, cacheWriteTtl, overriddenModels };
}

const { table: PRICING, cacheWriteTtl: CACHE_WRITE_TTL, overriddenModels: OVERRIDDEN_MODELS } =
  buildPricing(process.env);

// /api/config가 그대로 내려주는 값 — 단가(negotiated rate)는 고객의 사업 조건이라 절대 노출하지
// 않고, TTL 가정과 오버라이드된 모델 key 목록만 노출한다(R5: no secrets).
export const pricingConfig = { cacheWriteTtl: CACHE_WRITE_TTL, overriddenModels: OVERRIDDEN_MODELS };

// cache_write_tokens에 실제로 적용할 단가 — tierCosts/withComputedCost가 서로 다른 숫자를 쓰지
// 않도록 단일 헬퍼로 통일.
const effectiveCacheWrite = (p) => (CACHE_WRITE_TTL === "1h" ? p.cacheWrite1h : p.cacheWrite);

// Ask Claude 챗의 SYSTEM 프롬프트(chat.js)가 이 문자열을 그대로 인용한다 — Cost 페이지 카드가
// 보여주는 "계산 비용"(withComputedCost, 아래)과 챗이 답하는 비용이 서로 다른 숫자를 쓰게
// 드리프트하지 않도록, 단가를 PRICING에서만 유지하고 여기서 렌더링만 한다.
// cacheWrite 열은 실효 단가(effectiveCacheWrite) — cacheWrite1h를 별도 열로 추가하면 모델이
// 두 숫자 중 하나를 골라야 해서 chat.js의 "cacheCreation → cacheWrite" 공식이 깨진다.
export const PRICING_PROMPT_TABLE =
  Object.entries(PRICING)
    .map(([model, p]) => `${model}: input $${p.input}, output $${p.output}, cacheWrite $${effectiveCacheWrite(p)}, cacheRead $${p.cacheRead} (1M 토큰당 USD)`)
    .join("\n") +
  `\n(위 cacheWrite는 캐시 쓰기 TTL 가정 "${CACHE_WRITE_TTL}" 기준 단가다 — 서버 env PRICING_CACHE_WRITE_TTL로 1h/5m 전환)`;

export function priceFor(model) {
  return PRICING[normalizeModelId(model)] || null;
}

const hasTokens = (row) =>
  ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "tokens"].some((key) => Number(row[key]) > 0);

function parseReportedAmount(value) {
  if (typeof value === "string") {
    value = value.trim();
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
    value = Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function reportedCost(row, field = "reported_cost") {
  const amount = parseReportedAmount(row[field]);
  if (amount === null) return { display_cost: null, reported_cost_status: "unavailable" };
  // sumIf returns zero when the reported series is absent, so tokens make a zero ambiguous.
  if (amount === 0 && hasTokens(row)) return { display_cost: null, reported_cost_status: "unverified_zero" };
  return { display_cost: amount, reported_cost_status: "reported" };
}

export function sumReportedCost(rows) {
  let reported = 0;
  let display = 0;
  let available = false;
  let partial = false;
  for (const row of rows) {
    reported += parseReportedAmount(row.reported_cost) ?? 0;
    const selected = Object.hasOwn(row, "display_cost") ? row : reportedCost(row);
    if (selected.display_cost == null) {
      if (hasTokens(row) || selected.reported_cost_status === "partial") partial = true;
    } else {
      available = true;
      display += selected.display_cost;
    }
  }
  if (!Number.isFinite(display)) partial = true;
  return {
    reported_cost: Number.isFinite(reported) ? reported : null,
    display_cost: !partial && available ? display : null,
    reported_cost_status: partial ? "partial" : available ? "reported" : "unavailable",
  };
}

// Cost 페이지 "캐시 티어별 지출" 카드용 — costByModel() 같은 행 배열(모델별 4토큰 합계)을 받아
// 토큰 티어(비캐시 입력/캐시 읽기/캐시 쓰기/출력) 단위로 $ 총합을 묶는다. 단가표에 없는 모델은
// 조용히 건너뛴다(withComputedCost의 unpriced 플래그와 동일 정책 — 전체가 깨지지 않게).
export function tierCosts(rows) {
  const t = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const r of rows) {
    const p = priceFor(r.model);
    if (!p) continue;
    t.uncachedInput += (Number(r.input_tokens) * p.input) / 1e6;
    t.cacheRead += (Number(r.cache_read_tokens) * p.cacheRead) / 1e6;
    t.cacheWrite += (Number(r.cache_write_tokens) * effectiveCacheWrite(p)) / 1e6;
    t.output += (Number(r.output_tokens) * p.output) / 1e6;
  }
  return t;
}

// tierCosts()를 bedrock/enterprise로 나눠서 — costByModel()이 이미 group 컬럼을 갖고 있으니
// 그룹별로 필터링만 하면 된다. bedrock/enterprise 사용자의 캐시 티어 지출 구성비를 나란히 비교.
export function tierCostsByGroup(rows) {
  return {
    bedrock: tierCosts(rows.filter((r) => r.group === "bedrock")),
    enterprise: tierCosts(rows.filter((r) => r.group === "enterprise")),
  };
}

// rows는 input_tokens/output_tokens/cache_read_tokens/cache_write_tokens를 갖고 있어야 한다.
// cost(계산 비용, 미산정 모델이면 null) + unpriced와 보고 비용 표시 필드를 추가한다. reported_cost는 그대로 통과.
export function withComputedCost(rows) {
  return rows.map((r) => {
    const p = priceFor(r.model);
    const cost = p
      ? (Number(r.input_tokens) * p.input +
          Number(r.output_tokens) * p.output +
          Number(r.cache_read_tokens) * p.cacheRead +
          Number(r.cache_write_tokens) * effectiveCacheWrite(p)) /
        1e6
      : null;
    return { ...r, cost, unpriced: !p, ...reportedCost(r) };
  });
}

// effortMix/agentCost처럼 "그룹 컬럼 × model" 그레인으로 나온 쿼리 결과를 그룹 컬럼(keys) 단위로
// 접는다. 단가 계산(withComputedCost)은 반드시 접기 전에 끝나야 한다 — model 컬럼이 사라진
// 뒤에는 어느 단가를 쓸지 고를 수 없다. 그래서 SQL에서 바로 합계를 내지 않고 두 단계로 나눈다.
// 단가표에 없는 모델은 cost에 0을 더하고(null이 아니다 — 합계가 null이 되면 도넛/표가 통째로
// 비어 버린다) tokens/unpriced_tokens/reported_cost에는 그대로 반영한다.
export function rollupComputedCost(rows, keys) {
  const out = new Map();
  for (const r of withComputedCost(rows)) {
    // 구분자는 "\u0000"(NUL) — agent 이름은 Attributes['agent.name']에서 온 자유 문자열이라 공백을
    // 포함할 수 있고, 공백을 구분자로 쓰면 ("a", "b c")와 ("a b", "c")가 한 키로 뭉개진다(실측).
    const k = keys.map((key) => String(r[key])).join("\u0000");
    let acc = out.get(k);
    if (!acc) {
      acc = {};
      for (const key of keys) acc[key] = r[key];
      Object.assign(acc, { cost: 0, reportedRows: [], tokens: 0, unpriced_tokens: 0 });
      out.set(k, acc);
    }
    // 드라이버가 집계값을 문자열로 돌려주는 경우가 있어 전부 Number()로 강제한다 — 빠뜨리면
    // += 가 문자열 연결이 되어 "37" 같은 값이 나온다.
    const tokens =
      Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens);
    if (!r.unpriced) acc.cost += Number(r.cost);
    acc.reportedRows.push(r);
    acc.tokens += tokens;
    if (r.unpriced) acc.unpriced_tokens += tokens;
  }
  return [...out.values()].map(({ reportedRows, ...row }) => ({ ...row, ...sumReportedCost(reportedRows) }));
}
