// ponytail: clsx 없이 — 우리가 다루는 클래스 조합은 문자열/불리언 나열뿐이라 이거면 충분.
export function cn(...args) {
  return args.flat().filter(Boolean).join(" ");
}
