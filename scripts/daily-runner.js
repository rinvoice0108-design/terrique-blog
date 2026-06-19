// scripts/daily-runner.js
// 매일 자동 실행: Google Sheets → 미사용 키워드 2개 선택 → /blog-new → 날짜 기록 → Gmail 발송
import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchKeywordsWithStatus, markKeywordUsed, restoreServiceAccount } from './sheets-tracker.js';

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

function todayKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

// ── 미사용 키워드 2개 선택 ────────────────────────────────────────
function pickUnused(allRows, n = 2) {
  const unused = allRows.filter(r => !r.usedDate);
  if (unused.length === 0) return { picked: [], reset: true };
  return { picked: unused.slice(0, n), reset: false };
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

// ── output 폴더 스캔 ─────────────────────────────────────────────
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

function generateImagesForFolder(folderName, env) {
  const folder = join(ROOT, 'output', folderName);
  const metaPath = join(folder, 'metadata.json');
  const imagesDir = join(folder, 'images');

  const existingCount = existsSync(imagesDir)
    ? readdirSync(imagesDir).filter(f => /\.(png|jpg|jpeg|gif)$/i.test(f)).length
    : 0;

  if (existingCount >= 7) {
    console.log(`[runner] 이미지 이미 있음 (${existingCount}장): ${folderName}`);
    return;
  }

  if (!existsSync(metaPath)) {
    console.warn(`[runner] metadata.json 없음, 이미지 생성 건너뜀: ${folderName}`);
    return;
  }

  let meta = {};
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {}

  if (!meta.title || !meta.keyword) {
    console.warn(`[runner] metadata에 title/keyword 없음, 이미지 생성 건너뜀: ${folderName}`);
    return;
  }

  console.log(`[runner] 이미지 생성 시작 (${existingCount}/7): ${folderName}`);
  const args = [
    'scripts/generate-images.js',
    '--title', meta.title,
    '--keyword', meta.keyword,
    '--output', `output/${folderName}/images`,
  ];
  if (meta.image_points)  args.push('--points', meta.image_points);
  if (meta.image_quote)   args.push('--quote', meta.image_quote);
  if (meta.image_subject) args.push('--subject', meta.image_subject);

  try {
    execFileSync(process.execPath, args, {
      cwd: ROOT, timeout: 300_000, stdio: 'inherit', env
    });
    console.log(`[runner] ✓ 이미지 생성 완료: ${folderName}`);
  } catch (e) {
    console.error(`[runner] ✗ 이미지 생성 실패: ${folderName} — ${e.message}`);
  }
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

  // service-account.json 복원 (GitHub Actions 환경)
  restoreServiceAccount();

  console.log('[runner] Google Sheets 키워드 로드 중...');
  const allRows = await fetchKeywordsWithStatus(env.SHEETS_ID);
  console.log(`[runner] 총 ${allRows.length}개 키워드`);

  const used = allRows.filter(r => r.usedDate).length;
  const unused = allRows.filter(r => !r.usedDate).length;
  console.log(`[runner] 사용됨: ${used}개 / 미사용: ${unused}개`);

  let { picked, reset } = pickUnused(allRows);

  if (reset) {
    console.log('[runner] 모든 키워드 사용 완료 — 순환 초기화 후 처음부터 시작');
    // B열 전체 초기화 후 다시 선택
    const { clearAllUsedDates } = await import('./sheets-tracker.js');
    await clearAllUsedDates(env.SHEETS_ID, allRows);
    const refreshed = await fetchKeywordsWithStatus(env.SHEETS_ID);
    picked = pickUnused(refreshed).picked;
  }

  console.log(`[runner] 오늘의 키워드: ${picked.map(r => r.keyword).join(' / ')}`);

  // 실행 전 폴더 목록 캡처
  const beforeFolders = getOutputFolderSet();

  const succeeded = [];
  for (const row of picked) {
    if (runBlogNew(row.keyword)) succeeded.push(row);
  }

  if (succeeded.length === 0) {
    console.error('[runner] 포스트 생성 전부 실패.');
    process.exit(1);
  }

  // Google Sheets B열에 사용일 기록
  const today = todayKST();
  for (const row of succeeded) {
    const ok = await markKeywordUsed(env.SHEETS_ID, row.rowIndex, today);
    if (ok) console.log(`[runner] 시트 기록: "${row.keyword}" → ${today}`);
  }

  // 실행 후 새로 생긴 폴더 감지
  const afterFolders = getOutputFolderSet();
  const newFolders = [...afterFolders].filter(f => !beforeFolders.has(f));
  console.log(`[runner] 새 폴더 감지: ${newFolders.join(', ')}`);

  if (newFolders.length === 0) {
    console.error('[runner] 새 포스트 폴더를 찾지 못했습니다.');
    process.exit(1);
  }

  // 모든 새 폴더에 이미지 7장이 있는지 확인 후 없으면 직접 생성
  for (const folderName of newFolders) {
    generateImagesForFolder(folderName, env);
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
