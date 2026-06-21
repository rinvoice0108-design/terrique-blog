#!/usr/bin/env node
/**
 * 네이버 Search API 리서치 래퍼.
 * Usage:
 *   node scripts/research.js --keyword "상세페이지 AI" [--output output/folder]
 *
 * 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 * 미설정 시 명확한 에러 + 종료. (웹 검색 대체는 Claude가 수동 수행)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

async function naverSearch(kind, query, display = 30, sort = 'sim') {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET not set. Set them in .env.'
    );
  }
  const url = `https://openapi.naver.com/v1/search/${kind}?query=${encodeURIComponent(
    query
  )}&display=${display}&sort=${sort}`;
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': id,
      'X-Naver-Client-Secret': secret,
    },
  });
  const json = await res.json();
  if (!res.ok || json.errorCode) {
    throw new Error(
      `Naver API error (${kind}): ${json.errorMessage || res.status}`
    );
  }
  return json;
}

const stripTags = (s) => (s || '').replace(/<[^>]+>/g, '');

// 한국어 불용어 (조사·어미·일반 동사 등)
const KO_STOP = new Set([
  '그리고', '있는', '위한', '통해', '대한', '되는', '하는', '입니다', '합니다',
  '있어', '하여', '으로', '에서', '에게', '부터', '까지', '이며', '이고',
  '한다', '된다', '한다면', '위해', '하기', '하면', '하지', '않은', '없는',
  '이런', '저런', '그런', '어떤', '모든', '여러', '각종', '다양한',
  '좋은', '나쁜', '새로운', '이번', '지금', '바로',
]);

// 의도 기반 롱테일 접미 패턴
const INTENT_SUFFIXES = ['방법', '후기', '추천', '비용', '가격', '종류', '효과', '기간', '주의사항', '비교'];

// 구매 여정 4단계 분류 (고객의눈 이론) — 전환율: 1단계(낮음)→4단계(높음)
const JOURNEY_STAGES = {
  stage4: {
    label: '4단계 (구매 직전)',
    note: '전환율 최고 — 글 작성 1순위 타겟',
    pattern: /구매|구입|어디서|어디가|업체|업소|지역|가격|비용|요금|견적|할인|살.*곳|사는.*곳/,
  },
  stage3: {
    label: '3단계 (의심 해소)',
    note: '전환율 높음 — 부작용·실패·솔직 후기 검색',
    pattern: /후기|리뷰|실제|솔직|부작용|실패|주의|비교|차이|단점|문제|괜찮|믿을|사기|검증/,
  },
  stage2: {
    label: '2단계 (문제 해결)',
    note: '전환율 중간 — 해결책을 찾는 단계',
    pattern: /해결|방지|예방|개선|고치|없애|줄이|늘리|키우|극복|탈출|벗어나/,
  },
  stage1: {
    label: '1단계 (정보 탐색)',
    note: '전환율 낮음 — 단순 정보 검색',
    pattern: /이란|란\s*\?|뜻|정의|원리|역사|개념/,
  },
};

function classifyJourneyStage(keyword) {
  for (const [key, stage] of Object.entries(JOURNEY_STAGES)) {
    if (stage.pattern.test(keyword)) return { stage: key, label: stage.label, note: stage.note };
  }
  return { stage: 'stage2', label: '2단계 (추정)', note: '명확한 단계 신호 없음 — 맥락으로 판단 필요' };
}

function classifyLongtailStages(keywords) {
  return keywords.map((kw) => ({ keyword: kw, ...classifyJourneyStage(kw) }));
}

function competitionLevel(blogTotal, cafeTotal = 0) {
  const combined = blogTotal + cafeTotal * 0.3; // 카페는 30% 가중치
  if (combined >= 120000) return '높음 (포화)';
  if (combined >= 35000) return '보통 (경쟁)';
  return '낮음 (기회)';
}

// 기회도 점수 0~100: 낮은 경쟁 + 높은 최신 활동 = 높은 점수
function opportunityScore(blogTotal, cafeTotal, recentRatioPct) {
  const compScore = Math.max(0, 100 - (blogTotal / 1500)); // 경쟁 낮을수록 높음
  const actScore = Math.min(100, recentRatioPct * 2.5);    // 최신 활동 높을수록 높음
  const score = Math.round(compScore * 0.6 + actScore * 0.4);
  const label = score >= 70 ? '★★★ 강추' : score >= 45 ? '★★ 권장' : '★ 주의';
  return { score: Math.min(100, score), label };
}

function extractRelatedWords(items, mainKeyword) {
  const counts = new Map();
  for (let i = 0; i < items.length; i++) {
    const t = stripTags(items[i].title);
    const words = t.split(/\s+/).filter((w) => w.length >= 2 && !KO_STOP.has(w));
    const positionWeight = i < 5 ? 2 : 1; // 상위 글 가중치 2배
    for (const w of words) {
      if (w === mainKeyword || w.includes(mainKeyword)) continue;
      counts.set(w, (counts.get(w) || 0) + positionWeight);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([w, c]) => ({ word: w, count: c }));
}

// 경쟁 글 제목에서 과포화된 패턴 감지 → 차별화 각도 제안
function gapAnalysis(items) {
  const titleTexts = items.map((it) => stripTags(it.title));
  const overused = [];
  const patterns = [
    { pattern: /방법|하는 법|하는 방법/, label: '"방법/하는 법" 패턴' },
    { pattern: /이유|왜|때문/, label: '"이유/왜" 패턴' },
    { pattern: /추천|베스트|순위|TOP/, label: '"추천/순위" 패턴' },
    { pattern: /주의|하면 안/, label: '"주의사항" 패턴' },
    { pattern: /언제|시기|타이밍/, label: '"타이밍" 패턴' },
  ];
  for (const { pattern, label } of patterns) {
    const hit = titleTexts.filter((t) => pattern.test(t)).length;
    if (hit >= 3) overused.push({ label, count: hit });
  }
  const unused = patterns
    .filter(({ pattern }) => !titleTexts.some((t) => pattern.test(t)))
    .map(({ label }) => label);
  return { overused, differentiation_angles: unused };
}

function recentRatio(items, days = 30) {
  const now = Date.now();
  const cutoff = now - days * 24 * 3600 * 1000;
  const halfCutoff = now - (days / 2) * 24 * 3600 * 1000;
  let recentHalf = 0;
  let olderHalf = 0;
  for (const it of items) {
    if (!it.postdate) continue;
    const y = it.postdate.slice(0, 4);
    const m = it.postdate.slice(4, 6);
    const d = it.postdate.slice(6, 8);
    const ts = new Date(`${y}-${m}-${d}`).getTime();
    if (ts >= halfCutoff) recentHalf++;
    else if (ts >= cutoff) olderHalf++;
  }
  const total = recentHalf + olderHalf;
  const ratio = items.length ? ((recentHalf + olderHalf) / items.length) * 100 : 0;
  // 트렌드 방향: 최근 15일 vs 이전 15일
  let velocity = '안정';
  if (total > 0) {
    if (recentHalf > olderHalf * 1.5) velocity = '가속 (관심 급증)';
    else if (recentHalf < olderHalf * 0.5) velocity = '감속 (관심 식는 중)';
  }
  return { ratio: Number(ratio.toFixed(1)), velocity };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.keyword) {
    console.error('Usage: --keyword "키워드" [--output dir]');
    process.exit(2);
  }

  const keyword = args.keyword;
  console.log(`\n🔎 네이버 리서치: "${keyword}"`);

  let blogRecent, blogCount, cafe;
  try {
    blogRecent = await naverSearch('blog', keyword, 30, 'date');
    blogCount = await naverSearch('blog', keyword, 1, 'sim');
    cafe = await naverSearch('cafearticle', keyword, 20, 'sim');
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    console.error(
      '→ 웹 검색 기반 수동 리서치로 대체하거나, .env의 키를 갱신하세요.'
    );
    process.exit(1);
  }

  const totalBlog = blogCount.total || 0;
  const totalCafe = cafe.total || 0;
  const related = extractRelatedWords(blogRecent.items || [], keyword);
  const { ratio: recentRatioPct, velocity } = recentRatio(blogRecent.items || []);
  const opportunity = opportunityScore(totalBlog, totalCafe, recentRatioPct);
  const gap = gapAnalysis(blogRecent.items || []);

  // 롱테일: 관련 키워드 × 의도 접미어 조합 (중복 제거, 최대 12개)
  const longtailSet = new Set();
  for (const r of related.slice(0, 5)) {
    longtailSet.add(`${keyword} ${r.word}`);
  }
  for (const suffix of INTENT_SUFFIXES) {
    longtailSet.add(`${keyword} ${suffix}`);
    if (longtailSet.size >= 12) break;
  }
  const longtail_suggestions = [...longtailSet].slice(0, 12);

  // 메인 키워드 구매 여정 단계 분류
  const mainKeywordStage = classifyJourneyStage(keyword);
  // 롱테일 구매 여정 단계 분류 + 고전환 키워드 우선 정렬
  const longtailWithStages = classifyLongtailStages(longtail_suggestions)
    .sort((a, b) => {
      const order = { stage4: 0, stage3: 1, stage2: 2, stage1: 3 };
      return (order[a.stage] ?? 2) - (order[b.stage] ?? 2);
    });

  const report = {
    keyword,
    fetched_at: new Date().toISOString(),
    keyword_journey_stage: mainKeywordStage,
    blog: {
      total: totalBlog,
      competition: competitionLevel(totalBlog, totalCafe),
      recent_30d_ratio_percent: recentRatioPct,
      trend_velocity: velocity,
      recent_titles: (blogRecent.items || [])
        .slice(0, 15)
        .map((it) => ({
          title: stripTags(it.title),
          postdate: it.postdate,
          bloggername: it.bloggername,
        })),
    },
    cafe: {
      total: totalCafe,
      sample_titles: (cafe.items || [])
        .slice(0, 10)
        .map((it) => stripTags(it.title)),
    },
    opportunity,
    related_keywords: related,
    longtail_suggestions,
    longtail_journey_stages: longtailWithStages,
    gap_analysis: gap,
  };

  // 콘솔 출력
  console.log(`\n📊 경쟁도`);
  console.log(`  블로그 전체: ${totalBlog.toLocaleString()}건 → ${report.blog.competition}`);
  console.log(`  카페 전체:   ${totalCafe.toLocaleString()}건`);
  console.log(`  최근 30일 비율: ${recentRatioPct}%  트렌드: ${velocity}`);
  console.log(`\n🎯 기회도 점수: ${opportunity.score}/100  ${opportunity.label}`);

  console.log(`\n🛒 키워드 구매 여정 단계 (고객의눈 4단계 이론)`);
  console.log(`  메인 키워드: ${mainKeywordStage.label}`);
  console.log(`  → ${mainKeywordStage.note}`);
  const highConvertStages = longtailWithStages.filter((l) => l.stage === 'stage3' || l.stage === 'stage4');
  if (highConvertStages.length > 0) {
    console.log(`  ★ 고전환 롱테일 후보: ${highConvertStages.map((l) => l.keyword).join(', ')}`);
  }

  console.log(`\n🏷  연관 키워드 TOP`);
  related.slice(0, 10).forEach((r) => console.log(`  - ${r.word} (${r.count})`));

  console.log(`\n💡 롱테일 제안 (구매 여정 단계순 정렬)`);
  longtailWithStages.forEach((l) => console.log(`  - ${l.keyword}  [${l.label}]`));

  if (gap.overused.length) {
    console.log(`\n⚠️  경쟁 글에 과포화된 패턴`);
    gap.overused.forEach((g) => console.log(`  - ${g.label} (${g.count}건)`));
  }
  if (gap.differentiation_angles.length) {
    console.log(`\n✨ 차별화 각도 (경쟁글이 비어있는 곳)`);
    gap.differentiation_angles.forEach((a) => console.log(`  - ${a}`));
  }

  console.log(`\n📰 상위 최근 글 제목`);
  report.blog.recent_titles
    .slice(0, 10)
    .forEach((t) => console.log(`  - ${t.title} (${t.postdate})`));

  // 파일 저장
  if (args.output) {
    await mkdir(args.output, { recursive: true });
    const path = join(args.output, 'research.json');
    await writeFile(path, JSON.stringify(report, null, 2));
    console.log(`\n리포트 저장: ${path}`);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
