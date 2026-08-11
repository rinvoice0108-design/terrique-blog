#!/usr/bin/env node
/**
 * 네이버 Search API 리서치 래퍼.
 * Usage:
 *   node scripts/research.js --keyword "상세페이지 AI" [--output output/folder]
 *
 * 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 * 미설정 시 명확한 에러 + 종료. (웹 검색 대체는 Claude가 수동 수행)
 *
 * ⚠️ 2026-07-31부로 개발자센터(openapi.naver.com) 검색 API 신규 발급이 막히고
 *    NAVER API HUB(NCP)로 이관됐다 — 검색(블로그/카페/지식인)은
 *    naverapihub.apigw.ntruss.com, 데이터랩(검색어트렌드/쇼핑인사이트)은
 *    naveropenapi.apigw.ntruss.com — 도메인이 다르다(terrique-scout도 동일 정리,
 *    src/lib/blog/openapi.ts 참고). 둘 다 헤더는 X-NCP-APIGW-API-KEY-ID / -KEY.
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

// 검색·검색어트렌드·쇼핑인사이트 전부 같은 NAVER API HUB 게이트웨이를 쓴다(경로만 다름).
const SEARCH_BASE = 'https://naverapihub.apigw.ntruss.com';

function naverAuth() {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET not set. Set them in .env.'
    );
  }
  return { 'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': secret };
}

async function naverSearch(kind, query, display = 30, sort = 'sim') {
  const url = `${SEARCH_BASE}/search/v1/${kind}?query=${encodeURIComponent(
    query
  )}&display=${display}&sort=${sort}&format=json`;
  const res = await fetch(url, { headers: naverAuth() });
  const json = await res.json();
  if (!res.ok || json.errorCode || json.error) {
    throw new Error(
      `Naver API error (${kind}): ${json.errorMessage || json.error?.message || res.status}`
    );
  }
  return json;
}

// 데이터랩 검색어트렌드 — 실제 검색량 상대지수(최근 90일, 주간).
// "최근 30일 포스팅 비율"은 어디까지나 블로그 발행량 추정치였는데, 이건 진짜 검색 수요다.
// ⚠️ 경로가 검색 API와 다르다 — /datalab/v1/... 이 아니라 /search-trend/v1/search 다.
//    (api.ncloud-docs.com/docs/naver-api-hub-search-trend, 2026-08-11 확인)
async function trendSearch(query) {
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const res = await fetch(`${SEARCH_BASE}/search-trend/v1/search`, {
    method: 'POST',
    headers: { ...naverAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDate: fmt(start),
      endDate: fmt(end),
      timeUnit: 'week',
      keywordGroups: [{ groupName: query, keywords: [query] }],
    }),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`Naver Search Trend error: ${json.error?.message || res.status}`);
  }
  const points = json.results?.[0]?.data || [];
  if (points.length < 2) return { points, momentum_percent: 0, direction: '데이터 부족' };
  const half = Math.floor(points.length / 2);
  const avg = (arr) => arr.reduce((s, p) => s + p.ratio, 0) / (arr.length || 1);
  const recentAvg = avg(points.slice(half));
  const priorAvg = avg(points.slice(0, half));
  const momentum = priorAvg === 0 ? 0 : ((recentAvg - priorAvg) / priorAvg) * 100;
  const direction = momentum > 15 ? '상승' : momentum < -15 ? '하락' : '보합';
  return { points, momentum_percent: Number(momentum.toFixed(1)), direction };
}

// 데이터랩 쇼핑인사이트 — 카테고리 코드가 있어야 조회된다(키워드만으로 카테고리를
// 자동 판별하는 공식 API가 없음 — 네이버쇼핑에서 카테고리 선택 시 URL의 cat_id로 확인).
// NAVER_SHOPPING_CATEGORY_ID를 .env에 설정해야 켜짐 — 잘못된 카테고리로 억지로 채우면
// 근거 없는 숫자가 되므로, 미설정 시 조용히 건너뛴다.
// 경로: /shopping/v1/category/keywords, keyword는 {name, param} 객체 배열(최대 5개).
async function shoppingInsight(query) {
  const categoryId = process.env.NAVER_SHOPPING_CATEGORY_ID;
  if (!categoryId) return null;
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const res = await fetch(`${SEARCH_BASE}/shopping/v1/category/keywords`, {
    method: 'POST',
    headers: { ...naverAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDate: fmt(start),
      endDate: fmt(end),
      timeUnit: 'week',
      category: categoryId,
      keyword: [{ name: query, param: [query] }],
    }),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`Naver Shopping Insight error: ${json.error?.message || res.status}`);
  }
  return json.results?.[0]?.data || [];
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
// 최신 활동은 두 신호를 반반 섞는다 — recentRatioPct(블로그 발행량 추정)과
// trendMomentumPct(데이터랩 실제 검색량 증감, 90일). 데이터랩이 없던 시절엔
// 추정치 하나뿐이었는데, 실측이 생겼으니 계속 무시할 이유가 없다.
function opportunityScore(blogTotal, cafeTotal, recentRatioPct, trendMomentumPct = 0) {
  const compScore = Math.max(0, 100 - (blogTotal / 1500)); // 경쟁 낮을수록 높음
  const estActScore = Math.min(100, recentRatioPct * 2.5);
  const trendActScore = Math.min(100, Math.max(0, 50 + trendMomentumPct)); // 0%=보합→50점 기준
  const actScore = estActScore * 0.5 + trendActScore * 0.5;
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

  let blogRecent, blogCount, cafe, kin;
  try {
    blogRecent = await naverSearch('blog', keyword, 30, 'date');
    blogCount = await naverSearch('blog', keyword, 1, 'sim');
    cafe = await naverSearch('cafearticle', keyword, 20, 'sim');
    kin = await naverSearch('kin', keyword, 20, 'sim');
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    console.error(
      '→ 웹 검색 기반 수동 리서치로 대체하거나, .env의 키를 갱신하세요.'
    );
    process.exit(1);
  }

  // 데이터랩(검색어트렌드/쇼핑인사이트)은 NCP 콘솔에 나열돼 있어도 "이용 신청" 승인이
  // 별도로 필요할 수 있어(2026-08-11 확인) 실패해도 본 리서치를 죽이지 않는다.
  let trend = { points: [], momentum_percent: 0, direction: '조회 실패' };
  try {
    trend = await trendSearch(keyword);
  } catch (e) {
    console.error(`⚠️  검색어트렌드 조회 실패(계속 진행): ${e.message}`);
  }
  let shopping = null;
  try {
    shopping = await shoppingInsight(keyword);
  } catch (e) {
    console.error(`⚠️  쇼핑인사이트 조회 실패(계속 진행): ${e.message}`);
  }

  const totalBlog = blogCount.total || 0;
  const totalCafe = cafe.total || 0;
  const related = extractRelatedWords(blogRecent.items || [], keyword);
  const { ratio: recentRatioPct, velocity } = recentRatio(blogRecent.items || []);
  const opportunity = opportunityScore(totalBlog, totalCafe, recentRatioPct, trend.momentum_percent);
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
    kin: {
      total: kin.total || 0,
      sample_titles: (kin.items || [])
        .slice(0, 10)
        .map((it) => stripTags(it.title)),
    },
    trend: {
      momentum_percent: trend.momentum_percent,
      direction: trend.direction,
      weekly_points: trend.points,
    },
    shopping_insight: shopping, // NAVER_SHOPPING_CATEGORY_ID 미설정이면 null
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
  console.log(`  최근 30일 비율(추정): ${recentRatioPct}%  ${velocity}`);
  console.log(`  검색어트렌드(실측, 90일): ${trend.direction} (${trend.momentum_percent > 0 ? '+' : ''}${trend.momentum_percent}%)`);
  if (shopping) {
    console.log(`  쇼핑인사이트: 최근 데이터 ${shopping.length}주 확보 (report.shopping_insight 참고)`);
  }
  console.log(`  지식인 질문: ${(kin.total || 0).toLocaleString()}건`);
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
