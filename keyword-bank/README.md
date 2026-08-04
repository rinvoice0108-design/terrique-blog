# keyword-bank/ — 카테고리별 롱테일 키워드 풀

카테고리별로 SEO 자산이 될 키워드를 누적 관리합니다. "오늘 뭘 쓸까" 고민할 시간을 줄이고, 카테고리별 노하우 연재로 장기 SEO 자산을 쌓는 것이 목적입니다.

## 파일 목록

| 파일 | 카테고리 |
|:---|:---|
| `commercial-towel.yml` | 업소용 수건 |
| `gift-set.yml` | 답례품/선물세트 |
| `premium-towel.yml` | 프리미엄/호텔 수건 |

> 다른 카테고리로 확장하려면 `/setup-domain` 명령으로 새 yml을 자동 생성하세요. (2026-08-04: 실사용 도메인과 무관했던 예시 시드 4종 — 상세페이지/병원/뷰티/AI 마케팅 — 삭제)

## 데이터 형식

```yaml
keywords:
  - keyword: "상세페이지 제작 비용"
    intent: pricing            # pricing / comparison / how-to / case-study / trend
    funnel_stage: comparison   # awareness / interest / comparison / decision
    priority: high             # high / medium / low
    competition: unknown       # high / medium / low / unknown — research.js로 검증 후 갱신
    suggested_pattern: 4       # 12패턴 중 추천 번호
    longtails:
      - "상세페이지 제작 비용 평균"
      - "스마트스토어 상세페이지 외주 비용"
    last_used: null            # 마지막 사용 날짜 (중복 방지)
    notes: ""
```

## 사용 흐름

1. 새 글 쓸 때 카테고리 yml 열어서 `last_used: null` 또는 `30일 이전` 키워드 골라
2. `priority: high` 우선
3. `/blog-research <키워드>` → 경쟁도 검증
4. 글 작성 → `last_used` 갱신

## 업데이트 원칙

- `competition` 필드는 `research.js` 결과로 한 달에 한 번 일괄 업데이트
- 새 키워드는 `priority: medium`부터 시작
- 사용 후 반드시 `last_used` 기록 (중복 발행 방지)
- 발행해서 잘 나온 키워드는 `notes` 에 성과 메모

## ⚠️ 주의

이 파일의 키워드는 **시드 후보**입니다. 실제 발행 전 반드시:
1. 여러분 사업 방향과 부합하는지 사람이 한 번 더 확인
2. `research.js` 로 경쟁도 실측
3. 의료법 키워드면 `medical-law-checker` 사전 통과
