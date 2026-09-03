import { maskEmail } from "./fmt.js";

// 테이블에 보이는 값을 그대로 CSV로 — 서버를 거치지 않는 클라이언트 전용 내보내기다.
// 브라우저가 이미 렌더한 columns/rows만 쓰므로 새 API도, 권한 경계 변경도 없다.

// BOM(U+FEFF)은 이스케이프로 쓴다: 소스에 리터럴로 박으면 에디터에서 보이지 않아 누가
// 지워도 알 수 없다. Excel은 이게 없으면 UTF-8 한글을 로컬 코드페이지로 오해해 깨뜨린다.
const BOM = "\uFEFF";

// RFC 4180 — 쉼표/따옴표/CR/LF를 담은 필드만 따옴표로 감싸고, 안의 따옴표는 두 번 쓴다.
function quote(field) {
  const s = field == null ? "" : String(field);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const ymdUtc = (d) =>
  d instanceof Date && !Number.isNaN(d.getTime())
    ? `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`
    : "";

// col.render는 절대 호출하지 않는다 — JSX를 반환할 수 있고, 문자열을 반환하는 경우에도
// 천 단위 구분자가 들어가 스프레드시트가 숫자로 읽지 못한다. 그래서 셀 내용은 col.toText가
// 있으면 그것, 없으면 원본 value다. toText를 갖는 컬럼은 원본 값만으로 셀을 복원할 수 없는
// 경우뿐이다(row에서 파생 / 센티넬 라벨 치환 / 단위 변환).
//
// piiMask는 이 내보내기가 마스킹 대상인지를 나타내는 의도값이고, 실제 규칙은 fmt.js가
// 소유한다 — maskEmail 자체가 fmt.js의 모듈 플래그(setPiiMask)로 한 번 더 걸린다. 둘 다
// GET /api/config의 piiMask에서 나온다. 마스킹은 toText 결과에 적용한다: user 컬럼의 원본
// 값이 곧 주소이고, 그것이 maskEmail의 올바른 입력이다.
export function toCsv(columns, rows, { piiMask = false } = {}) {
  const cols = columns || [];
  const header = cols.map((c) => quote(c.label)).join(",");
  const body = (rows || []).map((r) =>
    cols
      .map((c) => {
        const v = r?.[c.key];
        const cell = c.toText ? c.toText(v, r) : v ?? "";
        return quote(piiMask && c.key === "user" ? maskEmail(cell) : cell);
      })
      .join(",")
  );
  // 줄 구분은 CRLF(RFC 4180). 마지막 줄에는 붙이지 않는다 — 행이 없으면 결과가 헤더 한
  // 줄뿐이어야 하고, 그래야 "행 수 = 개행 수 + 1"이 항상 성립한다.
  return BOM + [header, ...body].join("\r\n");
}

// 파일명에 구간을 박아 두 기간을 내려받아도 서로 덮어쓰지 않게 한다. UTC 기준이다 —
// 서버가 내려주는 t 값과 RangeContext의 from/to가 모두 UTC 경계다(fmt.js parseUtc).
// 날짜가 없으면(=RangeProvider 밖에서 렌더된 경우, RangeContext는 createContext(null))
// 이름만으로 떨어뜨린다 — 잘못된 구간이 박힌 파일명보다 없는 쪽이 낫다.
export function csvFilename(exportName, from, to) {
  const a = ymdUtc(from);
  const b = ymdUtc(to);
  return a && b ? `${exportName}_${a}_${b}.csv` : `${exportName}.csv`;
}

export function downloadCsv(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
