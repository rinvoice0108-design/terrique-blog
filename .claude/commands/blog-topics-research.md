---
description: 웹서치·네이버 블로그/카페 데이터로 새 블로그 주제 후보를 발굴하고, 기존 구글시트와 중복되지 않는 것만 검색 수요 우선순위로 정리
argument-hint: "[선택: 집중 카테고리, 예: 세탁 관리 — 생략하면 전 카테고리]"
---

> ⚠️ **2026-08-11부로 이 명령은 1차 경로가 아니라 수동/보조 경로다.** 같은 일(네이버 실측 소스
> 수집 → Claude 배치 분류 → 구글시트 "후보" 탭 적재)을 `terrique-custom` 관리자 사이트
> "블로그 협찬 → 블로그 주제" 화면의 **"주제 생성" 버튼**이 훨씬 싸고(1회 $0.5~2 → $0.3대)
> 빠르게(여러 턴 에이전트 → 배치 API 호출 몇 번) 해준다 — `lib/blog-sponsor/topic-sourcing.ts`,
> `lib/magazine/topic-sourcing.ts`와 같은 패턴. 웹서치처럼 정형 API로 못 도는 소스가 필요하거나,
> 버튼으로 안 되는 특수 카테고리 조사를 할 때만 이 명령을 쓸 것.

사용자가 새 블로그 주제 후보를 찾아달라고 요청했습니다. 브레인스토밍만 하지 말고, 후보마다 실제 데이터(네이버 블로그·카페 검색량, 최근 활동도)를 붙여서 근거 있는 우선순위로 제시하세요.

집중 카테고리 지정: "$ARGUMENTS" (비어있으면 전 카테고리 대상)

## STEP 0. 기존 시트 전체 로드 (중복 판정 기준)

**(1) "키워드" 탭 — 실제 발행 대상(사용됨+미사용 전부):**

```bash
set -a && . ./.env && set +a && node -e "
import('./scripts/sheets-tracker.js').then(async (m) => {
  const rows = await m.fetchKeywordsWithStatus(process.env.SHEETS_ID);
  console.log(JSON.stringify(rows.map(r => r.keyword)));
});
"
```

이 목록(사용됨+미사용 전부)이 "이미 다룬 주제"입니다. 사용됨 항목도 이미 발행된 거니 후보에서 제외 대상입니다.

**(2) "후보" 탭 — 이전에 이 명령으로 찾아뒀지만 아직 검토·채택되지 않은 대기 중인 후보 (반드시 확인, 빠뜨리면 같은 주제를 중복으로 또 쌓게 됨):**

```bash
set -a && . ./.env && set +a && node -e "
import('googleapis').then(async ({ google }) => {
  const auth = new google.auth.GoogleAuth({ keyFile: './service-account.json', scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SHEETS_ID, range: '후보!A:A' });
  console.log(JSON.stringify((res.data.values || []).slice(1).map(r => r[0]).filter(Boolean)));
});
"
```

이 목록은 아직 "키워드" 탭으로 넘어가지 않았을 뿐, 이미 이 명령이 한 번 찾아서 제시한 후보들입니다. 사람이 관리자 사이트에서 검토(수정/채택/거절)하기 전이라도 **새로 찾을 필요가 없으니 (1)과 동일하게 제외 대상**으로 취급하세요.

## STEP 1. 원시 후보 브레인스토밍 (여러 소스 조합, 최소 20~30개)

다음을 전부 확인하고 종합하세요 — 한 소스만 쓰지 말 것:

1. **`knowledge/facts.json` 읽기** — grade가 `공식`/`학술`/`업계관행`인 항목 중 아직 블로그에서 안 다룬 듯한 사실이 있으면 주제 후보로 전환(사실 기반이라 신뢰도 있는 글이 나옵니다). 예: "ASTM D5433 성능 표준", "무연사가 업소용에 부적합한 이유" 등.
2. **`keyword-bank/*.yml` 읽기** — 이미 쌓아둔 시드 키워드 중 `last_used: null`이거나 오래된 것.
3. **WebSearch — 실제 웹/블로그 화제** — "수건 관리 팁", "타월 상식", 브랜드 관련 카테고리(호텔수건/업소용/답례품 등)로 검색해 최근 다뤄지는 화제·경쟁사 콘텐츠 갭을 파악.
4. **WebSearch — 유튜브 검색어 대용** — `site:youtube.com` 포함 검색이나 "수건 유튜브" 류 검색으로 영상 콘텐츠에서 다루는 주제 파악(유튜브 API 연동은 없으므로 웹서치로 근사).
5. **네이버 자동완성/연관검색어** — WebFetch로 네이버 검색 결과 페이지를 열어 연관검색어 섹션을 확인하거나, WebSearch로 "수건 [키워드]" 조합의 실제 검색 패턴 파악.

이 단계는 정성적 브레인스토밍입니다 — 다음 단계에서 실측 데이터로 걸러냅니다.

## STEP 2. 기존 시트와 1차 중복 제거

