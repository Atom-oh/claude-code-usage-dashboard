// Bedrock/Anthropic per-1M-token USD 단가. cacheWrite = 입력 단가×1.25(5분 TTL), cacheRead = 입력 단가×0.1.
// Bedrock cross-region(us./global./eu./apac.) 추론 프로파일은 기본 모델과 동일 단가.
const PRICING = {
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-haiku-3-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
};

// us.anthropic.claude-sonnet-4-5-20250929-v1:0 / global.anthropic.claude-opus-4-8
// / anthropic.claude-* / claude-sonnet-4-5-20250929 / claude-fable-5[1m] → 단가표 key
export function normalizeModelId(raw) {
  return String(raw || "")
    .replace(/\[[^\]]*\]$/, "") // [1m] 컨텍스트 윈도우 접미사
    .replace(/^(?:us|global|eu|apac)\./, "") // cross-region 추론 프로파일 접두사
    .replace(/^anthropic\./, "") // bedrock provider 접두사
    .replace(/-v\d+:\d+$/, "") // bedrock 버전 접미사 -v1:0
    .replace(/-\d{8}$/, ""); // 날짜 스냅샷 접미사 -20250929
}

export function priceFor(model) {
  return PRICING[normalizeModelId(model)] || null;
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
    t.cacheWrite += (Number(r.cache_write_tokens) * p.cacheWrite) / 1e6;
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
// cost(계산 비용, 미산정 모델이면 null) + unpriced 플래그를 추가한다. reported_cost는 그대로 통과.
export function withComputedCost(rows) {
  return rows.map((r) => {
    const p = priceFor(r.model);
    const cost = p
      ? (Number(r.input_tokens) * p.input +
          Number(r.output_tokens) * p.output +
          Number(r.cache_read_tokens) * p.cacheRead +
          Number(r.cache_write_tokens) * p.cacheWrite) /
        1e6
      : null;
    return { ...r, cost, unpriced: !p };
  });
}
