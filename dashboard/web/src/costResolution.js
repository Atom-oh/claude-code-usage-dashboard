import { translate } from "./i18n/index.js";
// The shared API allows raw ten-minute buckets through one day; wider ranges use rollups.
export function costResolutionOptions(spanMs) {
  return [...(spanMs <= 86400000 ? [1 / 6, 0.5] : []), 1, 24, 168];
}

export function costDefaultResolution(spanMs, hours) {
  return hours >= 1 ? hours : costResolutionOptions(spanMs).find(value => value >= hours) ?? 24;
}

export const costResolutionLabel = (hours) => hours < 1 ? translate("m949d9fec534d", [Math.round(hours * 60)])
  : hours === 1 ? translate("mdeb162691363") : hours === 24 ? translate("m58ea1d09d2dd") : hours === 168 ? translate("m2392bb5e3aa6") : translate("m9a58de84ee31", [hours]);
