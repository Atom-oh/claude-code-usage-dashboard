// The shared API allows raw ten-minute buckets through one day; wider ranges use rollups.
export function costResolutionOptions(spanMs) {
  return [...(spanMs <= 86400000 ? [1 / 6, 0.5] : []), 1, 24, 168];
}

export const costResolutionLabel = (hours) => hours < 1 ? `${Math.round(hours * 60)}분`
  : hours === 1 ? "시간별" : hours === 24 ? "일간" : hours === 168 ? "주간" : `${hours}시간`;
