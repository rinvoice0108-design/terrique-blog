---
description: 발행 직전 최종 체크리스트 (사실 확인·이미지·링크·의료법)
argument-hint: <폴더명>
---

"$ARGUMENTS" 글을 발행 직전 상태로 최종 검증합니다.

아래 체크리스트를 **하나씩** 검사하고, 각 항목을 PASS/FAIL/REVIEW 로 표시하세요:

## 1. 수치 사실 확인
- `post.md` 에서 숫자·수치를 모두 추출
- 각 숫자가 `knowledge/brand-facts.md` 또는 `knowledge/conversion-benchmarks.md` 에 있는지 확인
- 없는 수치는 FAIL (픽션 금지)

## 2. 금칙어·최상급
- `knowledge/banned-words.json` 로드
- 본문에서 superlatives / medical_law / ai_cliches 탐지
- 하나라도 있으면 FAIL + 위치 지적

## 3. 의료법 (병원·시술 키워드일 때만)
- 키워드에 "병원·시술·필러·보톡스·피부·성형·치과·한의원·의원·성과·효과" 등이 있으면
- `medical-law-checker` 서브에이전트 호출 권장

## 4. 이미지 5장 존재 확인
- `images/01-hero.*`
- `images/03-detail.*`
- `images/04-product.*`
- `images/05-scene.*`
- `images/07-closing.*`
- 파일 크기가 10KB 미만이면 생성 실패 가능성 → REVIEW

## 5. 외부 링크 0건
- `post.html` 에서 `http://`, `https://` 탐지
- 있으면 FAIL

## 6. 품질·유사도 재실행
- `scripts/quality-check.js` + `scripts/duplicate-check.js`
- 전 항목 PASS 여야 함

## 7. metadata.json / guide.md 존재
- 없으면 FAIL

## 8. `output/_index.json` 반영
- 해당 글이 `posts[]` 에 있는지
- 없으면 추가

## 최종 보고
사용자에게 체크리스트 결과를 표로 제시하고, FAIL/REVIEW 항목만 수정 방향 제안.
모든 항목 PASS면 "발행 준비 완료 — 스마트에디터에서 수동 업로드하세요" 안내.
