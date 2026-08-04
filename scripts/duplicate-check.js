#!/usr/bin/env node
/**
 * 내 블로그 글끼리의 유사도 검사 (네이버 유사문서 판정 회피).
 * 셰이글(n-gram) 기반 Jaccard + containment 유사도, 제목 축, 12어절 연속 일치 검사.
 *
 * Usage:
 *   node scripts/duplicate-check.js --file output/2026-04-08_X/post.md [--threshold 25]
 *
 * 비교 대상: output/ 하위의 다른 post.md 파일 전부
 * 임계값: 기본 25%. 초과 시(또는 제목 유사/12어절 연속 일치 발견 시) 경고 + exit 2.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

const stripHtmlAndMd = (s) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*`>|_\-]/g, ' ')
    .replace(/\[IMAGE:[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// 텍스트에서 도입부(첫 단락) 추출
function extractIntro(text, chars = 300) {
  const clean = stripHtmlAndMd(text);
  return clean.slice(0, chars);
}

// H1 제목 추출 (quality-check.js와 동일 규칙)
function extractTitle(raw) {
  const m = raw.match(/^#\s+(.+)$/m) || raw.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  return m ? m[1].trim() : '';
}

// 텍스트를 단락(섹션)으로 분리
function splitSections(raw) {
  // H2 헤딩 기준으로 섹션 분리, 없으면 빈 줄 기준
  const byH2 = raw.split(/\n(?=##\s)/);
  if (byH2.length > 1) return byH2.map((s) => ({ label: s.slice(0, 30).trim(), text: stripHtmlAndMd(s) }));
  return raw.split(/\n\n+/).filter((s) => s.trim().length > 80).map((s) => ({ label: s.slice(0, 30).trim(), text: stripHtmlAndMd(s) }));
}

export function shingles(text, n = 6) {
  // 한국어: 공백 제거 후 n-글자 단위 셰이글
  const s = text.replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i <= s.length - n; i++) {
    set.add(s.slice(i, i + n));
  }
  return set;
}

// n=4 셰이글 (짧은 구문 중복 감지용 — 도입부·제목)
function shingles4(text) {
  return shingles(text, 4);
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return (inter / union) * 100;
}

// containment: 짧은 쪽 기준 포함비율. 글 길이가 크게 달라도(짧은 문단이 긴 글 속에
// 그대로 박혀있는 경우) jaccard처럼 희석되지 않고 잡아낸다.
export function containment(a, b) {
  const minSize = Math.min(a.size, b.size);
  if (!minSize) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (inter / minSize) * 100;
}

// 어절(공백) 단위 토큰화 + n어절 연속 일치(완전 동일 구간 표절) 탐지
function words(text) {
  return stripHtmlAndMd(text).split(/\s+/).filter(Boolean);
}

function findConsecutiveWordMatch(targetWords, otherWords, minRun = 12) {
  if (targetWords.length < minRun || otherWords.length < minRun) return null;
  const otherWindows = new Set();
  for (let i = 0; i <= otherWords.length - minRun; i++) {
    otherWindows.add(otherWords.slice(i, i + minRun).join(' '));
  }
  for (let i = 0; i <= targetWords.length - minRun; i++) {
    const window = targetWords.slice(i, i + minRun).join(' ');
    if (otherWindows.has(window)) return window;
  }
  return null;
}

// 가장 유사한 섹션 쌍 찾기
function findMostSimilarSection(targetSections, otherSections) {
  let maxSim = 0;
  let label = '';
  for (const ts of targetSections) {
    const tsShingles = shingles(ts.text);
    for (const os of otherSections) {
      const sim = jaccard(tsShingles, shingles(os.text));
      if (sim > maxSim) {
        maxSim = sim;
        label = `"${ts.label}…" vs "${os.label}…"`;
      }
    }
  }
  return { maxSim, label };
}

async function findPosts(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name === 'post.md') {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('Usage: --file <path> [--threshold 25]');
    process.exit(2);
  }
  const threshold = Number(args.threshold || 25);
  const target = resolve(args.file);

  const raw = await readFile(target, 'utf8');
  const targetText = stripHtmlAndMd(raw);
  const targetShingles6 = shingles(targetText);
  const targetIntro = extractIntro(raw);
  const targetSections = splitSections(raw);
  const targetTitle = extractTitle(raw);
  const targetTitleShingles = shingles4(targetTitle);
  const targetWords = words(raw);

  const allPosts = await findPosts('output');
  const others = allPosts.filter((p) => resolve(p) !== target);

  if (!others.length) {
    console.log('비교 대상 없음 (첫 글이거나 output/ 비어있음).');
    return;
  }

  console.log(`\n🔁 유사도 검사: ${args.file}`);
  console.log(`   비교 대상: ${others.length}건, 임계값: ${threshold}%\n`);

  const results = [];
  for (const other of others) {
    const otherRaw = await readFile(other, 'utf8');
    const otherText = stripHtmlAndMd(otherRaw);
    const otherShingles6 = shingles(otherText);
    const otherTitle = extractTitle(otherRaw);

    // 전체 유사도 — jaccard(대칭) + containment(길이 차이 큰 경우도 감지)
    const sim6 = jaccard(targetShingles6, otherShingles6);
    const cont6 = containment(targetShingles6, otherShingles6);
    // 도입부 유사도 (4-gram, 더 민감하게)
    const introSim = jaccard(shingles4(targetIntro), shingles4(extractIntro(otherRaw)));
    // 제목 축 — containment 사용 (제목 길이 차이가 있어도 부분 재사용을 잡기 위함)
    const titleSim = targetTitle && otherTitle ? containment(targetTitleShingles, shingles4(otherTitle)) : 0;
    // 섹션 레벨 분석
    const { maxSim: sectionMaxSim, label: sectionLabel } = findMostSimilarSection(
      targetSections,
      splitSections(otherRaw)
    );
    // 12어절 연속 완전 일치 (그대로 복붙된 구간 탐지)
    const wordMatch = findConsecutiveWordMatch(targetWords, words(otherRaw), 12);

    results.push({ file: other, sim6, cont6, introSim, titleSim, sectionMaxSim, sectionLabel, wordMatch });
  }
  results.sort((a, b) => Math.max(b.sim6, b.cont6) - Math.max(a.sim6, a.cont6));

  let warnings = 0;
  for (const r of results) {
    const overallWarn = r.sim6 >= threshold || r.cont6 >= threshold + 15;
    const introWarn = r.introSim >= 40; // 도입부는 더 엄격 (40%)
    const titleWarn = r.titleSim >= 60; // 제목은 완전동일/부분재사용도 잡도록 엄격
    const sectionWarn = r.sectionMaxSim >= threshold + 10; // 섹션 단위는 더 엄격
    const wordRunWarn = !!r.wordMatch;
    const warn = overallWarn || introWarn || titleWarn || sectionWarn || wordRunWarn;

    const mark = warn ? '⚠️  WARN' : '✅ OK  ';
    const contFlag = r.cont6 >= threshold + 15 ? ` [포함비율 ${r.cont6.toFixed(0)}%↑]` : '';
    const introFlag = introWarn ? ` [도입부 ${r.introSim.toFixed(0)}%↑]` : '';
    const titleFlag = titleWarn ? ` [제목 ${r.titleSim.toFixed(0)}%↑]` : '';
    const sectionFlag = sectionWarn ? ` [섹션: ${r.sectionLabel} ${r.sectionMaxSim.toFixed(0)}%]` : '';
    const wordFlag = wordRunWarn ? ` [12어절 연속일치: "${r.wordMatch.slice(0, 40)}..."]` : '';
    console.log(
      `  ${mark}  전체 ${r.sim6.toFixed(1).padStart(5)}%${contFlag}${introFlag}${titleFlag}${sectionFlag}${wordFlag}  ${r.file}`
    );
    if (warn) warnings++;
  }

  console.log(
    `\n결과: ${warnings === 0 ? '중복 위험 없음' : `${warnings}건 경고 — 유사 구간 수정 권장`}\n`
  );

  if (warnings > 0) process.exit(2);
}

// shingles/jaccard/containment는 sheets-tracker.js(주제 지문 검사)에서도 import해서
// 쓴다 — 이 파일이 모듈로 import될 때는 CLI main()이 돌면 안 되므로, 직접 실행된
// 경우에만(node scripts/duplicate-check.js ...) main()을 호출한다.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
