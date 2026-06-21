---
description: 키워드 하나로 블로그 글 패키지 풀 파이프라인 실행 (리서치→작성→이미지→검증)
argument-hint: <키워드>
---

사용자가 "$ARGUMENTS" 키워드로 블로그 글을 만들어달라고 요청했습니다.

> ⚠️ **사전 체크**: `knowledge/brand-facts.md`가 placeholder 상태(`[PLACEHOLDER]`로 시작)면 먼저 사용자에게 `/setup` 실행을 안내하고 중단하세요. /setup 없이 글을 쓰면 회사 정보가 빠진 일반 글이 나옵니다.

CLAUDE.md의 실행 파이프라인에 따라 아래 순서를 **반드시 전부** 수행하세요:

## 0. 사전 로드 (생략 금지)
다음 파일을 먼저 Read로 읽습니다:
1. `knowledge/brand-facts.md` — 회사 수치·인증·자사 제품 정보 (Single Source of Truth)
2. `knowledge/tone-samples/real-blog-posts.txt` — 실제 회사 블로그 문체 (있을 경우)
3. `knowledge/patterns/writing-playbook.txt` — 글쓰기 패턴 가이드 (있을 경우)
4. `knowledge/banned-words.json` — 금칙어 (도메인 단어 포함)
5. `output/_index.json` — 최근 사용한 패턴/도입부 확인 (있을 경우 — 의도적으로 다른 조합 선택)

## 1. 키워드 리서치 (STEP 1)
```bash
set -a && . ./.env && set +a && node scripts/research.js --keyword "$ARGUMENTS" --output "output/$(date +%Y-%m-%d)_$(echo $ARGUMENTS | tr -d ' ')"
```
API 인증 실패 시 웹 검색 기반으로 대체 리서치.

리서치 결과에서 반드시 확인:
- `keyword_journey_stage`: 이 키워드가 구매 여정 몇 단계인지
- `longtail_journey_stages`: 고전환(3~4단계) 롱테일 후보
- 3~4단계 키워드 → 의심 해소/구매 직전 고객 대상 → PASONA 구조 우선
- 1~2단계 키워드 → 정보/문제 인식 고객 대상 → 문제 공감 → 교육 → 해결책 구조

**글 쓰기 전 고객 심리 분석 (3문장):**
1. 이 키워드로 오는 고객의 치명적인 문제(마이너스→0)는 무엇인가?
2. 이 고객이 우리 제품 선택을 망설이는 이유는?
3. 공공의 적(시장의 문제/잘못된 관행)으로 삼을 수 있는 것은?

## 2. 콘텐츠 생성 (STEP 2)
- `blog-writer` 서브에이전트에 위임 또는 직접 작성
- 구매 여정 단계에 맞는 글 구조 선택
- 가편신 도입부 + PASONA 구조 + 공공의 적 전략 적용
- `post.md` 와 `post.html` 작성
- `output/<폴더>/` 에 저장 → 훅이 자동으로 품질검사·유사도검사 실행

글 작성 완료 후 `output/<폴더>/metadata.json` 을 아래 필드 포함해 Write:
```json
{
  "keyword": "<키워드>",
  "title": "<글 제목>",
  "description": "<메타 설명 80자 이내>",
  "tags": ["태그1", "태그2", "태그3"],
  "pattern": "<사용한 패턴명>",
  "intro_type": "<도입부 유형>",
  "created_at": "<YYYY-MM-DD>",
  "image_points": "<핵심 포인트 3개 |||로 구분 예: 흡수력 우수|||부드러운 촉감|||오래 사용 가능>",
  "image_quote": "<글에서 가장 임팩트 있는 문구 1줄>",
  "image_steps": "<단계 3개 |||로 구분 예: 올바른 세탁|||완전 건조|||보관법>",
  "image_subject": "<이미지 생성용 핵심 주제 한 줄>"
}
```

## 3. 이미지 생성 (STEP 3)
콘텐츠 작성이 끝난 뒤, 글의 핵심 주제를 한 줄로 요약한 `--subject` 값을 준비하세요 (예: "호텔급 면 수건의 품질 차이와 선택 기준").

```bash
set -a && . ./.env && set +a && node scripts/generate-images.js \
  --title "..." --keyword "$ARGUMENTS" \
  --points "..." --quote "..." --steps "..." \
  --subject "글 핵심 주제 한 줄 요약" \
  --output "output/<폴더>/images"
```

총 7장 생성 (모두 사진 전용 — 텍스트/타이포그래피 이미지 없음):
- `01-hero.png` (16:9 히어로 사진) / `02-opening.png` (4:3 상황 오프닝) / `03-detail.png` (1:1 텍스처 클로즈업)
- `04-product.png` (2:3 제품/배치 플랫레이) / `05-scene.png` (4:3 결과 장면) / `06-ambient.png` (1:1 분위기 인테리어) / `07-closing.png` (3:4 무드 클로징)

## 4. 품질 검증 (STEP 4)
훅이 자동 실행하지만, 경고가 나오면 본문을 수정하고 재검사.

의료/뷰티 키워드인 경우 `medical-law-checker` 서브에이전트도 호출.

## 5. 최종 패키지 (STEP 5)

`guide.md` 작성 (편집 가이드 · 이미지 삽입 위치 · 사실 확인 체크리스트).

`output/_index.json` Read 후 아래 형식으로 업데이트해 Write:
```json
{
  "last_updated": "<오늘 YYYY-MM-DD>",
  "posts": [
    ...기존 posts 배열...,
    {
      "folder": "<폴더명>",
      "keyword": "<키워드>",
      "title": "<제목>",
      "pattern": "<패턴>",
      "intro_type": "<도입부유형>",
      "created_at": "<날짜>"
    }
  ],
  "recent_rotation": {
    "patterns_used": [최근 5개 패턴 (오래된 것부터 새 것 순)],
    "intro_types_used": [최근 5개 도입부],
    "tone_signatures_used": [이번 글에 사용한 시그니처 표현들]
  }
}
```

## 완료 후 사용자에게 보고할 것
- 제목 / 글자수 / 패턴 / 톤 변주 조합
- 품질검사 결과, 유사도 검사 결과
- 이미지 7장 생성 여부 (모두 사진 전용, 텍스트 없음)
- 발행 전 사람이 확인해야 할 항목 (수치·레퍼런스)
- 다음 단계: `/blog-preview <폴더>` 로 발행 어시스턴트 실행
