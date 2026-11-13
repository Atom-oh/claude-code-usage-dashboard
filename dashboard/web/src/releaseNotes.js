// In-app release notes: the user-facing subset of CHANGELOG.md for each tagged release.
// CHANGELOG.md (English) stays the complete engineering record; the image build context is
// dashboard/ only, so these notes ship with the bundle instead of reading the root file.
// Release policy: docs/runbooks/releases.md. releaseNotes.test.js keeps versions, dates,
// package.json and CHANGELOG headings aligned.
//
// item.kind: "new" | "improved" | "fixed". item.to: an app route, or null when the feature
// has no page (where explains how to reach it). item.detail: the route lives in Claude
// detail view (?client=claude&view=detail), so the link is hidden when Claude is disabled.
export const RELEASES = [
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
];

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
