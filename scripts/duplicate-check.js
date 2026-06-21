#!/usr/bin/env node
/**
 * 내 블로그 글끼리의 유사도 검사 (네이버 유사문서 판정 회피).
 * 셰이글(n-gram) 기반 Jaccard 유사도 계산.
 *
 * Usage:
 *   node scripts/duplicate-check.js --file output/2026-04-08_X/post.md [--threshold 25]
 *
 * 비교 대상: output/ 하위의 다른 post.md 파일 전부
 * 임계값: 기본 25% (Jaccard). 초과 시 경고, 종료코드는 0 유지.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

// 텍스트를 단락(섹션)으로 분리
function splitSections(raw) {
  // H2 헤딩 기준으로 섹션 분리, 없으면 빈 줄 기준
  const byH2 = raw.split(/\n(?=##\s)/);
  if (byH2.length > 1) return byH2.map((s) => ({ label: s.slice(0, 30).trim(), text: stripHtmlAndMd(s) }));
  return raw.split(/\n\n+/).filter((s) => s.trim().length > 80).map((s) => ({ label: s.slice(0, 30).trim(), text: stripHtmlAndMd(s) }));
}

function shingles(text, n = 6) {
  // 한국어: 공백 제거 후 n-글자 단위 셰이글
  const s = text.replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i <= s.length - n; i++) {
    set.add(s.slice(i, i + n));
  }
  return set;
}

// n=4 셰이글 (짧은 구문 중복 감지용)
function shingles4(text) {
  return shingles(text, 4);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return (inter / union) * 100;
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
  const targetShingles4 = shingles4(targetText);
  const targetIntro = extractIntro(raw);
  const targetSections = splitSections(raw);

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
    const otherShingles4 = shingles4(otherText);

    // 전체 유사도 (6-gram)
    const sim6 = jaccard(targetShingles6, otherShingles6);
    // 도입부 유사도 (4-gram, 더 민감하게)
    const introSim = jaccard(shingles4(targetIntro), shingles4(extractIntro(otherRaw)));
    // 섹션 레벨 분석
    const { maxSim: sectionMaxSim, label: sectionLabel } = findMostSimilarSection(
      targetSections,
      splitSections(otherRaw)
    );

    results.push({ file: other, sim6, introSim, sectionMaxSim, sectionLabel });
  }
  results.sort((a, b) => b.sim6 - a.sim6);

  let warnings = 0;
  for (const r of results) {
    const overallWarn = r.sim6 >= threshold;
    const introWarn = r.introSim >= 40; // 도입부는 더 엄격 (40%)
    const sectionWarn = r.sectionMaxSim >= threshold + 10; // 섹션 단위는 더 엄격
    const warn = overallWarn || introWarn || sectionWarn;
    const mark = warn ? '⚠️  WARN' : '✅ OK  ';
    const introFlag = introWarn ? ` [도입부 ${r.introSim.toFixed(0)}%↑]` : '';
    const sectionFlag = sectionWarn ? ` [섹션: ${r.sectionLabel} ${r.sectionMaxSim.toFixed(0)}%]` : '';
    console.log(
      `  ${mark}  전체 ${r.sim6.toFixed(1).padStart(5)}%${introFlag}${sectionFlag}  ${r.file}`
    );
    if (warn) warnings++;
  }

  console.log(
    `\n결과: ${warnings === 0 ? '중복 위험 없음' : `${warnings}건 경고 — 유사 구간 수정 권장`}\n`
  );
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
