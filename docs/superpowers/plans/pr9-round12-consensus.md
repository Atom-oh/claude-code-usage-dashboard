# PR #9 Round 12 대응 — 4-Lens 심층 수정 (TDD plan)

## Context
PR #9 Round 12 AI 리뷰(commit `6d1bf0f`)가 BLOCKED. 4개 MAJOR: incBucketed 첫
부분 버킷 누락(KPI vs 시계열 ~1.58% 불일치), uniq/존재 쿼리 좌경계 확대,
costByModelCompare 창이 형제 cost 카드와 불일치, backfill 스크립트 "부재" 오탐.
각 태스크는 파일 스코프를 명시하고, 결정이 필요한 지점은 co-agent 패널(P2 게이트)
교차검토로 확정한다.

### Task 1: costByModelCompare 창을 형제 cost 카드와 대칭화 (Lens 3)
**Files:**
- Modify: `dashboard/server/queries.js`
- Test: `dashboard/server/queries.test.js`

`costByModelCompare`가 내부에서 `[toStartOfHour(from), max(toStartOfHour(to),
curFrom+1h))`로 창을 재정렬해 `costSummary`/`costByModel`(incFlat 경로, 정확한
`[from,to)` + from-hour baseline 보정)과 다른 모수를 비교한다.

- [ ] span이 `incFlatRaw` 임계(4h) 이하면 raw 테이블로 정확한 `[from,to)` +
  동일 길이 prev 창을 계산하는 경로로 분기한다
- [ ] span>4h인 rollup 경로에는 incFlat과 동일한 from-hour baseline 보정
  (`greatest(rollup, raw로 구한 from 시점 값)`)을 cur/prev 양쪽에 적용한다
- [ ] 실패 테스트 추가: costByModelCompare(sub-4h span)의 SQL이 raw 테이블을
  참조하는지, rollup 분기가 incFlat과 동일한 stitch 패턴을 쓰는지 문자열 매칭
- [ ] 라이브 ClickHouse로 costByModelCompare(cur) 값이 costSummary와 동일 창에서
  일치하는지 실측 확인

### Task 2: incBucketed 첫 부분 버킷 raw stitch (Lens 1)
**Files:**
- Modify: `dashboard/server/queries.js`
- Test: `dashboard/server/queries.test.js`

`incBucketed`가 `WHERE t >= {from}`으로 from이 속한 첫 부분 버킷을 통째로 버려
incFlat(스냅샷) 합계와 어긋난다(기본 2일 뷰에서 실측 ~1.58% 차이).

- [ ] incFlat과 동일한 from-hour raw stitch를 UNION ALL로 추가해 첫 버킷
  (`t = 버킷 시작`)의 baseline을 raw `maxIf(Value, TimeUnix < from)`/`sumIf(...)`로
  보정한 합성 행을 만든다
- [ ] 3단 중첩(집계→lagInFrame window→바깥 WHERE)의 lag 체인이 합성 행 삽입으로
  깨지지 않도록 window PARTITION의 ORDER BY t 순서를 보존한다
- [ ] 실패 테스트 추가: 라이브 데이터로 KPI 스냅샷 합 == 시계열 버킷 합 재현
  (비정각 from)

### Task 3: uniq/존재 쿼리 좌경계 처리 (Lens 2, 패널 판정에 따름)
**Files:**
- Modify: `dashboard/server/queries.js`
- Test: `dashboard/server/queries.test.js`
- Modify: `docs/api-reference.md`

`activeUsers`/`adoptionLevels`/`adoptionTimeseries`/`userHeatmap`이
`hour >= toStartOfHour(from)`로 from 직전 부분 hour 활동까지 포함한다.

- [ ] P2 게이트 패널 판정(fix vs document, 지표별로 다를 수 있음)에 따라 구현
- [ ] Fix 판정 지표: from-hour만 raw `uniqExact`로 대체해 정확한 `[from,to)`
  존재 판정
- [ ] Document 판정 지표: 코드 주석 + `docs/api-reference.md`에 ±1h 그레인
  한계를 명시

### Task 4: backfill 스크립트 오탐 반박 (Lens 4)
**Files:**
- Test: `dashboard/server/queries.test.js`

`scripts/backfill-hourly-rollup.sh`는 실존·트래킹됨. 코드 변경 없음, PR 코멘트로만
대응(파일 스코프 없음이지만 파이프라인 스캐폴딩상 최소 한 개 파일이 필요해
회귀 방지용 존재 확인 테스트를 추가한다).

- [ ] `git log`/`git diff main...HEAD --stat`으로 파일 존재·PR diff 포함 여부
  재확인
- [ ] PR 코멘트에 반박 근거 게시(구현 태스크 완료 후 P5에서)

### Task 5: Executive.jsx 커스텀 줌 라벨 (MINOR)
**Files:**
- Modify: `dashboard/web/src/pages/Executive.jsx`

커스텀 sub-day 줌에서 `Math.ceil(daysInRange)` 기반 헤드라인/서브타이틀이
"지난 1일간"으로 표시돼 10분/2시간 줌에서도 오해를 유발한다.

- [ ] duration 기반 라벨(1일 미만이면 시/분 단위 표시)로 교체

### Task 6: Cost.jsx interval 재동기화 deps (MINOR)
**Files:**
- Modify: `dashboard/web/src/pages/Cost.jsx`

로컬 `intervalHours` 재동기화 `useEffect` deps가 `[defaultIntervalHours, days]`뿐
이라 커스텀 줌 구간 전환 시 이전 default와 같은 값이면 재동기화가 안 될 수 있다.

- [ ] deps에 custom range identity(`from`/`to`의 `getTime()`)를 추가

## Verification
- `cd dashboard/server && node --test *.test.js` 전부 통과
- `cd dashboard/web && npm run build` 성공
- 라이브 ClickHouse(`chi-cc-ab-replicated-0-0-0`)로 비정각 from 기준 KPI 스냅샷
  합계 == 시계열 버킷 합계 실측 확인(Task 2), costByModelCompare cur 값이
  costSummary와 동일 창에서 일치하는지 실측 확인(Task 1)
