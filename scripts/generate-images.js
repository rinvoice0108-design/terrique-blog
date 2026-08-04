#!/usr/bin/env node
/**
 * 블로그 이미지 생성기
 * Nano Banana Pro (Gemini Image) REST API 직접 호출.
 * 외부 의존성 없음 — Node 20+ 내장 fetch 사용.
 *
 * --subject/--points는 필수입니다. 비워두면 프롬프트 내용이 키워드 한 단어로
 * 붕괴해 이미지가 매번 비슷하게 나오므로, 값이 없으면 즉시 에러로 종료합니다.
 *
 * assets/product-master.jpg가 있으면 5장 전부에 참조 이미지로 첨부해
 * 제품 일관성을 확보합니다(없어도 동작은 하되 경고를 출력합니다).
 *
 * Usage:
 *   GEMINI_API_KEY=xxx node scripts/generate-images.js \
 *     --title "..." --keyword "..." \
 *     --subject "블로그 핵심 주제 한 줄 설명" \
 *     --points "p1|||p2|||p3" \
 *     --output "output/folder/images"
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const AXES_PATH = join(ROOT, 'knowledge', 'image-axes.json');
const REFERENCE_IMAGE_PATH = join(ROOT, 'assets', 'product-master.jpg');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────
// 사진 스타일 — 텍스트 오버레이 없는 순수 사진. 축(angle/light/surface/shot)은
// buildContentPrompts에서 글마다 다르게 조합해 대입한다.
// ────────────────────────────────────────────────
const PHOTO_STYLE = [
  'Korean lifestyle magazine editorial photography, ultra photorealistic, full-frame camera quality',
  'absolutely NO text of any kind: NO words, NO letters, NO numbers, NO typography, NO overlays, NO logos, NO watermarks, NO captions, NO labels, NO brand names',
  'NO faces shown directly',
  'pure photography only — zero graphic design elements, zero rendered text',
].join('. ');

// ────────────────────────────────────────────────
// 축 로테이션 — 글마다 다른 앵글/조명/배경/샷 조합을 결정론적으로 선택
// ────────────────────────────────────────────────
let axesCache = null;
async function loadAxes() {
  if (axesCache) return axesCache;
  const raw = await readFile(AXES_PATH, 'utf8');
  axesCache = JSON.parse(raw);
  return axesCache;
}

function pickIndex(seed, arrLen) {
  const hash = createHash('sha256').update(seed).digest('hex');
  const n = parseInt(hash.slice(0, 8), 16);
  return n % arrLen;
}

function pickAxisValue(axes, axisName, seedParts) {
  const arr = axes[axisName];
  return arr[pickIndex(seedParts.join('|'), arr.length)];
}

// ────────────────────────────────────────────────
// 참조 이미지 (제품 마스터컷 1장, 로테이션 풀 아님)
// ────────────────────────────────────────────────
async function loadReferenceImage() {
  if (!existsSync(REFERENCE_IMAGE_PATH)) return null;
  const buf = await readFile(REFERENCE_IMAGE_PATH);
  const ext = REFERENCE_IMAGE_PATH.split('.').pop().toLowerCase();
  const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { mimeType, data: buf.toString('base64') };
}

// ────────────────────────────────────────────────
// 콘텐츠 매칭 이미지 5종 (글 주제에 맞게, 텍스트 오버레이 없음)
// ────────────────────────────────────────────────
const JOB_DEFS = [
  { name: '01-hero', aspect: '16:9', role: 'hero' },
  { name: '03-detail', aspect: '1:1', role: 'detail' },
  { name: '04-product', aspect: '2:3', role: 'product' },
  { name: '05-scene', aspect: '4:3', role: 'scene' },
  { name: '07-closing', aspect: '3:4', role: 'closing' },
];

function buildContentPrompts({ title, keyword, subject, points, dateSeed, axes }) {
  const ctx = subject;
  const mainPoint = points[0];
  const secondPoint = points[1];
  const thirdPoint = points[2] || mainPoint;

  return JOB_DEFS.map((job) => {
    const seedBase = [dateSeed, keyword, job.name];
    const angle = pickAxisValue(axes, 'angle', [...seedBase, 'angle']);
    const light = pickAxisValue(axes, 'light', [...seedBase, 'light']);
    const surface = pickAxisValue(axes, 'surface', [...seedBase, 'surface']);
    const shot = pickAxisValue(axes, 'shot', [...seedBase, 'shot']);

    let sceneLine;
    switch (job.role) {
      case 'hero':
        sceneLine = `Wide editorial lifestyle shot. The subject "${ctx}" beautifully presented, near ${surface}. This image should immediately communicate the article's core topic to a reader scanning the page. Confident editorial composition, premium and aspirational feel.`;
        break;
      case 'detail':
        sceneLine = `${shot} of the key subject related to "${secondPoint || ctx}" — shows texture, material quality, or a fine detail. On ${surface}. Ultra-sharp focus on the detail.`;
        break;
      case 'product':
        sceneLine = `Elegant flat-lay or product arrangement related to "${mainPoint || ctx}". Items beautifully organized on ${surface}, showing quality and attention to detail. No people, no distracting props.`;
        break;
      case 'scene':
        sceneLine = `A specific practical moment showing "${thirdPoint || ctx}" in a premium home setting, near ${surface}. Shows a real-life "after" result or benefit being experienced.`;
        break;
      case 'closing':
        sceneLine = `Atmospheric, aspirational closing image conveying the desired end-state feeling related to "${ctx}", styled with ${surface}. Warm and inviting, premium but attainable. The viewer should feel the article's emotional payoff.`;
        break;
    }

    const prompt = [
      `Create a ${job.aspect} blog image for a Korean lifestyle blog article.`,
      `Article topic: "${ctx}". Article title: "${title}".`,
      `Scene: ${sceneLine}`,
      `Camera: ${shot}, ${angle}.`,
      `Lighting: ${light}.`,
      PHOTO_STYLE,
      `Aspect ratio: ${job.aspect}.`,
    ].join('\n');

    return { name: job.name, aspect: job.aspect, prompt };
  });
}

// ────────────────────────────────────────────────
// Gemini 호출 (재시도 3회 + 지수 백오프, imageConfig로 종횡비 강제, mimeType 확인)
// ────────────────────────────────────────────────
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

async function generateOnceRaw(prompt, aspect, reference) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const parts = [{ text: prompt }];
  if (reference) parts.push({ inlineData: reference });

  const body = {
    contents: [{ parts }],
    generationConfig: {
      imageConfig: { aspectRatio: aspect, imageSize: '1K' },
    },
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
  const responseParts = json?.candidates?.[0]?.content?.parts || [];
  const imgPart = responseParts.find((p) => p.inlineData?.data);
  if (!imgPart) {
    throw new Error(`No image in response: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return {
    buffer: Buffer.from(imgPart.inlineData.data, 'base64'),
    mimeType: imgPart.inlineData.mimeType || 'image/png',
  };
}

async function generateOne(prompt, aspect, reference) {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await generateOnceRaw(prompt, aspect, reference);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        const waitMs = 2 ** attempt * 1000;
        console.error(`  ⚠ ${attempt}회 시도 실패 (${e.message.slice(0, 120)}), ${waitMs}ms 후 재시도...`);
        await sleep(waitMs);
      }
    }
  }
  throw lastErr;
}

function extFromMime(mimeType) {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  return 'jpg';
}

// ────────────────────────────────────────────────
// 메인
// ────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const { title, keyword, subject, output } = args;
  const points = splitList(args.points);

  if (!title || !keyword || !output) {
    console.error(
      'Usage: --title <t> --keyword <k> --subject <한줄설명> --points a|||b --output <dir>'
    );
    process.exit(2);
  }
  if (!subject || !subject.trim()) {
    console.error(
      'ERROR: --subject 필수 — 비어 있으면 이미지 프롬프트 내용이 키워드 한 단어로 붕괴해 매번 비슷한 이미지가 나옵니다. 구체적인 장면 설명을 전달하세요.'
    );
    process.exit(2);
  }
  if (points.length < 2) {
    console.error(
      'ERROR: --points 최소 2개 필요 (|||로 구분). 예: --points "포인트1|||포인트2|||포인트3"'
    );
    process.exit(2);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY environment variable is required.');
    process.exit(1);
  }

  await mkdir(output, { recursive: true });

  const axes = await loadAxes();
  const dateSeed = new Date().toISOString().slice(0, 10);
  const jobs = buildContentPrompts({ title, keyword, subject, points, dateSeed, axes });

  const reference = await loadReferenceImage();
  if (!reference) {
    console.warn(
      `[generate] 참조 이미지 없음 (${REFERENCE_IMAGE_PATH}) — 제품 일관성 없이 생성합니다. 실제 제품 사진 1장을 이 경로에 두면 5장 전부에 공통 참조로 첨부됩니다.`
    );
  }

  let okCount = 0;
  const errors = [];

  for (const job of jobs) {
    const existing = ['png', 'jpg', 'webp']
      .map((ext) => join(output, `${job.name}.${ext}`))
      .find(existsSync);
    if (existing) {
      console.log(`[generate] ${job.name} 이미 존재, 건너뜀`);
      okCount++;
      continue;
    }
    try {
      console.log(`[generate] ${job.name} ...`);
      const { buffer, mimeType } = await generateOne(job.prompt, job.aspect, reference);
      const ext = extFromMime(mimeType);
      const path = join(output, `${job.name}.${ext}`);
      await writeFile(path, buffer);
      console.log(`  ✓ ${path} (${buffer.length} bytes, ${mimeType})`);
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