STEP 0에서 가져온 두 목록(키워드 탭 + 후보 탭) 전부와 각 후보를 비교해 의미상 겹치는 것을 스스로 판단해 제외하세요(예: "수건 냄새 제거"와 "수건 쉰내 없애는 법"은 문자열은 달라도 같은 주제). 애매하면 `scripts/duplicate-check.js`가 쓰는 것과 같은 개념(짧은 키워드는 3-gram 유사도)으로 판단해도 됩니다.

## STEP 3. 살아남은 후보를 실측 데이터로 검증 (핵심 — 반드시 실행)

후보를 15~20개로 추린 뒤, 각각 실제 네이버 데이터를 붙이세요:

```bash
set -a && . ./.env && set +a && node scripts/research.js --keyword "<후보>"
```

각 후보에서 다음을 기록:
- `opportunity.score` / `opportunity.label` (★★★강추/★★권장/★주의) — **이게 우선순위 기준**입니다. 경쟁(전체 포스팅 수)이 낮고 최근 활동 비율이 높을수록 점수가 높습니다.
- `blog.competition` (높음/보통/낮음)
- `blog.trend_velocity` (가속/안정/감속)
- `keyword_journey_stage` (구매여정 몇 단계인지)
- `blog.total` (전체 포스팅 수 — 경쟁 규모 감)

API 호출이 후보 수만큼 나가므로(네이버 오픈API, 무료 한도 내) 20개를 넘기지 마세요. 실패하는 후보는 API 오류 메시지와 함께 건너뛰고 계속 진행하세요.

## STEP 3.5. "답례품 키워드" 탭과 추가 대조 (답례품/자수/어린이집 계열 후보만 해당)

구글시트에 "키워드" 탭 말고 **"답례품 키워드" 탭**이 따로 있고, 여기 이미 106개(2026-08-04 기준)의 답례품·자수·어린이집 관련 후보가 준비돼 있다. 답례품/자수/어린이집 관련 후보를 냈다면 반드시 이 탭도 조회해서 겹치는지 확인하고, 겹치면 후보에서 빼거나 근거란에 "⚠️ 답례품 키워드 탭에 유사 항목 있음"이라고 표시할 것:

```bash
set -a && . ./.env && set +a && node -e "
import('googleapis').then(async ({ google }) => {
  const auth = new google.auth.GoogleAuth({ keyFile: './service-account.json', scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SHEETS_ID, range: '답례품 키워드!A:B' });
  console.log(JSON.stringify((res.data.values || []).map(r => r[0])));
});
"
```

## STEP 4. 우선순위 정렬 + 저장 (구글시트 "후보" 탭 + 바탕화면 CSV, 둘 다)

`opportunity.score` 내림차순으로 정렬한 뒤 **두 곳에 저장**하세요:

**(1) 구글시트 "후보" 탭** — `terrique-custom` 관리자 사이트의 "블로그 예상 주제" 화면이 여기서 읽습니다. 이게 진짜 작업 큐입니다:

```bash
set -a && . ./.env && set +a && node -e "
import('./scripts/sheets-tracker.js').then(async (m) => {
  const candidates = [
    { keyword: '...', opportunity: '92 ★★★', competition: '낮음(19,125건)', trend: '가속', journeyStage: '4단계(구매직전)', rationale: '...' },
    // ...정렬된 후보들
  ];
  for (const c of candidates) {
    await m.addCandidate(process.env.SHEETS_ID, { ...c, addedAt: new Date().toISOString().slice(0,10) });
  }
  console.log(candidates.length, '개 후보 탭에 추가됨');
});
"
```

**(2) 바탕화면 CSV** — 빠르게 훑어보기용 개인 참고 사본(엑셀에서 바로 열림, UTF-8 BOM 필수):

```bash
node -e "
const fs = require('fs');
const rows = [
  ['순위','키워드','기회도','경쟁도','트렌드','구매여정','근거'],
  // ...정렬된 후보들
];
const csv = rows.map(r => r.map(c => '\"' + String(c).replace(/\"/g,'\"\"') + '\"').join(',')).join('\r\n');
fs.writeFileSync('C:/Users/R1/Desktop/블로그_주제_후보_<오늘날짜>.csv', '\uFEFF' + csv);
"
```

"근거" 칸에는 STEP 1에서 이 후보를 왜 골랐는지(facts.json 근거/웹서치 화제/키워드뱅크 등) 한 줄로 남기세요.

추가로 **현재 시트의 구매여정 단계 분포**도 같이 보여주세요(STEP 0 목록 + research.js 판정 기준으로 대략 추정) — 특정 단계(특히 4단계 구매 직전)가 부족하면 그 단계 후보를 우선 추천하세요.

## STEP 5. 사용자에게 요약 보고

저장 완료 후 이렇게 안내하세요: "N개 후보를 구글시트 '후보' 탭과 바탕화면 CSV에 저장했습니다. 관리자 사이트 '블로그 협찬 → 블로그 예상 주제'에서 확인·수정하고 채택하시면 실제 주제 목록으로 들어갑니다."

**절대 사용자 승인 없이 진짜 "키워드" 탭(실제 발행 대상)에 직접 추가하지 마세요.** 이 명령은 "후보" 탭까지만 채우는 게 목적이고, 후보→실제 채택은 관리자 사이트 UI(또는 사용자의 명시적 지시)에서만 일어납니다.
