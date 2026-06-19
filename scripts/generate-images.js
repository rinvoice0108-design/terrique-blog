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

const PHOTO_STYLE = [
  'warm soft natural lighting, shallow depth of field',
  'Korean lifestyle magazine editorial photography',
  'clean minimal background, warm neutral tones',
  'NO faces shown directly, absolutely NO text of any kind, NO words, NO letters, NO numbers, NO typography, NO overlays, NO logos, NO watermarks, NO captions, NO labels',
  'ultra photorealistic, full-frame camera quality',
  'pure photography only — zero graphic design elements, zero text, zero writing of any kind',
].join('. ');

const DESIGN_STYLE = [
  `Minimal Korean editorial design. off-white background (${BG_COLOR}), deep charcoal text (${FG_COLOR}), warm accent (${ACCENT})`,
  'clean sans-serif typography, generous whitespace, clear hierarchy',
  'NO logos, NO watermarks, NO brand names',
  'Korean text must render perfectly legible and sharp',
].join('. ');

// ────────────────────────────────────────────────
// 콘텐츠 매칭 이미지 7종 (글 주제에 맞게 자연스럽게)
// ────────────────────────────────────────────────
function buildContentPrompts({ title, keyword, subject, points, quote }) {
  const ctx = subject || keyword;
  const mainPoint  = points[0] || ctx;
  const secondPoint = points[1] || ctx;
  const thirdPoint  = points[2] || mainPoint;
  const keyQuote    = quote || title;

  return [
    {
      name: '01-hero',
      prompt: [
        `Create a 16:9 blog hero image for a Korean lifestyle blog article.`,
        `Article topic: "${ctx}". Article title: "${title}".`,
        `Scene: Wide editorial lifestyle shot. The subject "${ctx}" beautifully presented in a premium, serene Korean home setting.`,
        `The image should immediately communicate the article's core topic to a reader scanning the page.`,
        `Warm window light, confident editorial composition, premium and aspirational feel.`,
        PHOTO_STYLE,
        `Aspect ratio: 16:9 wide landscape.`,
      ].join('\n'),
    },
    {
      name: '02-opening',
      prompt: [
        `Create a 4:3 lifestyle scene photography image.`,
        `Article topic: "${ctx}". Opening context: "${mainPoint}".`,
        `Scene: A natural, everyday moment that introduces the article's problem or starting situation. Candid and relatable. Medium shot, intimate and warm.`,
        `Should feel like a real-life moment — not staged. The viewer should see themselves in this scene.`,
        PHOTO_STYLE,
        `Aspect ratio: 4:3.`,
      ].join('\n'),
    },
    {
      name: '03-detail',
      prompt: [
        `Create a 1:1 square close-up detail photography image.`,
        `Article topic: "${ctx}". Focus point: "${secondPoint}".`,
        `Scene: Macro/close-up shot of the key subject — shows texture, material quality, or a fine detail directly relevant to this aspect of the article.`,
        `Soft studio lighting revealing texture depth. Very clean neutral background. Ultra-sharp focus on the detail.`,
        PHOTO_STYLE,
        `Aspect ratio: 1:1 square.`,
      ].join('\n'),
    },
    {
      name: '04-product',
      prompt: [
        `Create a 2:3 vertical product arrangement lifestyle photography image.`,
        `Article topic: "${ctx}". Showcase: "${mainPoint}".`,
        `Scene: An elegant flat-lay or product arrangement directly related to "${ctx}". Items beautifully organized on a neutral linen or marble surface, showing quality and attention to detail. Overhead or slight angle view. Soft even lighting.`,
        `Ultra clean and premium feel. No people. No props that distract.`,
        PHOTO_STYLE,
        `Aspect ratio: 2:3 vertical. Pure product photography, absolutely no text.`,
      ].join('\n'),
    },
    {
      name: '05-scene',
      prompt: [
        `Create a 4:3 lifestyle moment photography image.`,
        `Article topic: "${ctx}". Illustrates the benefit: "${thirdPoint}".`,
        `Scene: A specific practical moment showing the positive outcome — experiencing or using "${ctx}" in a way that delivers the benefit described. Shows the "after" result.`,
        `Warm, bright, and aspirational. Like a practical tip being visually demonstrated in a premium home.`,
        PHOTO_STYLE,
        `Aspect ratio: 4:3.`,
      ].join('\n'),
    },
    {
      name: '06-ambient',
      prompt: [
        `Create a 1:1 square ambient lifestyle interior photography image.`,
        `Article topic: "${ctx}". Atmosphere: premium, warm, serene.`,
        `Scene: A beautifully styled interior vignette that evokes the feeling of "${ctx}" — a sunlit bathroom shelf, a softly lit bedroom corner, or a cozy linen closet. Atmospheric and aspirational. No people.`,
        `Warm diffused window light, muted neutral tones. Everything is perfectly ordered and aspirational.`,
        PHOTO_STYLE,
        `Aspect ratio: 1:1 square. Pure atmospheric photograph, absolutely no text.`,
      ].join('\n'),
    },
    {
      name: '07-closing',
      prompt: [
        `Create a 3:4 vertical lifestyle mood photography image.`,
        `Article topic: "${ctx}".`,
        `Scene: Atmospheric, aspirational closing image. Conveys the desired end-state feeling — comfort, quality, or well-being that the article's topic promises.`,
        `Beautiful, cozy interior or softly lit environment. Warm and inviting. Premium but attainable.`,
        `Wide or medium shot. The viewer should feel the article's emotional payoff.`,
        PHOTO_STYLE,
        `Aspect ratio: 3:4 vertical.`,
      ].join('\n'),
    },
  ];
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

  if (!title || !keyword || !output) {
    console.error(
      'Usage: --title <t> --keyword <k> --output <dir> [--points a|||b] [--quote q] [--subject <한줄설명>]'
    );
    process.exit(2);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY environment variable is required.');
    process.exit(1);
  }

  await mkdir(output, { recursive: true });

  const jobs = buildContentPrompts({ title, keyword, subject, points, quote });

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
