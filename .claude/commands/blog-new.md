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

## 2. 콘텐츠 생성 (STEP 2)
- `blog-writer` 서브에이전트에 위임 또는 직접 작성
- 12패턴 중 가장 적합한 것 1~2개 선택 (최근 글과 다른 것)
- A.E.A 구조 + 도입부 4줄 공식 + 문체 변주 규칙 준수
- `post.md` 와 `post.html` 작성
- `output/<폴더>/` 에 저장 → 훅이 자동으로 품질검사·유사도검사 실행

## 3. 이미지 생성 (STEP 3)
콘텐츠 작성이 끝난 뒤, 글의 핵심 주제를 한 줄로 요약한 `--subject` 값을 준비하세요 (예: "호텔급 면 수건의 품질 차이와 선택 기준").

```bash
set -a && . ./.env && set +a && node scripts/generate-images.js \
  --title "..." --keyword "$ARGUMENTS" \
  --points "..." --quote "..." --steps "..." \
  --subject "글 핵심 주제 한 줄 요약" \
  --output "output/<폴더>/images"
```

총 7장 생성 (디자인 4장 + 상황 이미지 3장):
- `thumbnail.png` / `infographic.png` / `quote-card.png` / `process.png` — 정보 디자인형
- `scene-1.png` (라이프스타일 환경컷) / `scene-2.png` (텍스처 클로즈업) / `scene-3.png` (무드 감성컷) — 실사풍

## 4. 품질 검증 (STEP 4)
훅이 자동 실행하지만, 경고가 나오면 본문을 수정하고 재검사.

의료/뷰티 키워드인 경우 `medical-law-checker` 서브에이전트도 호출.

## 5. 최종 패키지 (STEP 5)
- `metadata.json` (패턴 번호·톤 변주·품질 리포트)
- `guide.md` (편집 가이드 · 사실 확인 체크리스트 · 이미지 삽입 위치)
- `output/_index.json` 에 새 글 항목 추가 + `recent_rotation` 갱신

## 완료 후 사용자에게 보고할 것
- 제목 / 글자수 / 패턴 / 톤 변주 조합
- 품질검사 결과, 유사도 검사 결과
- 이미지 7장 생성 여부 (디자인 4장 + 상황 이미지 3장)
- 발행 전 사람이 확인해야 할 항목 (수치·레퍼런스)
- 다음 단계: `/blog-preview <폴더>` 로 발행 어시스턴트 실행
