import { localize } from "./i18n/index.js";
// In-app release notes: the user-facing subset of CHANGELOG.md for each tagged release.
// CHANGELOG.md (English) stays the complete engineering record; the image build context is
// dashboard/ only, so these notes ship with the bundle instead of reading the root file.
// Release policy: docs/runbooks/releases.md. releaseNotes.test.js keeps versions, dates,
// package.json and CHANGELOG headings aligned.
//
// item.kind: "new" | "improved" | "fixed". item.to: an app route, or null when the feature
// has no page (where explains how to reach it). item.detail: the route lives in Claude
// detail view (?client=claude&view=detail), so the link is hidden when Claude is disabled.
export const RELEASES = localize([
  {
    "version": "1.14.0",
    "date": "2026-11-16",
    "summary": "Codex 작업 상세의 타임라인에 서브에이전트를 레인으로 보여 줍니다.",
    "items": [
      {
        "kind": "new",
        "title": "Codex 서브에이전트 타임라인 레인",
        "body": "Codex 작업 상세의 타임라인에서 서브에이전트 대화마다 레인을 하나씩 그리고, 그 서브에이전트를 시작한 호출에서 점선으로 연결합니다. 레인의 LLM 호출은 서브에이전트 자신의 비용으로 표시하고, span을 다 읽지 못한 레인은 일부만 표시한다고 안내합니다.",
        "to": "/users",
        "where": "Users → 작업 목록 → 작업 상세",
        "refs": [
          324
        ]
      }
    ]
  },
  {
    "version": "1.13.1",
    "date": "2026-11-16",
    "summary": "Bedrock 요청과 사용량의 백엔드를 Runtime과 Mantle로 구분하고, 작업 목록에서 Codex 작업의 서브에이전트 수를 보여 줍니다.",
    "items": [
      {
        "kind": "fixed",
        "title": "Bedrock 백엔드 구분",
        "body": "Bedrock 세션의 요청 기록과, 접두사 없는 모델 ID(예: claude-fable-5-1)로 기록된 사용량을 '알 수 없음' 대신 같은 세션의 모델 ID에 따라 Bedrock Runtime 또는 Bedrock Mantle로 표시합니다.",
        "to": "/",
        "where": "상단 필터 → 백엔드",
        "refs": [
          323
        ]
      },
      {
        "kind": "fixed",
        "title": "작업 목록의 Codex 서브에이전트 수",
        "body": "작업 목록에 표시된 Codex 작업의 서브에이전트 수를 작업 상세와 같은 방식으로 셉니다. 호출이 없었다는 근거가 충분하면 0으로, 확인할 수 없거나 세션이 매우 길면 미수집으로 표시합니다.",
        "to": "/users",
        "where": "Users → 작업 목록 → 서브에이전트",
        "refs": [
          320
        ]
      }
    ]
  },
  {
    "version": "1.13.0",
    "date": "2026-11-15",
    "summary": "Codex 작업 상세에서 서브에이전트를 더 많이 연결하고, 재시도·컴팩션 횟수를 보여 줍니다. 긴 Codex 세션의 상세 화면도 시간 안에 열립니다.",
    "items": [
      {
        "kind": "improved",
        "title": "Codex 서브에이전트 연결 확대",
        "body": "Codex CLI의 spawn_agent·send_input과 0.166 이전 Codex의 하위 작업도 작업 상세의 서브에이전트로 연결하고, 각 턴의 LLM 호출과 비용 추정을 함께 보여 줍니다.",
        "to": "/users",
        "where": "Users → 작업 목록 → 작업 상세",
        "refs": [
          314
        ]
      },
      {
        "kind": "new",
        "title": "Codex 재시도와 컴팩션",
        "body": "Codex 작업 상세에서 모델 요청 재시도 횟수와 컴팩션 횟수를 확인할 수 있습니다. 컴팩션은 Codex 0.161 이상에서 수집되며, 일부만 표시될 때는 그렇게 안내합니다.",
        "to": "/users",
        "where": "Users → 작업 목록 → 작업 상세",
        "refs": [
          314
        ]
      },
      {
        "kind": "fixed",
        "title": "서브에이전트 0과 미수집 구분",
        "body": "서브에이전트 호출이 없었다는 근거가 충분하면 0으로, 확인할 수 없으면 미수집으로 표시합니다.",
        "to": "/users",
        "where": "Users → 작업 상세 → 서브에이전트",
        "refs": [
          314
        ]
      },
      {
        "kind": "fixed",
        "title": "긴 Codex 세션의 상세 화면",
        "body": "매우 긴 Codex 세션의 상세 화면이 시간 초과 없이 열립니다. 이때 서브에이전트 비용은 일부만 확인된 값으로 표시될 수 있습니다.",
        "to": "/users",
        "where": "Users → 작업 상세",
        "refs": [
          314
        ]
      }
    ]
  },
  {
    "version": "1.12.0",
    "date": "2026-11-15",
    "summary": "Usage에서 Codex 토큰 구성의 확인된 부분합을 볼 수 있습니다. 날짜·시간 선택, 다국어 가이드, 작업 상세와 Collector 연결도 개선했습니다.",
    "items": [
      {
        "kind": "fixed",
        "title": "Codex 토큰 구성의 부분합",
        "body": "사용량을 확인하지 못한 기록이 있어도 입력·캐시 읽기·캐시 쓰기·출력의 확인된 부분합을 표시합니다. 누락된 기록을 알리고, 거부된 요청만 있는 기간의 기록된 0도 유지합니다.",
        "to": "/usage",
        "where": "Usage → 클라이언트별 토큰 구성",
        "refs": [
          315
        ]
      },
      {
        "kind": "new",
        "title": "클라이언트별 Skill 사용량",
        "body": "Usage 화면에서 Claude Code와 Codex가 사용한 Skill의 호출 수와 발동 방식을 확인할 수 있습니다. 클라이언트·사용자·모델·백엔드·팀 필터를 함께 적용합니다.",
        "to": "/usage",
        "where": "Usage → Skill 사용량",
        "refs": [
          304
        ]
      },
      {
        "kind": "new",
        "title": "Codex 작업 상세의 하위 에이전트와 도구",
        "body": "작업 상세에서 연결이 확인된 하위 에이전트, LLM 호출, 비용 추정과 Skill·MCP·도구 호출을 살펴볼 수 있습니다. 수집되지 않은 하위 에이전트는 별도로 안내합니다.",
        "to": "/users",
        "where": "Users → 작업 목록 → 작업 상세",
        "refs": [
          302,
          303
        ]
      },
      {
        "kind": "fixed",
        "title": "날짜·시간 선택의 완료 버튼",
        "body": "React 달력에서 날짜나 시간을 고른 뒤 완료 버튼으로 선택을 마치고, 적용 버튼으로 조회 기간을 변경할 수 있습니다.",
        "to": null,
        "where": "상단 → 날짜·시간 선택",
        "refs": [
          305
        ]
      },
      {
        "kind": "improved",
        "title": "다섯 언어의 가이드 화면",
        "body": "가이드의 대시보드 이미지와 조작 안내가 선택한 언어로 표시됩니다. 이미지를 확대해 화면의 메뉴와 차트를 확인할 수 있습니다.",
        "to": null,
        "where": "가이드 → 화면 이미지",
        "refs": [
          306,
          310
        ]
      },
      {
        "kind": "fixed",
        "title": "Claude의 짧은 기간 조회",
        "body": "Claude 상세 화면에서 4시간 이하의 기간을 조회할 때 발생하던 로딩 시간 초과를 해결했습니다.",
        "to": "/cost",
        "detail": true,
        "where": "Claude 상세 → 조회 기간",
        "refs": [
          311
        ]
      },
      {
        "kind": "improved",
        "title": "Collector 로그인 정보와 연결",
        "body": "브라우저에서 승인한 로그인 이메일로 Claude Code와 Codex 사용량을 연결합니다. Codex는 로컬 OTLP/gRPC 연결을 사용하며, 재설치할 때의 사용자 정보와 갱신 설정도 보존합니다.",
        "to": null,
        "where": "Collector 연결 → 설치·재설치",
        "refs": [
          308,
          309,
          312
        ]
      }
    ]
  },
  {
    "version": "1.11.0",
    "date": "2026-11-15",
    "summary": "공유 화면에서 팀 이름을 이메일처럼 가릴 수 있습니다. Reliability에서 Codex 지표를 볼 수 있고, Claude 비용의 백엔드 구분이 더 정확해졌습니다.",
    "items": [
      {
        "kind": "new",
        "title": "팀 이름 마스킹",
        "body": "여러 사람이 보는 화면(데모 등)에서 팀 이름을 앞 두 글자와 짧은 식별값으로 가립니다. 기본값은 배포 설정(지정하지 않으면 이메일 마스킹과 같음)을 따르고, 관리자가 설정 화면에서 켜기·끄기로 바꿀 수 있습니다. 표시 이름을 붙인 팀은 그 이름을 그대로 보여 줍니다. 화면과 CSV 표시만 바꾸며 API 응답은 그대로입니다.",
        "to": null,
        "where": "설정 → 팀 이름 마스킹 (admin)",
        "refs": [
          292
        ]
      },
      {
        "kind": "fixed",
        "title": "Reliability의 Codex 지표 표시",
        "body": "Codex 상세의 Metrics가 거의 모든 기간에서 조회 한도 초과로 표시되던 문제를 고쳤습니다. 약 8일까지의 기간에서 턴 처리 시간·첫 토큰 시간·도구 호출·토큰 타일이 확인된 값으로 표시되고, 일부를 확인하지 못하면 그 사실을 함께 알립니다.",
        "to": null,
        "where": "Reliability → Codex 상세",
        "refs": [
          297
        ]
      },
      {
        "kind": "fixed",
        "title": "이어 쓴 세션의 Claude 비용 백엔드",
        "body": "Bedrock으로 시작해 Claude 로그인으로 이어 쓴 세션의 비용이 모델별 비용에서 백엔드 미제공으로 표시되던 문제를 고쳤습니다. 로그인 이후 사용분은 Anthropic으로 구분합니다.",
        "to": null,
        "where": "Cost → 모델별 비용",
        "refs": [
          295
        ]
      },
      {
        "kind": "fixed",
        "title": "Codex 효율 카드의 전체 구간 지표",
        "body": "기간 안에 사용량을 수집하지 못한 요청이 하나라도 있으면 전체 구간 패널의 타일 네 개가 비어 보이던 문제를 고쳤습니다. 완료 응답 기준일 때는 HTTP 요청·세션 지표만 보여 주고, 보류한 값의 이유를 함께 안내합니다.",
        "to": null,
        "where": "Cost → Codex 상세 → 전체 구간 지표",
        "refs": [
          294
        ]
      },
      {
        "kind": "fixed",
        "title": "언어 전환 안정화",
        "body": "다섯 언어 카탈로그를 앱에 함께 담아, 배포 중에도 언어를 바꾸면 바로 적용됩니다.",
        "to": null,
        "where": "사이드바 아래쪽 → 언어",
        "refs": [
          296
        ]
      }
    ]
  },
  {
    "version": "1.10.0",
    "date": "2026-11-14",
    "summary": "모든 대시보드 화면과 사용설명서를 다섯 언어로 살펴보고, 한국어 내레이션과 영어 자막의 상세 소개 영상으로 주요 사용 흐름을 익힐 수 있습니다.",
    "items": [
      {
        "kind": "new",
        "title": "조직 디렉터리 기준 팀 설정",
        "body": "관리자는 설정에서 Cognito 사용자 속성과 팀 표시 이름을 선택하고 적용 전 사용자 분포를 미리 확인할 수 있습니다. 화면 언어를 바꿔도 선택한 속성·입력한 이름·저장 오류는 유지됩니다.",
        "to": null,
        "where": "사이드바 → 설정 → 팀 기준 속성",
        "refs": [
          284,
          290
        ]
      },
      {
        "kind": "improved",
        "title": "기존 Collector를 안전하게 전환",
        "body": "개인 Linux의 기존 otelcol.service를 확인하고 동의 후 장치 Collector로 전환합니다. 사용자 ID와 설정을 보존하며 설치 실패 시 기존 서비스를 복원합니다. macOS·Linux 재설치에서도 실행 가능한 기존 Collector를 확인하고, 브라우저 승인 전에 포트 충돌을 검사합니다.",
        "to": null,
        "where": "Collector 설치 · 기존 설치에서 전환",
        "refs": [
          285,
          288
        ]
      },
      {
        "kind": "improved",
        "title": "모든 화면의 다국어 지원",
        "body": "Overview부터 비용·사용자·도구 분석, Codex 진단, 수집기 설치와 작업 상세까지 한국어·영어·중국어(간체)·일본어·스페인어로 안내합니다. 언어를 바꿔도 선택한 탭·작업·기간과 차트 강조가 유지됩니다.",
        "to": null,
        "where": "사이드바 아래쪽 → 언어 · 작업 상세 → 언어",
        "refs": [
          274,
          275
        ]
      },
      {
        "kind": "new",
        "title": "다섯 언어의 상세 사용설명서",
        "body": "스페인어를 포함한 다섯 언어에서 모든 메뉴의 목적과 읽는 법, 사용자 Trace·비용 해석·도구 사용·수집기 설치 절차를 살펴볼 수 있습니다. 화면을 확대해 확인하고 아키텍처와 함께 전체 흐름을 이해할 수 있습니다.",
        "to": null,
        "where": "사이드바 → 사용설명서",
        "refs": [
          275
        ]
      },
      {
        "kind": "new",
        "title": "전체 기능을 따라가는 상세 소개 영상",
        "body": "사용설명서 첫 화면에서 한국어 내레이션과 영어 자막의 9분 소개 영상을 볼 수 있습니다. 챕터를 선택해 사용자 Trace, 비용 해석, 도구와 수집기 안내로 이동합니다.",
        "to": null,
        "where": "사이드바 → 사용설명서 → 소개 영상",
        "refs": [
          286,
          287
        ]
      }
    ]
  },
  {
    version: "1.9.0",
    date: "2026-11-14",
    summary: "화면 언어를 다섯 가지 중에서 고르고, 수집기를 브라우저 승인으로 설치하며, 클라이언트·모델 색을 화면 전체에서 같은 규칙으로 맞췄습니다.",
    items: [
      {
        kind: "new",
        title: "화면 언어 선택",
        body: "한국어, English, 简体中文, 日本語, Español 중에서 화면 언어를 고를 수 있습니다. 공용 컨트롤·차트 라벨·안내 문구가 선택한 언어로 바뀌고, 열려 있던 작업·필터·기간은 그대로 유지됩니다. 사용자 가이드는 번역본이 있으면 그 언어로, 없으면 영어로 열립니다.",
        to: null,
        where: "사이드바의 언어 선택 (모바일 메뉴·작업 상세에도 있음)",
        refs: [279],
      },
      {
        kind: "new",
        title: "브라우저 승인으로 수집기 설치",
        body: "curl … | sh 명령을 실행하면 확인 코드와 승인 링크가 나오고, 브라우저에서 로그인해 기기를 승인하면 설치가 알아서 끝납니다. 기기 토큰을 복사해 붙여 넣을 필요가 없고, 새 설치는 승인한 계정의 이메일을 사용자 ID로 씁니다. 기존 토큰 방식도 계속 쓸 수 있습니다.",
        to: null,
        where: "사이드바 수집기 설치 → 터미널에서 설치 (editor·admin)",
        refs: [268],
      },
      {
        kind: "improved",
        title: "클라이언트·모델 색 정리",
        body: "Claude Code는 Claude 주황, Codex는 잉크색으로 모든 공용 화면에서 같은 색을 씁니다. 사용자별 비용의 채널 줄은 같은 주황의 진하기로 CCB·C4E·미분류를 구분합니다. 모델은 계열마다 한 가지 색을 쓰고, 최신 버전일수록 진하게 표시합니다.",
        to: "/cost",
        where: "Cost → 사용자별 비용·모델별 비용 비중, Trends → 클라이언트별 추이",
        refs: [280],
      },
      {
        kind: "fixed",
        title: "이전 버전 Codex 작업의 LLM 호출 수",
        body: "Codex 0.159.3 같은 이전 버전에서 보낸 작업의 LLM 호출이 0으로 나오고 작업 상세에 호출 구간이 비어 보이던 문제를 고쳤습니다. 이미 수집된 기록에도 바로 반영됩니다.",
        to: "/users",
        where: "Users → 사용자 선택 → 작업 목록·작업 상세",
        refs: [282],
      },
    ],
  },
  {
    version: "1.8.2",
    date: "2026-11-14",
    summary: "활동이 많은 사용자의 90일 활동 히트맵이 열리지 않던 문제와, 기기 수집기 사용자의 작업에 모델이 비던 문제를 고쳤습니다.",
    items: [
      {
        kind: "fixed",
        title: "90일 활동 히트맵 로드 실패",
        body: "활동이 많은 사용자의 상세에서 '활동 히트맵 · 최근 90일'이 '데이터를 불러오지 못했습니다'로 나오던 문제를 고쳤습니다. 같은 세션이 사용량과 로그 양쪽에 있어도 한 번만 셉니다.",
        to: "/users",
        where: "사용자 → 사용자 선택 → 활동 히트맵",
        refs: [276],
      },
      {
        kind: "fixed",
        title: "기기 수집기 사용자의 작업 모델·LLM 호출",
        body: "기기 수집기로 보내는 Claude Code 2.1.325 이상에서 작업 목록·작업 상세의 모델, LLM 호출, 호출 비용이 비어 보이던 문제를 고쳤습니다. 수집기를 다시 설치한 뒤의 작업부터 반영되며, 이전에 누락된 기록은 복구되지 않습니다.",
        to: "/users",
        where: "사용자 → 사용자 선택 → 작업 목록·작업 상세",
        refs: [276],
      },
    ],
  },
  {
    version: "1.8.1",
    date: "2026-11-14",
    summary: "비용 비중 카드에 $0 항목이 줄줄이 나와 카드가 길어지던 문제를 고쳤습니다.",
    items: [
      {
        kind: "fixed",
        title: "비용 비중 카드의 $0 항목 정리",
        body: "모델별·Effort별 비용 비중 카드에서 비용이 $0인 모델·백엔드 조합을 범례에 하나씩 나열하지 않고, 접힌 '비용 $0 항목 N개' 한 줄로 모읍니다. 펼치면 어떤 조합인지 볼 수 있고, 비용을 알 수 없는 항목은 지금처럼 미산정으로 따로 표시합니다.",
        to: "/cost",
        where: "비용 → 모델별 비용 비중·Effort별 비용 비중",
        refs: [270],
      },
    ],
  },
  {
    version: "1.8.0",
    date: "2026-11-14",
    summary: "수집기를 터미널 명령 한 줄로 설치하고, 기간을 날짜·시각 단위로 정확히 지정할 수 있습니다.",
    items: [
      {
        kind: "improved",
        title: "수집기 한 줄 설치",
        body: "패키지를 브라우저에서 내려받아 기기로 옮길 필요 없이, 수집할 기기의 터미널에서 curl … | sh 명령 한 줄로 설치합니다. 명령이 운영체제를 알아서 고르고, 사용자 ID와 기기 토큰을 차례로 묻습니다. 토큰은 화면에 표시되지 않고 명령 인자에도 남지 않습니다.",
        to: null,
        where: "사이드바 수집기 설치 → 터미널에서 설치 (editor·admin)",
        refs: [260],
      },
      {
        kind: "new",
        title: "정확한 시작·끝 시각 지정",
        body: "기간 선택에서 시작과 끝을 날짜와 시각(초 단위)으로 직접 지정할 수 있습니다. 시각은 브라우저 시간대 기준이고, 공유 링크도 같은 기간을 유지합니다. UTC 하루 단위 선택도 계속 쓸 수 있습니다.",
        to: null,
        where: "상단 기간 선택 → 기간 직접 선택 → 날짜·시간",
        refs: [262],
      },
      {
        kind: "fixed",
        title: "기간을 바꿔도 사용자 상세 유지",
        body: "기간을 바꿔도 열려 있던 사용자 상세가 닫히지 않습니다. 상위 20개 작업 목록은 현재 기간과 차트 드래그 확대를 따르고, 차트의 점을 누르면 그 구간으로 좁힌 뒤 전체 기간으로 되돌릴 수 있습니다.",
        to: null,
        where: "사용자 → 사용자 상세 → 작업 목록",
        refs: [262],
      },
      {
        kind: "fixed",
        title: "단위 비용 추이의 빈 구간",
        body: "값을 알 수 없는 구간을 사이에 둔 관측값을 점선으로 이어 추이를 읽기 쉽게 했습니다. 알 수 없는 값은 툴팁과 계산에서 계속 미수집으로 둡니다.",
        to: "/productivity",
        where: "Productivity → 토큰 경제 → 단위 비용 추이",
        refs: [262],
      },
    ],
  },
  {
    version: "1.7.0",
    date: "2026-11-13",
    summary: "작업 상세에 세션이 들고 다니는 MCP 서버와 plugin을 보여주는 세션 환경 카드를 추가했습니다.",
    items: [
      {
        kind: "new",
        title: "작업 상세 세션 환경",
        body: "Claude Code 작업의 세션에 연결된 MCP 서버(연결·실패와 이름), 로드된 plugin과 그 안의 skill·agent·command 수, 첫 호출의 입력 컨텍스트를 보여줍니다. 세션 시작 이벤트는 작업 시작 14일 전까지 찾고, 찾지 못하면 미수집으로 표시합니다. tool 정의 수와 토큰 크기는 OTel에 없어 표시하지 않으며, Codex는 이런 이벤트를 보내지 않아 미수집입니다.",
        to: null,
        where: "사용자 상세 → 작업 목록 → 작업 열기 → 세션 환경",
        refs: [257],
      },
    ],
  },
  {
    version: "1.6.1",
    date: "2026-11-13",
    summary: "작업 상세에서 같은 종류의 서브에이전트가 하나처럼 보이던 문제와 컨텍스트 그래프가 0 근처로 꺾이던 문제를 고쳤습니다.",
    items: [
      {
        kind: "fixed",
        title: "같은 종류 서브에이전트 구분",
        body: "general-purpose 같은 같은 종류의 서브에이전트가 여러 개면 #1, #2처럼 번호를 붙이고 색 농도를 달리해 타임라인·누적 비용·컨텍스트 크기·상세 패널에서 각각 구분해 보여줍니다.",
        to: null,
        where: "사용자 상세 → 작업 목록 → 작업 열기",
        refs: [255],
      },
      {
        kind: "fixed",
        title: "컨텍스트 크기 그래프의 보조 호출",
        body: "서브에이전트의 요약(agent_summary)처럼 같은 레인 안의 보조 호출은 선으로 잇지 않고 점으로만 표시해, 대화 컨텍스트 선이 0 근처로 꺾여 보이지 않습니다.",
        to: null,
        where: "사용자 상세 → 작업 목록 → 작업 열기 → 컨텍스트 크기",
        refs: [255],
      },
    ],
  },
  {
    version: "1.6.0",
    date: "2026-11-13",
    summary: "모범 사용자를 중앙값 대비 차트로 바꾸고, 작업 상세에 모델별 사용 요약과 워크플로 표시를 추가했으며, 비용 높은 순 정렬 오류를 고쳤습니다.",
    items: [
      {
        kind: "improved",
        title: "모범 사용자 중앙값 대비 차트",
        body: "레버(토큰/요청, 요청/턴, 캐시 히트율, 소형 모델 비중)마다 적격 사용자 최대 10명을 중앙값과 비교하는 막대로 보여줍니다. 가운데 점선이 중앙값이고 오른쪽이 항상 좋은 방향입니다. 비율 레버는 %p, 나머지는 중앙값 대비 %입니다. 세션·턴·커밋은 마우스를 올리면 보이며, CSV에는 중앙값과 차이가 함께 담깁니다. 사용 방식을 물어볼 사람을 찾는 용도이며 성과 평가가 아닙니다.",
        to: "/productivity",
        where: "Productivity → 토큰 경제 → 모범 사용자",
        refs: [252],
      },
      {
        kind: "new",
        title: "작업 상세 모델별 사용 요약",
        body: "'왜 많이 썼나' 아래에 모델별 호출 수, 비용, 비용 비중을 비용 큰 순으로 보여줍니다. 호출이 많은 작업도 막대를 하나씩 열지 않고 어떤 모델을 몇 번, 얼마나 썼는지 알 수 있습니다. 비용을 모르는 호출과 span에 연결되지 않은 Codex completion이 비중에서 빠지면 함께 알려줍니다.",
        to: null,
        where: "사용자 상세 → 작업 목록 → 작업 열기",
        refs: [253],
      },
      {
        kind: "new",
        title: "작업 목록 워크플로 표시",
        body: "Claude Code 작업이 속한 워크플로 실행을 배지로 보여주고, 배지를 누르면 그 실행의 작업만 남깁니다. 작업 상세 머리글에도 워크플로가 표시됩니다.",
        to: null,
        where: "사용자 상세 → 작업 목록 → 워크플로 열",
        refs: [253],
      },
      {
        kind: "fixed",
        title: "작업 목록 '비용 높은 순' 오류",
        body: "호출이 많은 사용자에서 '비용 높은 순' 정렬이 오류로 비어 보이던 문제를 고쳤습니다.",
        to: null,
        where: "사용자 상세 → 작업 목록 → 비용 높은 순",
        refs: [253],
      },
    ],
  },
  {
    version: "1.5.1",
    date: "2026-11-12",
    summary: "Productivity 맨 위에 토큰 경제 비용 방정식을 추가하고 Codex 상세 화면의 안내 문구를 정리했습니다.",
    items: [
      {
        kind: "new",
        title: "토큰 경제 비용 방정식",
        body: "총 비용을 사용자 × 세션/사용자 × 턴/세션 × 요청/턴 × 토큰/요청 × 토큰당 단가로 나눠 직전 같은 길이 기간과 비교합니다. 비용 변화를 성장·낭비·단가 항목별 금액으로 분해하고, 단위 비용 추이, 모델 경제, 커밋·PR·추가 라인당 비용(Claude Code만), 사용 방식을 물어볼 모범 사용자를 보여줍니다. 운영자가 세션 턴 집계를 활성화하기 전에는 값 대신 '백필 전'으로 표시합니다. 관측된 텔레메트리 활동 기준이며 생산성·성과 평가가 아닙니다.",
        to: "/productivity",
        where: "Productivity → 맨 위 토큰 경제",
        refs: [249, 250],
      },
      {
        kind: "new",
        title: "Claude Code 워크플로 실행별 작업 조회",
        body: "사용자 작업 API에서 Claude Code 워크플로 실행 ID나 이름으로 작업을 거를 수 있고, 작업과 작업 상세가 관련 워크플로 실행을 함께 알려줍니다. 트레이스를 보내는 클라이언트에서만 값이 있습니다.",
        to: null,
        where: "API: /api/users/tasks (workflowRunId, workflowName)",
        refs: [247],
      },
      {
        kind: "improved",
        title: "Codex 상세 안내 간소화",
        body: "Codex 상세 제목 아래의 긴 비용 안내와 조회 기간을 제목 옆 정보 아이콘으로 옮기고, 화면 상단의 공통 비용 안내 배너를 없앴습니다. 지표별 비용 기준·부분합·토큰 범위 표시는 그대로입니다.",
        to: "/cost",
        where: "Cost → Codex 상세",
        refs: [246],
      },
    ],
  },
  {
    version: "1.5.0",
    date: "2026-11-11",
    summary: "90일 활동 히트맵의 데이터 조회 오류를 고치고 AWS 모델 가격 목록을 갱신했습니다.",
    items: [
      {
        kind: "fixed",
        title: "90일 활동 히트맵 조회",
        body: "활동이 많은 사용자의 90일 히트맵이 조회 한도를 초과해 불러오지 못하던 문제를 고쳤습니다. 날짜별 관측 세션 수를 집계해 표시합니다.",
        to: "/users",
        where: "Users → 사용자 선택 → 활동 히트맵",
        refs: [244],
      },
      {
        kind: "improved",
        title: "AWS 모델 가격 목록 갱신",
        body: "시작 시 사용하는 AWS 가격 목록에 gpt-6.1-terra 등 추가 모델 단가를 반영했습니다. 비용은 정가 기준 추정이며 청구서 금액이 아닙니다.",
        to: "/cost",
        where: "Cost → 모델별 비용",
        refs: [],
      },
    ],
  },
  {
    version: "1.4.0",
    date: "2026-11-10",
    summary: "Productivity를 Claude Code와 Codex가 같은 화면·같은 열로 보는 통합 화면으로 바꿨습니다.",
    items: [
      {
        kind: "new",
        title: "통합 Productivity",
        body: "클라이언트별 요약, 모델별 관측 효율, 활동, 코드 결과, 도구별 권한 결정, 도구 실행 결과, 응답·대기, 활동 지수 상위 사용자를 클라이언트마다 같은 열로 보여줍니다. Codex가 보내지 않는 값은 0 대신 미수집·미집계·미산출로 표시합니다. Codex 효율·Effort 표는 Cost 페이지에서 봅니다.",
        to: "/productivity",
        where: "Productivity",
        refs: [241, 242],
      },
      {
        kind: "improved",
        title: "90일 활동 히트맵",
        body: "사용자 상세의 90일 활동 히트맵이 카드 너비에 맞게 커지고, 월·요일 라벨과 범례가 붙습니다.",
        to: "/users",
        where: "Users → 사용자 선택 → 활동 히트맵",
        refs: [239],
      },
    ],
  },
  {
    version: "1.3.1",
    date: "2026-11-10",
    summary: "AWS 가격 목록에 아직 없는 일부 Bedrock 모델의 비용을 모델 카드 가격으로 추정합니다.",
    items: [
      {
        kind: "fixed",
        title: "Kimi K3.1 등 신규 모델 비용 추정",
        body: "AWS Price List에 아직 없는 모델은 AWS 모델 카드의 Standard 정가로 추정합니다. 구간 없이 표 하나로 된 카드(예: moonshotai.kimi-k3.1)를 읽지 못해 미산정으로 빠지던 문제를 고쳤습니다. 정가 기준 추정이며 청구서가 아닙니다.",
        to: "/cost",
        where: "Cost → 모델별 비용",
        refs: [238],
      },
    ],
  },
  {
    version: "1.3.0",
    date: "2026-11-10",
    summary: "작업 상세에서 컨텍스트 크기 추이를 보고, 작업을 링크로 공유할 수 있습니다.",
    items: [
      {
        kind: "new",
        title: "컨텍스트 크기 차트",
        body: "작업 상세의 타임라인 아래에 호출별 컨텍스트 크기를 레인별 선으로 그립니다. Claude Code는 컴팩션 지점(전 → 후 토큰)을, Codex는 대화가 보고한 자동 컴팩션 한도와 컨텍스트 창 대비 비율을 함께 보여줍니다. 점을 누르면 그 호출이 오른쪽 패널에 열립니다.",
        to: "/users",
        where: "Users → 사용자 선택 → 추이 막대 클릭 → 태스크 열기 → 컨텍스트 크기",
        refs: [234],
      },
      {
        kind: "new",
        title: "작업 공유 링크",
        body: "작업 상세 오른쪽 위의 링크 복사 버튼으로 그 작업의 주소를 복사합니다. 받은 사람이 열면 같은 작업 상세가 바로 뜨고, 로그인이 필요하면 로그인 후 그 링크로 돌아옵니다. 주소에는 사용자 이메일이 들어가지 않습니다.",
        to: null,
        where: "작업 상세 → 링크 복사",
        refs: [235],
      },
    ],
  },
  {
    version: "1.2.0",
    date: "2026-11-10",
    summary: "사이드바에서 사용설명서를 바로 열 수 있습니다.",
    items: [
      {
        kind: "new",
        title: "사용설명서 링크",
        body: "사이드바(모바일 메뉴 포함) 아래와 이 페이지 위쪽의 사용설명서 링크가 공개 문서 사이트를 새 탭으로 엽니다. 비용 해석 기준, 설치·운영 안내를 볼 수 있습니다.",
        to: null,
        where: "사이드바 아래 사용설명서",
        refs: [],
      },
    ],
  },
  {
    version: "1.1.1",
    date: "2026-11-10",
    summary: "실행 이미지의 zlib 보안 취약점을 패치했습니다. 화면과 기능은 바뀌지 않습니다.",
    items: [
      {
        kind: "fixed",
        title: "zlib 보안 패치 (CVE-2026-4738)",
        body: "컨테이너 이미지 스캔에서 발견된 OS zlib의 Critical 취약점을 Alpine zlib 1.4-r0으로 올려 해결했습니다. 대시보드 사용 방법은 그대로입니다.",
        to: null,
        where: "실행 이미지 (화면 변경 없음)",
        refs: [],
      },
    ],
  },
  {
    version: "1.1.0",
    date: "2026-11-09",
    summary: "태스크 트레이스 정렬·모델별 호출 분석과 앱 안 변경 내역을 추가했습니다.",
    items: [
      {
        kind: "new",
        title: "변경 내역 페이지",
        body: "릴리스마다 바뀐 점과 새 기능의 위치를 이 페이지에서 확인합니다. 새 릴리스가 나오면 사이드바 아래 버전 표시에 점이 붙습니다.",
        to: null,
        where: "사이드바 아래 버전 표시",
        refs: [],
      },
      {
        kind: "new",
        title: "태스크 목록 4가지 정렬",
        body: "사용자 상세의 태스크 목록을 토큰·비용·서브에이전트 수·소요 시간 순으로 바꿔 상위 20개를 봅니다. 비용 순은 토큰 상위 Claude 태스크 100개 안에서 정렬합니다.",
        to: "/users",
        where: "Users → 사용자 선택 → 추이 막대 클릭 → 태스크 목록",
        refs: [229],
      },
      {
        kind: "new",
        title: "태스크 상세의 모델별 호출",
        body: "태스크 상세에서 모델·호출 출처별 호출 수, 비용, 토큰을 묶어 보여줍니다. 행을 누르면 타임라인에서 그 모델의 호출만 강조되어, 예상하지 못한 모델이 어디서 호출됐는지 찾을 수 있습니다.",
        to: "/users",
        where: "태스크 상세 → 모델별 호출",
        refs: [229],
      },
      {
        kind: "fixed",
        title: "서브에이전트 레인 이름",
        body: "Agent 스팬에 유형이 없을 때도 요청 로그의 agent.name으로 레인 이름(general-purpose, Explore, 사용자 정의 에이전트 등)을 표시합니다.",
        to: "/users",
        where: "태스크 상세 → 타임라인",
        refs: [228],
      },
    ],
  },
  {
    version: "1.0.0",
    date: "2026-11-08",
    summary: "첫 태그 릴리스입니다. 최근 추가된 주요 기능을 정리했습니다.",
    items: [
      {
        kind: "new",
        title: "통합 사용자 상세와 태스크 트레이스",
        body: "Claude Code와 Codex를 한 화면에서 보는 사용자 상세입니다. 추이 막대를 누르면 그 구간의 상위 20개 태스크가 나오고, 태스크를 열면 서브에이전트 타임라인, 누적 비용, \"왜 많이 썼나\" 요약을 봅니다.",
        to: "/users",
        where: "Users → 사용자 선택",
        refs: [215],
      },
      {
        kind: "new",
        title: "Ask Claude 분석 에이전트와 차트",
        body: "대화 에이전트가 데이터 질문을 분석 에이전트에 넘기고, 결과를 고정 차트로 보여줍니다. 차트 아래에 실제 집계 기간이 표시됩니다.",
        to: "/analytics",
        where: "Analytics 질문 입력 또는 오른쪽 아래 Ask Claude",
        refs: [218, 221, 222, 224],
      },
      {
        kind: "improved",
        title: "플로팅 채팅 창 크기 조절",
        body: "왼쪽 위 모서리를 끌거나 방향키로 크기를 바꾸고, 헤더의 확장 버튼으로 넓게 볼 수 있습니다. 크기는 브라우저에 기억됩니다.",
        to: null,
        where: "오른쪽 아래 Ask Claude 버튼",
        refs: [223],
      },
      {
        kind: "new",
        title: "팀 필터와 팀별 비용",
        body: "필터 바에서 팀을 고르고, 모든 사용자 화면에 팀 열이 붙습니다. Claude 상세 Cost 페이지에 팀별 비용 표와 추이가 있습니다. 팀은 OTel team 속성에서 옵니다.",
        to: "/cost",
        detail: true,
        where: "Claude 상세 → Cost → 팀별 비용",
        refs: [200, 201, 208],
      },
      {
        kind: "new",
        title: "세션 턴과 일일 AI 인사이트",
        body: "Claude 상세 Overview에서 세션당 턴 수, 턴당 비용, 상위 사용자와 세션을 봅니다. 일일 인사이트를 설정한 설치에서는 전날 사용을 요약한 카드가 함께 나옵니다.",
        to: "/",
        detail: true,
        where: "Claude 상세 → Overview",
        refs: [186, 187],
      },
      {
        kind: "improved",
        title: "사용자별 비용의 채널·모델 막대",
        body: "공유 Cost 화면에서 같은 사용자 ID를 한 행으로 합치고, 금액 옆에 CCB·C4E·미분류·Codex 채널별 모델 막대를 표시합니다.",
        to: "/cost",
        where: "Cost → 사용자별 비용",
        refs: [214],
      },
      {
        kind: "improved",
        title: "AWS Price List 단가",
        body: "Codex와 Anthropic 외 Claude 모델의 추정 비용에 AWS Price List 단가를 주기적으로 반영하고, 목록에 없는 새 Bedrock 모델은 공개 모델 카드 단가를 찾아 씁니다. 추정치이며 청구서가 아닙니다.",
        to: "/cost",
        where: "Cost",
        refs: [179, 184, 185, 207],
      },
    ],
  },
]);

