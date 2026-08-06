#!/usr/bin/env node
/**
 * 블로그 품질 검증기 — 네이버 저품질 트리거 사전 검사.
 * Usage: node scripts/quality-check.js --file post.html [--keyword "병원 마케팅"]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BANNED_WORDS_PATH = join(ROOT, 'knowledge', 'banned-words.json');
const FACTS_PATH = join(ROOT, 'knowledge', 'facts.json');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

const stripHtml = (s) =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

// knowledge/banned-words.json을 실제 소스로 사용 (예전엔 이 파일과 별개인
// 하드코딩 배열을 썼음 — 두 리스트가 어긋나던 문제 수정).
let bannedWordsCache = null;
async function loadBannedWords() {
  if (bannedWordsCache) return bannedWordsCache;
  const raw = await readFile(BANNED_WORDS_PATH, 'utf8');
  const data = JSON.parse(raw);
  const cat = data.categories || {};
  bannedWordsCache = {
    superlatives: cat.superlatives?.words || [],
    domainSpecific: cat.domain_specific?.words || [],
    aiCliches: cat.ai_cliches?.words || [],
    conjunctions: cat.overused_conjunctions?.words || [],
    conjunctionMaxRatio: cat.overused_conjunctions?.max_ratio_percent ?? 5,
    exaggeratedPatterns: (cat.exaggerated_percent?.patterns || []).map((p) => new RegExp(p)),
    exceptionPhrases: data.exceptions?.phrases || [],
  };
  return bannedWordsCache;
}

// knowledge/facts.json — 본문의 숫자+단위 주장이 검증된 사실 목록에 있는지 대조.
// 파일이 없으면(아직 /setup 안 함) 조용히 스킵 — 하드 요구사항 아님.
let factsCache = null;
async function loadFacts() {
  if (factsCache) return factsCache;
  try {
    const raw = await readFile(FACTS_PATH, 'utf8');
    const data = JSON.parse(raw);
    factsCache = Array.isArray(data.facts) ? data.facts : [];
  } catch {
    factsCache = [];
  }
  return factsCache;
}

const FACT_NUMBER_UNIT_RE =
  /\d+(?:[.,]\d+)?\s*(?:%|GSM|gsm|TPI|TPM|mg\/kg|kg|cm|mm|㎡|℃|도|수|배|년|회|장|색)/g;

// 본문에서 숫자+단위 주장을 뽑아 facts.json에 근거가 있는지 대조 (WARN만 — 하드
// 게이트는 오탐률을 지켜본 뒤 4순위 이후 검토).
function checkFactClaims(text, facts) {
  const results = [];
  if (!facts.length) return results; // facts.json 미도입 상태면 검사 자체를 생략

  // '미검증' 등급 fact는 "이 수치는 출처 불분명" 식으로 나쁜 예시 숫자를 인용문
  // 안에 그대로 포함하는 경우가 있다(예: "유연제 흡수력 47% 감소 — 출처 불분명").
  // 이런 항목까지 haystack에 넣으면 경고하려던 그 숫자가 오히려 "검증됨"으로
  // 오판된다. 근거로 인정할 수 있는 등급만 매칭 대상에 포함.
  const haystack = facts
    .filter((f) => f.grade !== '미검증')
    .map((f) => f.text)
    .join(' ')
    .replace(/\s+/g, '')
    .toLowerCase();

  const claims = [...new Set((text.match(FACT_NUMBER_UNIT_RE) || []).map((m) => m.trim()))];
  const unmatched = claims.filter((c) => !haystack.includes(c.replace(/\s+/g, '').toLowerCase()));

  results.push({
    name: '사실 근거(facts.json) 대조',
    pass: unmatched.length === 0,
    detail:
      unmatched.length === 0
        ? claims.length
          ? `본문 수치 ${claims.length}개 모두 facts.json에서 근거 확인됨`
          : '본문에 대조할 수치 주장 없음'
        : `facts.json에 근거 없는 수치 주장: ${unmatched.join(', ')} — brand-facts.md/facts.json 확인 필요`,
  });

  return results;
}

/**
 * 대외 비공개 정보가 본문에 새어나갔는지 검사한다.
 *
 * facts.json 의 confidential:true 항목은 사내 참고용이라, 그 text 를 그대로
 * 가져다 쓰면 공개하면 안 되는 내용(제조공장 상호·소재지 등)이 딸려 나온다.
 * blog-writer 에게 프롬프트로 알려주는 것만으로는 놓치므로 여기서 막는다.
 *
 * 판정 대상은 confidential 항목의 text 에는 있고 public_alt 에는 없는
 * 고유명사류 토큰 — 즉 '공개 버전에서 의도적으로 빠진 말'이다.
 */
