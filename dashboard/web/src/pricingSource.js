import { localizedFormat, translate, translateSource } from "./i18n/index.js";
// /api/config pricing.priceList → Cost page help sentence naming the rate source.
const FETCHED_FORMAT = localizedFormat("DateTimeFormat", {
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
  const at = time ? translate("m3e08e7ff8f10", [time]) : translate("mf6797a2f70ac");
  const cards = priceList?.modelCardModels?.length ? translate("m11a2dc1d12c4") : "";
  if (priceList?.source === "runtime") return translate("mad2318239f0a", [at, translateSource(FALLBACK), cards]);
  if (priceList?.source === "snapshot") return translate("m4ba6d3a760c3", [at, translateSource(FALLBACK), cards]);
  if (priceList?.source === "code") return translate("ma5efd98c6473", [cards]);
  return translate("m5faccc2c617e");
}
