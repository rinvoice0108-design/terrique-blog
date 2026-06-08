#!/usr/bin/env node
/**
 * 블로그 이미지 생성기
 * Nano Banana Pro (Gemini Image) REST API 직접 호출.
 * 외부 의존성 없음 — Node 20+ 내장 fetch 사용.
 *
 * Usage:
 *   GEMINI_API_KEY=xxx node scripts/generate-images.js \
 *     --title "..." --keyword "..." \
 *     --points "p1|||p2|||p3" \
 *     --quote "..." \
 *     --steps "s1|||s2|||s3" \
 *     --subject "블로그 핵심 주제 한 줄 설명" \
 *     --output "output/folder/images"
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ────────────────────────────────────────────────
// CLI 파싱
// ────────────────────────────────────────────────
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

const splitList = (s) =>
  (s || '')
    .split('|||')
    .map((x) => x.trim())
    .filter(Boolean);

// ────────────────────────────────────────────────
// 브랜드 컬러 시스템 (환경 변수 기반)
// ────────────────────────────────────────────────
const BG_COLOR = process.env.BRAND_BG_COLOR || '#F7F6F2';
const FG_COLOR = process.env.BRAND_FG_COLOR || '#1A1A1A';
const ACCENT   = process.env.BRAND_ACCENT   || '#D97A3A';

const BRAND_STYLE = [
  'Minimal Korean editorial infographic design',
  `off-white background (${BG_COLOR}), deep charcoal (${FG_COLOR}) text, single point color (${ACCENT})`,
  'premium clean sans-serif typography (Pretendard-like)',
  'generous whitespace, clear visual hierarchy',
  'information-diagram first: prefer charts, tables, flow nodes, comparison layouts over decorative illustration',
  'NO logos, NO watermarks, NO brand names',
  'Korean text must render perfectly legible and sharp',
].join('. ');

// ────────────────────────────────────────────────
// 디자인 이미지 프롬프트 (브랜드 로고 없음)
// ────────────────────────────────────────────────
function thumbnailPrompt({ title, keyword }) {
  return [
    `Create a 16:9 Korean blog thumbnail — editorial infographic style, not an illustration.`,
    `Large bold Korean headline (must be perfectly legible): "${title}"`,
    `Small pill-shaped tag in top-left corner with text: "${keyword}"`,
    `Add one subtle visual element that hints at data/diagram (e.g., a small bar chart, numbered badge, or flow arrow) — not a photo.`,
    BRAND_STYLE,
    `Layout: headline left-aligned, diagram element right side, balanced negative space.`,
  ].join('\n');
}

function infographicPrompt({ keyword, points }) {
  const numbered = points
    .slice(0, 5)
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n');
  return [
    `Create a 2:3 vertical Korean infographic poster — pure information diagram, no decorative art.`,
    `Top title in Korean: "${keyword} 핵심 포인트"`,
    `Below the title, render these items as a vertical stack of numbered cards (rounded rectangles with a left accent bar), each with the number prominently displayed and the Korean text rendered clearly:`,
    numbered,
    BRAND_STYLE,
    `Consistent spacing between cards, clear numeric hierarchy, no icons of people.`,
  ].join('\n');
}

function quoteCardPrompt({ quote, keyword }) {
  return [
    `Create a 1:1 square Korean quote card — clean editorial typography focus.`,
    `Small label at top in warm-orange: "${keyword}"`,
    `Center the large Korean quote in bold sans-serif (not serif), perfectly legible: "${quote}"`,
    `Oversized decorative quotation marks as faint background element (very low opacity).`,
    BRAND_STYLE,
    `No people, no photographic elements.`,
  ].join('\n');
}

function processPrompt({ keyword, steps }) {
  const numberedSteps = steps
    .slice(0, 6)
    .map((s, i) => `${i + 1}) ${s}`)
    .join('   →   ');
  return [
    `Create a 4:3 Korean horizontal process flow diagram — clean schematic, not an illustration.`,
    `Top title in Korean: "${keyword} 진행 프로세스"`,
    `Render this as a horizontal row of numbered pill-shaped nodes connected by arrows, each node containing its Korean label clearly:`,
    numberedSteps,
    `Each node: rounded rectangle with number badge + Korean label. Arrows between nodes in warm-orange.`,
    BRAND_STYLE,
    `Pure schematic diagram, no background imagery, no people.`,
  ].join('\n');
}

// ────────────────────────────────────────────────
// 상황 이미지 프롬프트 (실사풍 라이프스타일 3종)
// ────────────────────────────────────────────────
function scenePrompt1({ keyword, subject }) {
  const ctx = subject || keyword;
  return [
    `Create a high-quality lifestyle photography image.`,
    `Theme: "${ctx}" — Korean lifestyle magazine editorial aesthetic.`,
    `Scene: Premium product beautifully arranged in a serene, minimal home or spa environment.`,
    `Perspective: wide environmental shot showing the product in its natural setting.`,
    `Lighting: warm, soft natural window light. Gentle shadows. Golden hour feel.`,
    `Style: clean, airy, Scandinavian-Korean minimal. High-end editorial photography.`,
    `Color palette: warm whites, soft creams, muted natural tones, occasional warm accent.`,
    `NO text overlays, NO logos, NO watermarks, NO Korean text.`,
    `NO faces. Occasional hands OK if natural. Focus on the product and environment.`,
    `Aspect ratio: 4:3. Ultra photorealistic, shot with a full-frame camera, shallow depth of field.`,
  ].join('\n');
}

function scenePrompt2({ keyword, subject }) {
  const ctx = subject || keyword;
  return [
    `Create a high-quality close-up product photography image.`,
    `Theme: "${ctx}" — premium product texture and quality detail.`,
    `Scene: extreme close-up of the product surface showing texture, material quality, and craftsmanship.`,
    `Perspective: macro/close-up shot focusing on material texture, weave pattern, or fine details.`,
    `Lighting: soft studio light that reveals texture — slightly directional to show depth and softness.`,
    `Style: luxury product catalog photography. Clean background (white or very light neutral).`,
    `Color palette: natural material colors, clean neutrals.`,
    `NO text overlays, NO logos, NO watermarks.`,
    `Aspect ratio: 1:1. Ultra photorealistic, extreme detail, razor-sharp focus on texture.`,
  ].join('\n');
}

function scenePrompt3({ keyword, subject }) {
  const ctx = subject || keyword;
  return [
    `Create a lifestyle mood photography image.`,
    `Theme: "${ctx}" — the emotional benefit and end-result experience.`,
    `Scene: cozy, inviting atmosphere showing someone enjoying the result or benefit — a feeling of comfort, luxury, or well-being.`,
    `Perspective: medium shot, intimate and warm. Shows the lifestyle context and end benefit.`,
    `Lighting: warm indoor light, soft and flattering. Cozy and aspirational mood.`,
    `Style: Korean lifestyle blog photography — relatable yet aspirational. Like a premium Instagram flat-lay or lifestyle photo.`,
    `Color palette: warm neutrals, soft pastels, cozy tones.`,
    `NO text overlays, NO logos, NO watermarks, NO Korean text.`,
    `Faces cropped or turned away if present. Focus on mood and product interaction.`,
    `Aspect ratio: 3:4 vertical. Photorealistic, warm and inviting quality.`,
  ].join('\n');
}

// ────────────────────────────────────────────────
// Gemini 호출
// ────────────────────────────────────────────────
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

async function generateOne(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p.inlineData?.data);
  if (!imgPart) {
    throw new Error(
      `No image in response: ${JSON.stringify(json).slice(0, 500)}`
    );
  }
  return Buffer.from(imgPart.inlineData.data, 'base64');
}

// ────────────────────────────────────────────────
// 메인
// ────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const { title, keyword, quote, subject, output } = args;
  const points = splitList(args.points);
  const steps = splitList(args.steps);

  if (!title || !keyword || !output) {
    console.error(
      'Usage: --title <t> --keyword <k> --output <dir> [--points a|||b] [--quote q] [--steps a|||b] [--subject <한줄설명>]'
    );
    process.exit(2);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY environment variable is required.');
    process.exit(1);
  }

  await mkdir(output, { recursive: true });

  const jobs = [
    // ── 기존 디자인 이미지 4종 (로고 없음) ──────────────────────
    { name: 'thumbnail', prompt: thumbnailPrompt({ title, keyword }) },
    {
      name: 'infographic',
      prompt: infographicPrompt({
        keyword,
        points: points.length ? points : [keyword],
      }),
    },
    {
      name: 'quote-card',
      prompt: quoteCardPrompt({
        quote: quote || title,
        keyword,
      }),
    },
    {
      name: 'process',
      prompt: processPrompt({
        keyword,
        steps: steps.length ? steps : ['리서치', '기획', '제작', '검수'],
      }),
    },
    // ── 상황 이미지 3종 (실사풍 라이프스타일) ────────────────────
    { name: 'scene-1', prompt: scenePrompt1({ keyword, subject }) },
    { name: 'scene-2', prompt: scenePrompt2({ keyword, subject }) },
    { name: 'scene-3', prompt: scenePrompt3({ keyword, subject }) },
  ];

  let okCount = 0;
  const errors = [];

  for (const job of jobs) {
    try {
      console.log(`[generate] ${job.name} ...`);
      const buf = await generateOne(job.prompt);
      const path = join(output, `${job.name}.png`);
      await writeFile(path, buf);
      console.log(`  ✓ ${path} (${buf.length} bytes)`);
      okCount++;
    } catch (e) {
      console.error(`  ✗ ${job.name}: ${e.message}`);
      errors.push({ name: job.name, error: e.message });
    }
  }

  console.log(`\nDone: ${okCount}/${jobs.length} images saved to ${output}`);
  if (errors.length === jobs.length) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