function checkConfidentialLeak(text, facts) {
  const results = [];
  const confidential = facts.filter((f) => f.confidential);
  if (!confidential.length) return results;

  const secrets = new Set();
  for (const f of confidential) {
    const pub = (f.public_alt || '').replace(/\s+/g, '').toLowerCase();
    // 영문 상호(2단어 이상)와 한글 고유명사 후보를 뽑는다
    const tokens = [
      ...(f.text.match(/[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.]+)+/g) || []),
      // 지명·상호는 대개 괄호 닫힘/쉼표/'공장' 앞에 온다 (예: "…(인도 구자라트)")
      ...(f.text.match(/[가-힣]{2,}(?=\s*[),]|\s*공장)/g) || []),
    ];
    for (const t of tokens) {
      const norm = t.replace(/\s+/g, '').toLowerCase();
      // public_alt 에도 들어 있으면 공개해도 되는 말이다
      if (norm.length >= 4 && !pub.includes(norm)) secrets.add(t.trim());
    }
  }

  const hits = [...secrets].filter((s) =>
    text.replace(/\s+/g, '').toLowerCase().includes(s.replace(/\s+/g, '').toLowerCase()),
  );

  results.push({
    name: '대외 비공개 정보 유출',
    pass: hits.length === 0,
    detail:
      hits.length === 0
        ? '비공개 항목(제조공장 상호 등) 노출 없음'
        : `⚠️ 대외 비공개 정보가 본문에 있음: ${hits.join(', ')} — facts.json 의 public_alt 표현으로 교체할 것`,
  });

  return results;
}

// 부분문자열 오탐 방지 — '완전'이 '완전히'/'불완전'에 걸리는 것처럼, 부정 접두사
// 뒤나 부사화 접미사 앞에 붙어 다른 단어가 된 경우는 제외.
const NEGATION_PREFIXES = new Set(['불', '비']);
const ADVERB_SUFFIXES = new Set(['히']);

// banned-words.json의 exceptions.phrases — "면 100%"처럼 마케팅 과장이 아니라
// 소재 표기 등 정당한 문맥인 구체적 구문. 매치 위치가 이 구간과 겹치면 무시.
function findExceptionSpans(text, phrases) {
  const spans = [];
  for (const phrase of phrases) {
    let idx = 0;
    while (true) {
      const found = text.indexOf(phrase, idx);
      if (found === -1) break;
      spans.push([found, found + phrase.length]);
      idx = found + phrase.length;
    }
  }
  return spans;
}

function overlapsAnySpan(pos, len, spans) {
  return spans.some(([s, e]) => pos < e && pos + len > s);
}

function findBannedHits(text, words, exceptionSpans = []) {
  const hits = [];
  for (const w of words) {
    let idx = 0;
    let matched = false;
    while (!matched) {
      const found = text.indexOf(w, idx);
      if (found === -1) break;
      const before = text[found - 1];
      const after = text[found + w.length];
      const boundaryFalsePositive =
        (before && NEGATION_PREFIXES.has(before)) || (after && ADVERB_SUFFIXES.has(after));
      const exceptionFalsePositive = overlapsAnySpan(found, w.length, exceptionSpans);
      if (!boundaryFalsePositive && !exceptionFalsePositive) {
        matched = true;
      } else {
        idx = found + w.length;
      }
    }
    if (matched) hits.push(w);
  }
  return hits;
}

