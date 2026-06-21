#!/usr/bin/env node
/**
 * 블로그 품질 검증기 — 네이버 저품질 트리거 사전 검사.
 * Usage: node scripts/quality-check.js --file post.html [--keyword "병원 마케팅"]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

const BANNED = [
  '최고', '최저', '최상', '최강', '최대', '최소', '최초', '최신',
  '무조건', '100%', '절대', '완벽', '완전', '압도적', '독보적',
  '혁신적', '획기적', '놀라운', '경이로운', '전무후무', '유일무이',
  '세계 최고', '국내 최초', '업계 1위', '검증된', '보장합니다',
  '효과 보장', '무조건 성공', '절대 후회',
];
const CONJUNCTIONS = [
  '또한', '그리고', '더불어', '아울러',
  '그러나', '하지만', '반면에', '그럼에도',
  '따라서', '그러므로', '결론적으로', '요약하면',
  '게다가', '뿐만 아니라', '나아가', '더욱이',
];

function check(text, raw, keyword) {
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
    const ending = s.trim().slice(-3);
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

  // 6. 금칙어
  const hits = BANNED.filter((w) => text.includes(w));
  results.push({
    name: '최상급/금칙어',
    pass: hits.length === 0,
    detail: hits.length === 0 ? '없음' : `발견: ${hits.join(', ')}`,
  });

  // 7. 접속사 비율
  const conjCount = CONJUNCTIONS.reduce(
    (n, c) => n + (text.match(new RegExp(c, 'g')) || []).length,
    0
  );
  const conjRatio = sentences.length
    ? (conjCount / sentences.length) * 100
    : 0;
  results.push({
    name: '접속사 비율',
    pass: conjRatio <= 5,
    detail: `${conjCount}회 / ${sentences.length}문장 = ${conjRatio.toFixed(1)}% (목표 ≤ 5%)`,
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
    results.push({ name: '제목(H1)', pass: false, detail: 'H1 제목을 찾을 수 없음 — # 제목 형식으로 작성 필요' });
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

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('Usage: --file <path> [--keyword <kw>]');
    process.exit(2);
  }

  const raw = await readFile(args.file, 'utf8');
  const isHtml = /<[a-z][\s\S]*>/i.test(raw);
  const text = isHtml ? stripHtml(raw) : raw;

  const report = check(text, raw, args.keyword);
  const titleResults = checkTitle(raw, args.keyword);

  console.log(`\n📋 블로그 품질 리포트`);
  console.log(`파일: ${args.file}`);
  console.log(`형식: ${isHtml ? 'HTML' : 'Markdown/Text'}`);
  console.log(`총 ${report.sentences}문장, 공백제외 ${report.charCount}자\n`);

  let warnings = 0;
  for (const r of [...report.results, ...titleResults]) {
    const mark = r.pass ? '✅ PASS' : '⚠️  WARN';
    console.log(`${mark}  ${r.name.padEnd(16)} — ${r.detail}`);
    if (!r.pass) warnings++;
  }
  console.log(
    `\n결과: ${warnings === 0 ? '모든 검사 통과' : `${warnings}개 경고`}\n`
  );

  const reportPath = join(dirname(args.file), 'quality-report.json');
  await writeFile(
    reportPath,
    JSON.stringify(
      { file: args.file, keyword: args.keyword || null, ...report, title_checks: titleResults },
      null,
      2
    )
  );
  console.log(`리포트 저장: ${reportPath}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