export const LATEST_RELEASE = RELEASES[0];
export const SEEN_KEY = "ccdash.releaseNotesSeen";

// Storage can throw from the getter itself (private mode, blocked site data).
export function seenVersion(storage) {
  try {
    return (storage ?? globalThis.localStorage)?.getItem(SEEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function markSeen(version = LATEST_RELEASE.version, storage) {
  try {
    (storage ?? globalThis.localStorage)?.setItem(SEEN_KEY, version);
  } catch {
    // Without storage the unseen dot simply stays visible.
  }
}

export const hasUnseenRelease = (storage) => seenVersion(storage) !== LATEST_RELEASE.version;

// Link target for an item: shared routes keep the current client selection and drop
// Claude detail; detail routes switch to Claude detail. null when not reachable.
export function releaseLink(item, search, enabledClients) {
  if (!item.to) return null;
  if (item.detail && !enabledClients.includes("claude")) return null;
  const params = new URLSearchParams(search);
  if (item.detail) {
    params.set("client", "claude");
    params.set("view", "detail");
    params.delete("backend");
  } else {
    // Mirrors ClientContext: shared views drop detail view and Claude-only filters.
    for (const key of ["view", "group", "project"]) params.delete(key);
  }
  params.sort();
  const query = params.toString();
  return { pathname: item.to, search: query ? `?${query}` : "" };
}