function findExaggeratedMatches(text, patterns) {
  const hits = [];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

// 종결어미 반복 판정 — 예전엔 "끝 3글자 완전일치"라 "좋습니다"(습니다)와
// "말합니다"(합니다)를 다른 어미로 취급해 반복을 놓쳤다. 문체 카테고리로 먼저
// 분류하고, 카테고리 안에서만 못 찾으면 리터럴 3글자로 폴백한다.
// 더 구체적인 패턴을 먼저 두고, 마지막에 "니다"로 끝나는 모든 문장을 포괄하는
// 일반 규칙을 둔다 — 한글은 자모가 아니라 완성형 음절이라 'ㅂ니다' 같은 부분
// 자모 매치는 무의미하므로, 어미 전체 음절(습니다/합니다/됩니다/입니다 등)이
// 공유하는 꼬리 "니다"로 통합해 판정한다.
const ENDING_CATEGORIES = [
  { label: '-것입니다/-것이다체', re: /것(입니다|이다)[.!?]?$/ },
  { label: '-습니까(의문)', re: /습니까\??$/ },
  { label: '-어요/-아요체', re: /(어요|아요|해요|예요|이에요|돼요)[.!?]?$/ },
  { label: '-니다체(합니다/됩니다/습니다 등)', re: /니다[.!?]?$/ },
];
function classifyEnding(sentence) {
  const s = sentence.trim();
  for (const cat of ENDING_CATEGORIES) {
    if (cat.re.test(s)) return cat.label;
  }
  return s.slice(-3);
}

// AI 티 문체 검사 (4순위) — 쉼표 포함 문장 비율(KatFishNet 근거: 인간 26.31% vs
// LLM 61.03%), 번역투, 이중피동. AI 탐지기 점수 자체는 게이트로 쓰지 않고
// 이 결정론적 패턴들만 WARN으로 사용한다.
function checkAiStyle(text, sentences) {
  const results = [];

  const commaSentences = sentences.filter((s) => /[,，]/.test(s)).length;
  const commaRatio = sentences.length ? (commaSentences / sentences.length) * 100 : 0;
  results.push({
    name: '쉼표 포함 문장 비율',
    pass: commaRatio <= 35,
    detail: `${commaSentences}/${sentences.length}문장 = ${commaRatio.toFixed(1)}% (임계값 35%, 근거: KatFishNet — 인간 26.31% vs LLM 61.03%)`,
  });

  const TRANSLATIONESE = [
    { label: '~을 통해', re: /을\s?통해/g },
    { label: '~를 통해', re: /를\s?통해/g },
    { label: '~에 대한', re: /에\s?대한/g },
    { label: '~에 대해', re: /에\s?대해/g },
    { label: '~에 있어서', re: /에\s?있어서/g },
    { label: '~의 경우', re: /의\s?경우/g },
  ];
  const translationeseHits = [];
  for (const { label, re } of TRANSLATIONESE) {
    const n = (text.match(re) || []).length;
    if (n > 0) translationeseHits.push(`${label}×${n}`);
  }
  results.push({
    name: '번역투 표현',
    pass: translationeseHits.length === 0,
    detail: translationeseHits.length === 0 ? '없음' : `발견(자연스러운 한국어로 변경 권장): ${translationeseHits.join(', ')}`,
  });

  const DOUBLE_PASSIVE = [
    { label: '보여지다', re: /보여지/g },
    { label: '되어지다', re: /되어지/g },
    { label: '여겨지다', re: /여겨지/g },
    { label: '쓰여지다', re: /쓰여지/g },
    { label: '잊혀지다', re: /잊혀지/g },
    { label: '놓여지다', re: /놓여지/g },
  ];
  const doublePassiveHits = [];
  for (const { label, re } of DOUBLE_PASSIVE) {
    if (re.test(text)) doublePassiveHits.push(label);
  }
  results.push({
    name: '이중피동',
    pass: doublePassiveHits.length === 0,
    detail: doublePassiveHits.length === 0 ? '없음' : `발견(단일 피동으로 수정 권장): ${doublePassiveHits.join(', ')}`,
  });

  return results;
}

function check(text, raw, keyword, banned) {
  const results = [];
  const charCount = text.replace(/\s/g, '').length;

  // 1. 글자수
  results.push({
    name: '글자수',
    pass: charCount >= 1500,
    detail: `공백제외 ${charCount}자 (목표 ≥ 1500)`,
  });

  // 2. 키워드 빈도 (한국어 어절 단위 카운트로 밀도 계산)
  if (keyword) {
    const occurrences = (
      text.match(new RegExp(escapeRe(keyword), 'g')) || []
    ).length;
    const eojeols = text.split(/\s+/).filter(Boolean).length; // 어절 단위
    const density = eojeols > 0 ? (occurrences / eojeols) * 100 : 0;
    const ok = occurrences >= 5 && occurrences <= 12;
    results.push({
      name: '키워드 빈도',
      pass: ok,
      detail: `"${keyword}" ${occurrences}회 / ${eojeols}어절 (밀도 ${density.toFixed(2)}%, 권장 5~12회)`,
    });
  }

  // 3. 반복 어미
  const sentences = text.split(/[.!?。]\s*/).filter((s) => s.length > 5);
  let maxRun = 1;
  let runEnding = '';
  let cur = 1;
  let prev = '';
  for (const s of sentences) {
    const ending = classifyEnding(s);
    if (ending && ending === prev) {
      cur++;
      if (cur > maxRun) {
        maxRun = cur;
        runEnding = ending;
      }
    } else {
      cur = 1;
    }
    prev = ending;
  }
  results.push({
    name: '문장 어미 반복',
    pass: maxRun < 3,
    detail:
      maxRun >= 3
        ? `"${runEnding}" 어미 ${maxRun}회 연속 — 변주 필요`
        : '연속 3회 이상 동일 어미 없음',
  });

  // 3b. AI 티 문체 (4순위 — 쉼표 비율/번역투/이중피동, 전부 WARN)
  results.push(...checkAiStyle(text, sentences));

  // 4. 이미지 마커
  const imgMarkers = (raw.match(/\[IMAGE:/g) || []).length;
  results.push({
    name: '이미지 마커',
    pass: imgMarkers >= 4,
    detail: `[IMAGE:] ${imgMarkers}개 (권장 ≥ 4)`,
  });

  // 5. 외부 링크
  const links = raw.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  results.push({
    name: '외부 링크',
    pass: links.length === 0,
    detail:
      links.length === 0
        ? '외부 링크 없음'
        : `${links.length}개 발견 (저품질 트리거): ${links.slice(0, 3).join(', ')}`,
  });

  // 6. 금칙어 (하드 게이트 — 발견 시 exit 2)
  const exceptionSpans = findExceptionSpans(text, banned.exceptionPhrases);
  const bannedHits = findBannedHits(text, [...banned.superlatives, ...banned.domainSpecific], exceptionSpans);
  const exaggeratedHits = findExaggeratedMatches(text, banned.exaggeratedPatterns);
  const allBannedHits = [...bannedHits, ...exaggeratedHits];
  results.push({
    name: '최상급/금칙어',
    pass: allBannedHits.length === 0,
    hard: true,
    detail: allBannedHits.length === 0 ? '없음' : `발견: ${allBannedHits.join(', ')}`,
  });

  // 6b. AI 클리셰 표현 (WARN만 — 엄격 판정은 4순위에서)
  const aiClicheHits = findBannedHits(text, banned.aiCliches, exceptionSpans);
  results.push({
    name: 'AI 클리셰 표현',
    pass: aiClicheHits.length === 0,
    detail: aiClicheHits.length === 0 ? '없음' : `발견(최소화 권장): ${aiClicheHits.join(', ')}`,
  });

  // 7. 접속사 비율
  const conjCount = banned.conjunctions.reduce(
    (n, c) => n + (text.match(new RegExp(escapeRe(c), 'g')) || []).length,
    0
  );
  const conjRatio = sentences.length
    ? (conjCount / sentences.length) * 100
    : 0;
  results.push({
    name: '접속사 비율',
    pass: conjRatio <= banned.conjunctionMaxRatio,
    detail: `${conjCount}회 / ${sentences.length}문장 = ${conjRatio.toFixed(1)}% (목표 ≤ ${banned.conjunctionMaxRatio}%)`,
  });

  // 8. 구조 검사 (H2/H3 소제목 여부)
  const h2Count = (raw.match(/^##\s+/gm) || []).length;
  const h3Count = (raw.match(/^###\s+/gm) || []).length;
  const hasTable = raw.includes('|');
  results.push({
    name: '소제목 구조',
    pass: h2Count >= 2,
    detail: `H2 ${h2Count}개, H3 ${h3Count}개, 표 ${hasTable ? '있음' : '없음'} (H2 ≥ 2 권장)`,
  });

  // 9. 문장 길이 다양성 (평균 + 표준편차)
  const sentLengths = sentences.map((s) => s.replace(/\s/g, '').length).filter((l) => l > 0);
  if (sentLengths.length > 3) {
    const avg = sentLengths.reduce((a, b) => a + b, 0) / sentLengths.length;
    const variance = sentLengths.reduce((a, b) => a + (b - avg) ** 2, 0) / sentLengths.length;
    const stddev = Math.sqrt(variance);
    const tooLong = sentLengths.filter((l) => l > 80).length;
    results.push({
      name: '문장 길이',
      pass: stddev >= 8 && tooLong === 0,
      detail: `평균 ${avg.toFixed(0)}자, 표준편차 ${stddev.toFixed(1)} (다양성 권장 ≥ 8), 80자 초과 ${tooLong}문장`,
    });
  }

  // 10. 가편신 구조 체크 (고객의눈 — 도입부 5초 법칙)
  const openingText = text.slice(0, 400);
  const hasAuthority = /년간|년 경력|전문|인증|특허|수상|저희는|저는.*년|고객.*명|\d+건|의사|변호사|대표|원장|강사|컨설턴트/.test(openingText);
  const hasEmpathy = /해보셨|고민이시|겪어보신|않으신가요|있으신가요|힘드셨|불편하셨|오셨다면|잘 오셨|찾아오셨/.test(openingText);
  const hasEvidence = /\d+[명건%년개월억만]+|실제 고객|고객님들|후기|문의|연락|사례/.test(openingText);
  const gaepyeonsinScore = [hasAuthority, hasEmpathy, hasEvidence].filter(Boolean).length;
  results.push({
    name: '가편신 구조',
    pass: gaepyeonsinScore >= 2,
    detail: `도입부 권위(가)${hasAuthority ? '✓' : '✗'} 공감(편)${hasEmpathy ? '✓' : '✗'} 신뢰(신)${hasEvidence ? '✓' : '✗'} — ${gaepyeonsinScore}/3 (권장 ≥ 2)`,
  });

  // 11. YES 세트 체크 — 딱 3문장 (첫문장편: 3번이면 무적, 더 많으면 반감)
  const questionCount = (text.match(/[?？]|않으신가요|있으신가요|해보셨나요|아닌가요|오셨다면|계신가요/g) || []).length;
  results.push({
    name: 'YES 세트',
    pass: questionCount >= 2 && questionCount <= 6,
    detail: questionCount > 6
      ? `공감 질문 ${questionCount}개 — 3개가 최적, 너무 많으면 반감 유발`
      : `공감·질문 문장 ${questionCount}개 (권장 2~3 — 독자가 고개 끄덕이게)`,
  });

  // 12. 첫 3문장 유형 감지 (첫문장편 — 5초 법칙)
  const first3sentences = sentences.slice(0, 3).join(' ');
  const hasAuthorityOpening = /년간|년 경력|년 동안|의사|변호사|대표|원장|강사|타이틀|국내 \d+호|수상|소속/.test(first3sentences);
  const hasEmpathyOpening = /오셨다면|잘 오셨|찾아오셨|이 글을 읽고 계신|이 중|해당하신다면|겪고 계신/.test(first3sentences);
  const hasThreatOpening = /아시나요|모르셨나요|손해|위험|잃|벌금|사기|주의|몰랐던|사실은/.test(first3sentences);
  const openingType = hasAuthorityOpening ? '권위형' : hasEmpathyOpening ? '공감형' : hasThreatOpening ? '위협형' : null;
  results.push({
    name: '첫 3문장 유형',
    pass: openingType !== null,
    detail: openingType
      ? `${openingType} 첫문장 감지 ✓ (권위/공감/위협 중 택1 원칙)`
      : '첫 3문장에서 권위·공감·위협 유형 미감지 — 독자가 5초 안에 이탈할 수 있음',
  });

  return { charCount, sentences: sentences.length, results };
}

// 제목(H1) SEO 체크 — 키워드 왼쪽 배치 + 3대 메시지 유형 감지
function checkTitle(raw, keyword) {
  const results = [];

  // H1 추출 (# 제목 or <h1>제목</h1>)
  const h1Match = raw.match(/^#\s+(.+)$/m) || raw.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = h1Match ? h1Match[1].trim() : null;

  if (!title) {
    results.push({ name: '제목(H1)', pass: false, hard: true, detail: 'H1 제목을 찾을 수 없음 — # 제목 형식으로 작성 필요' });
    return results;
  }

  results.push({ name: '제목(H1)', pass: true, detail: `"${title}"` });

  // 키워드 왼쪽 배치 검사 (네이버 SEO 원칙)
  if (keyword) {
    const kwIdx = title.indexOf(keyword);
    const leftHalf = Math.floor(title.length / 2);
    const isLeft = kwIdx !== -1 && kwIdx <= leftHalf;
    const isPresent = kwIdx !== -1;
    results.push({
      name: '제목 키워드 위치',
      pass: isLeft,
      detail: isPresent
        ? `"${keyword}" 제목 내 위치: ${kwIdx}번째 글자 (총 ${title.length}자, ${isLeft ? '왼쪽 ✓' : '오른쪽 — 왼쪽 배치 권장'})`
        : `"${keyword}" 제목에 없음 — 키워드 포함 필요`,
    });
  }

  // 3대 메시지 유형 감지 (제목편 템플릿 기반)
  const posMsg = /\d+가지|\d+개|\d+분 안에|방법|가이드|체크리스트|만에/.test(title);
  const threatMsg = /모르면|공통점|의심|말하지 않는|가져간|했다면|위험/.test(title);
  const curiMsg = /다를까|왜|어째서|도대체|하면 안|만 보세요|진실|비밀/.test(title);
  const detected = [posMsg && '긍정', threatMsg && '위협', curiMsg && '호기심'].filter(Boolean);
  results.push({
    name: '제목 메시지 유형',
    pass: detected.length >= 1,
    detail: detected.length >= 1
      ? `감지된 유형: ${detected.join('/')} 메시지`
      : '3대 메시지(긍정/위협/호기심) 패턴 미감지 — 제목 재검토 권장',
  });

  // 낚시성/과장 표현 감지
  const clickbait = /충격|경악|경이|놀라운|믿기지|반전|폭로|다 틀렸|망합니다|죽습니다/.test(title);
  results.push({
    name: '제목 낚시성',
    pass: !clickbait,
    detail: clickbait ? '과장·낚시성 표현 감지 — 네이버 제재 위험' : '과장 표현 없음 ✓',
  });

  return results;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 이미지 프롬프트 붕괴 방지 — image_subject/image_points가 비었거나
// 키워드를 그대로 반복하면 generate-images.js에서 내용이 키워드 한 단어로
// 붕괴해 매번 비슷한 이미지가 나온다. hard: true — main()에서 exit 2 처리.
async function checkImageMeta(filePath, keyword) {
  const results = [];
  let meta;
  try {
    const metaRaw = await readFile(join(dirname(filePath), 'metadata.json'), 'utf8');
    meta = JSON.parse(metaRaw);
  } catch {
    results.push({
      name: '이미지 메타(subject/points)',
      pass: false,
      hard: true,
      detail: 'metadata.json을 찾을 수 없거나 파싱 실패 — image_subject/image_points 확인 불가',
    });
    return results;
  }

  const subject = (meta.image_subject || '').trim();
  const points = Array.isArray(meta.image_points)
    ? meta.image_points.filter((p) => typeof p === 'string' && p.trim())
    : [];

  const subjectIsKeyword = keyword && subject && subject === keyword.trim();
  const subjectOk = subject.length > 0 && !subjectIsKeyword;
  results.push({
    name: '이미지 subject',
    pass: subjectOk,
    hard: true,
    detail: !subject
      ? 'image_subject 비어 있음 — generate-images.js가 즉시 실패함'
      : subjectIsKeyword
        ? `image_subject가 키워드("${keyword}")를 그대로 반복 — 구체적인 장면으로 재작성 필요`
        : `"${subject}"`,
  });

  const pointsOk = points.length >= 2;
  results.push({
    name: '이미지 points',
    pass: pointsOk,
    hard: true,
    detail: pointsOk
      ? `${points.length}개 (${points.join(' / ')})`
      : `${points.length}개 — 최소 2개 필요 (배열 형태, 예: ["포인트1", "포인트2"])`,
  });

  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('Usage: --file <path> [--keyword <kw>]');
    process.exit(2);
  }

  const banned = await loadBannedWords();
  const facts = await loadFacts();
  const raw = await readFile(args.file, 'utf8');
  const isHtml = /<[a-z][\s\S]*>/i.test(raw);
  const text = isHtml ? stripHtml(raw) : raw;

  const report = check(text, raw, args.keyword, banned);
  const titleResults = checkTitle(raw, args.keyword);
  const imageMetaResults = await checkImageMeta(args.file, args.keyword);
  const factResults = checkFactClaims(text, facts);
  const leakResults = checkConfidentialLeak(text, facts);
  const allResults = [
    ...report.results,
    ...titleResults,
    ...imageMetaResults,
    ...factResults,
    ...leakResults,
  ];

  console.log(`\n📋 블로그 품질 리포트`);
  console.log(`파일: ${args.file}`);
  console.log(`형식: ${isHtml ? 'HTML' : 'Markdown/Text'}`);
  console.log(`총 ${report.sentences}문장, 공백제외 ${report.charCount}자\n`);

  let warnings = 0;
  for (const r of allResults) {
    const mark = r.pass ? '✅ PASS' : r.hard ? '⛔ FAIL' : '⚠️  WARN';
    console.log(`${mark}  ${r.name.padEnd(16)} — ${r.detail}`);
    if (!r.pass) warnings++;
  }

  const hardFails = allResults.filter((r) => r.hard && !r.pass);
  console.log(
    `\n결과: ${warnings === 0 ? '모든 검사 통과' : `${warnings}개 경고 (그중 하드 실패 ${hardFails.length}개)`}\n`
  );

  const reportPath = join(dirname(args.file), 'quality-report.json');
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        file: args.file,
        keyword: args.keyword || null,
        ...report,
        title_checks: titleResults,
        image_meta_checks: imageMetaResults,
        fact_checks: factResults,
        hard_fail: hardFails.length > 0,
        hard_fail_items: hardFails.map((r) => r.name),
      },
      null,
      2
    )
  );
  console.log(`리포트 저장: ${reportPath}`);

  if (hardFails.length > 0) {
    console.error(`\n⛔ 하드 실패 항목(${hardFails.map((r) => r.name).join(', ')}) — 수정 후 재검사 필요.`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
