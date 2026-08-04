# 시스템 동작 설명서

> "키워드 하나만 던지면, 검수만 하면 되는 블로그 글 패키지가 완성되는 시스템"
> Claude Code 위에서 동작하는 블로그 자동화 도구.

---

## 한 줄 요약

```
/blog-new "키워드"  →  리서치 → 글 → 이미지 → 품질검사 → 발행 어시스턴트  →  사람 검수 → 발행
        ↑                                                                              ↑
   사용자 명령 1줄                                                              사람이 하는 유일한 일
```

---

## 핵심 설계 원칙 5가지

1. **외부 의존성 0** — `npm install` 안 함. Node 20+ 내장 fetch만 사용.
2. **단일 진실 공급원** — `knowledge/brand-facts.md`에만 회사 사실을 둠. AI는 여기 있는 숫자만 사용.
3. **결정론적 검증** — "잘 썼어요"가 아니라 "키워드 11회/금칙어 0개/유사도 1.3%" 출력.
4. **자동 회피** — `output/_index.json`에 발행 이력을 박아 직전 글과 다른 패턴/도입부 강제.
5. **사람이 발행** — 자동 발행 코드 의도적으로 없음. 발행 어시스턴트가 복붙 마찰만 0으로 줄임.

---

## 동작 흐름

### 1. 명령 입력
```
/blog-new "병원 마케팅"
```

### 2. 리서치 (blog-researcher 서브에이전트)
- `scripts/research.js` → 네이버 Search API → 경쟁도/롱테일/연관 키워드
- 실패 시 WebSearch로 대체
- 출력: `output/<날짜>_<키워드>/research.json`

### 3. 글쓰기 (blog-writer 서브에이전트)
- 사전 로드: `brand-facts.md` / `tone-samples` / `patterns` / `_index.json`
- A.E.A 구조 (권위 → 근거 → 행동) + 도입부 4줄 공식
- 출력: `post.md`, `post.html`, `metadata.json`

### 4. 자동 검증 (PostToolUse 훅)
글 저장 → `.claude/settings.json` 훅 → `hook-post-write.js`:
- `quality-check.js` (금칙어·제목·이미지 메타 등 하드 게이트 항목은 exit 2, 나머지는 WARN)
- `duplicate-check.js` (6-gram jaccard + containment + 제목 축 + 12어절 연속일치, 하나라도 걸리면 exit 2)
- 둘 중 하나라도 exit 2면 훅도 exit 2 — 단, 같은 글에 3회 연속 실패하면 무한루프 방지로 자동 통과 전환
- 의료/뷰티 키워드면 `medical-law-checker` 추가 호출

### 5. 이미지 생성
- `generate-images.js` → Nano Banana Pro REST 호출, `--subject`/`--points` 필수(비면 즉시 실패)
- 5종: 히어로(16:9) / 디테일(1:1) / 제품(2:3) / 장면(4:3) / 클로징(3:4) — 전부 텍스트 없는 순수 사진, `knowledge/image-axes.json`으로 앵글·조명·배경 로테이션
- `assets/product-master.jpg` 있으면 5장 전부에 참조 이미지로 첨부(제품 일관성)

### 6. 발행 어시스턴트
- `preview.js` → self-contained HTML → 브라우저 자동 오픈
- 좌: 섹션별 복사 버튼 (서식 포함 / 텍스트만)
- 우: 메타카드 + 이미지 갤러리 + 발행 체크리스트 10개

### 7. 사람 검수 → 네이버 스마트에디터에 복붙 → 발행

---

## 폴더 의미

| 폴더 | 의미 |
|:---|:---|
| `knowledge/` | 회사에 대한 사실의 유일한 출처. 매번 글 쓸 때 먼저 읽음. |
| `scripts/` | 외부 의존성 0의 결정론적 도구들. |
| `templates/` | 이미지 생성 폴백 골격 (HTML). |
| `.claude/commands/` | 슬래시 커맨드 (사용자 진입점). |
| `.claude/agents/` | 서브에이전트 (책임 분리). |
| `keyword-bank/` | 카테고리별 시드 키워드 풀. |
| `output/` | 생성된 글 + 이미지 + 메타. gitignored. |

---

## 왜 이렇게 만들었는가

### Q. 왜 외부 패키지를 안 쓰나요?
- 누구나 clone → 즉시 실행. `npm install` 마찰 0.
- 의존성 보안 사고 0.
- Node 20+ fetch가 충분합니다.

### Q. 왜 자동 발행 안 만드나요?
- 네이버는 발행 API가 폐쇄돼 있습니다.
- 무엇보다, **자동 발행 = 저품질 폭증**입니다. 사람이 검수하는 게 정답.

### Q. 왜 LLM에게 검증을 안 맡기나요?
- LLM은 "잘 썼어요"라고 답합니다. 거짓말입니다.
- 결정론적 코드는 "키워드 17회 ❌"라고 말합니다. 믿을 만합니다.

### Q. 왜 한 파일에 사실을 박나요?
- 정보가 흩어지면 매번 다른 숫자가 나옵니다. (드리프트)
- 한 곳에만 두면 한 번만 고치면 됩니다.
- 이게 **Single Source of Truth**의 힘입니다.
