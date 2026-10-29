// /api/config pricing.priceList → Cost page help sentence naming the rate source.
const FETCHED_FORMAT = new Intl.DateTimeFormat("en-GB", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  hourCycle: "h23", timeZoneName: "short",
});

export function formatPriceListTime(value, format = FETCHED_FORMAT) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(format.formatToParts(date).map(({ type, value: text }) => [type, text]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

const FALLBACK = "목록에 없는 모델은 서버 내장 단가표를 쓰고, 운영자 단가 설정이 있으면 그 값이 우선합니다.";

export function priceSourceText(priceList, format) {
  const time = formatPriceListTime(priceList?.fetchedAt, format);
  const at = time ? `${time} 조회` : "조회 시각 미확인";
  if (priceList?.source === "runtime") return `단가 출처: AWS Price List 실시간 조회(${at}). ${FALLBACK}`;
  if (priceList?.source === "snapshot") return `단가 출처: AWS Price List 빌드 스냅샷(${at}). ${FALLBACK}`;
  if (priceList?.source === "code") return "단가 출처: 서버 내장 단가표(AWS Price List 단가 없음). 운영자 단가 설정이 있으면 그 값이 우선합니다.";
  return "단가 출처: 미확인.";
}
