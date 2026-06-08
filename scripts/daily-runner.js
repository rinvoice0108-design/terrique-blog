// scripts/daily-runner.js
// 매일 9시 자동 실행: Google Sheets → 키워드 2개 선택 → /blog-new → Gmail 발송
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── .env 로더 ────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(ROOT, '.env');
  const env = {};
  if (existsSync(envPath)) {
    readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const i = t.indexOf('=');
      if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
  }
  return { ...process.env, ...env };
}

// ── Google Sheets 공개 CSV 로드 ──────────────────────────────────
async function fetchKeywords(sheetsId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetsId}/export?format=csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets 접근 실패 (${res.status})`);
  const csv = await res.text();
  const rows = csv.split('\n').map(l => l.split(',')[0].trim().replace(/^"|"$/g, '').trim());
  const keywords = rows.filter(l => {
    if (!l || l.startsWith('#')) return false;
    if (/^https?:\/\//.test(l)) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(l)) return false;
    if (/^\d+$/.test(l)) return false;
    return true;
  });
  const headerWords = ['키워드', 'keyword', '순번', '번호', 'no', 'title', '제목'];
  if (keywords.length > 0 && headerWords.some(h => keywords[0].toLowerCase().includes(h))) {
    keywords.shift();
  }
  return keywords;
}

// ── 키워드 추적 ──────────────────────────────────────────────────
function getUsedKeywords() {
  const p = join(ROOT, 'keywords-used.txt');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
}

function pickNext(all, used, n = 2) {
  const unused = all.filter(k => !used.includes(k));
  if (unused.length < n) {
    writeFileSync(join(ROOT, 'keywords-used.txt'), '');
    console.log('[runner] 키워드 순환 — 처음부터 다시 시작');
    return all.slice(0, n);
  }
  return unused.slice(0, n);
}

function markUsed(keywords) {
  const p = join(ROOT, 'keywords-used.txt');
  const prev = existsSync(p) ? readFileSync(p, 'utf8') : '';
  writeFileSync(p, prev + keywords.join('\n') + '\n');
}

// ── 블로그 생성 ──────────────────────────────────────────────────
function runBlogNew(keyword) {
  console.log(`\n[runner] ▶ 시작: "${keyword}"`);
  try {
    execSync(
      `claude --print --dangerously-skip-permissions "/blog-new \\"${keyword}\\""`,
      { cwd: ROOT, timeout: 600_000, stdio: 'inherit' }
    );
    console.log(`[runner] ✓ 완료: "${keyword}"`);
    return true;
  } catch (err) {
    console.error(`[runner] ✗ 실패: "${keyword}" — ${err.message}`);
    return false;
  }
}

// ── output 폴더 직접 스캔 (index.json 의존 없음) ─────────────────
function getOutputFolderSet() {
  const outputDir = join(ROOT, 'output');
  if (!existsSync(outputDir)) return new Set();
  try {
    return new Set(
      readdirSync(outputDir).filter(f => {
        if (f === '.gitkeep' || f.endsWith('.json')) return false;
        return statSync(join(outputDir, f)).isDirectory();
      })
    );
  } catch { return new Set(); }
}

function buildPostDataFromDir(folderName) {
  const folder = join(ROOT, 'output', folderName);
  const mdPath = join(folder, 'post.md');
  const metaPath = join(folder, 'metadata.json');
  const previewPath = join(folder, 'preview.html');
  const imagesDir = join(folder, 'images');
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

  console.log(`[runner] 파일 읽기: ${folderName}`);
  console.log(`[runner]   post.md 존재: ${existsSync(mdPath)}`);
  console.log(`[runner]   metadata.json 존재: ${existsSync(metaPath)}`);
  console.log(`[runner]   images/ 존재: ${existsSync(imagesDir)}`);

  let fullContent = '';
  let excerpt = '';
  if (existsSync(mdPath)) {
    fullContent = readFileSync(mdPath, 'utf8');
    excerpt = fullContent
      .replace(/\[IMAGE:[^\]]*\]/g, '')
      .replace(/^#{1,3}[^\n]*/gm, '')
      .replace(/^---$/gm, '')
      .trim()
      .slice(0, 450);
  }

  let metadata = {};
  if (existsSync(metaPath)) {
    try { metadata = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {}
  }

  const images = [];
  if (existsSync(imagesDir)) {
    readdirSync(imagesDir)
      .filter(f => /\.(png|jpg|jpeg|gif)$/i.test(f))
      .forEach(f => images.push({ filename: f, path: join(imagesDir, f) }));
  }

  console.log(`[runner]   fullContent 길이: ${fullContent.length}, 이미지: ${images.length}장`);

  return {
    keyword: metadata.keyword || folderName,
    title: metadata.title || folderName,
    folder: folderName,
    excerpt,
    fullContent,
    metadata,
    images,
    isCI,
    previewPath: isCI ? null : `file:///${previewPath.replace(/\\/g, '/')}`
  };
}

// ── 메인 ────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv();

  if (!env.SHEETS_ID) { console.error('[runner] .env에 SHEETS_ID 없음'); process.exit(1); }
  if (!env.GMAIL_APP_PASSWORD) { console.error('[runner] .env에 GMAIL_APP_PASSWORD 없음'); process.exit(1); }

  console.log('[runner] Google Sheets 키워드 로드 중...');
  const allKeywords = await fetchKeywords(env.SHEETS_ID);
  console.log(`[runner] 총 ${allKeywords.length}개 키워드`);

  const usedKeywords = getUsedKeywords();
  const keywords = pickNext(allKeywords, usedKeywords, 2);
  console.log(`[runner] 오늘의 키워드: ${keywords.join(' / ')}`);

  // 실행 전 폴더 목록 캡처
  const beforeFolders = getOutputFolderSet();
  console.log(`[runner] 기존 output 폴더 수: ${beforeFolders.size}`);

  const succeeded = [];
  for (const kw of keywords) {
    if (runBlogNew(kw)) succeeded.push(kw);
  }

  if (succeeded.length === 0) {
    console.error('[runner] 포스트 생성 전부 실패.');
    process.exit(1);
  }

  markUsed(succeeded);

  // 실행 후 새로 생긴 폴더 감지
  const afterFolders = getOutputFolderSet();
  const newFolders = [...afterFolders].filter(f => !beforeFolders.has(f));
  console.log(`[runner] 새 폴더 감지: ${newFolders.join(', ')}`);

  if (newFolders.length === 0) {
    console.error('[runner] 새 포스트 폴더를 찾지 못했습니다.');
    process.exit(1);
  }

  const postData = newFolders.map(buildPostDataFromDir);

  const { sendEmail } = await import('./send-email.js');
  await sendEmail(postData, env);

  console.log('\n[runner] ✅ 완료!');
}

main().catch(err => {
  console.error('[runner] 오류:', err.message);
  process.exit(1);
});
