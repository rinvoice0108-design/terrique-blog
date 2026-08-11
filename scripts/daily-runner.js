// scripts/daily-runner.js
// 매일 자동 실행: Google Sheets → 미사용 키워드 2개 선택 → /blog-new → 날짜 기록 → Gmail 발송
import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchKeywordsWithStatus, markKeywordUsed, restoreServiceAccount, findSimilarKeywords, logFingerprintWarning } from './sheets-tracker.js';

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

// ── 미사용 키워드 n개 선택 (이미 쓴 주제와 유사한 건 걸러냄) ────────
function pickUnused(allRows, n = 2) {
  const used = allRows.filter(r => r.usedDate);
  const unused = allRows.filter(r => !r.usedDate);
  if (unused.length === 0) return { picked: [], reset: true };

  const picked = [];
  const skipped = [];
  for (const candidate of unused) {
    if (picked.length >= n) break;
    // 이미 발행된 키워드 + 오늘 이미 고른 키워드 둘 다와 비교
    const similar = findSimilarKeywords(candidate.keyword, [...used, ...picked]);
    if (similar.length > 0) {
      console.warn(`[runner] ⚠ "${candidate.keyword}" 건너뜀 — 유사 주제 이미 사용됨: ${similar.map(s => `"${s.keyword}"(${s.similarity}%)`).join(', ')}`);
      logFingerprintWarning(candidate.keyword, similar);
      skipped.push(candidate);
      continue;
    }
    picked.push(candidate);
  }

  // 전부 유사도로 걸러져 픽이 0개면, 최소 1개는 진행해야 하니 건너뛴 것 중
  // 가장 덜 유사했던 후보를 그대로 채택한다 (완전 중단보다 낫다).
  if (picked.length === 0 && skipped.length > 0) {
    console.warn('[runner] 모든 후보가 유사도로 걸러짐 — 그래도 진행을 위해 첫 후보를 그대로 사용');
    picked.push(skipped[0]);
  }

  return { picked, reset: false };
}

// ── 블로그 생성 ──────────────────────────────────────────────────
function runBlogNew(keyword) {
  console.log(`\n[runner] ▶ 시작: "${keyword}"`);
  try {
    execSync(
      `claude --print --dangerously-skip-permissions "/blog-new \\"${keyword}\\""`,
      { cwd: ROOT, timeout: 1_800_000, stdio: 'inherit' }
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
    ? readdirSync(imagesDir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).length
    : 0;

  if (existingCount >= 5) {
    console.log(`[runner] 이미지 이미 있음 (${existingCount}장): ${folderName}`);
    return;
  }

  if (!existsSync(metaPath)) {
    console.warn(`[runner] metadata.json 없음, 이미지 생성 건너뜀: ${folderName}`);
    return;
  }

  let meta = {};
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {}

  const keyword = meta.keyword || meta.main_keyword;
  if (!meta.title || !keyword) {
    console.warn(`[runner] metadata에 title/keyword(또는 main_keyword) 없음, 이미지 생성 건너뜀: ${folderName}`);
    return;
  }

  const points = Array.isArray(meta.image_points)
    ? meta.image_points.filter((p) => typeof p === 'string' && p.trim())
    : [];
  if (!meta.image_subject || points.length < 2) {
    console.warn(`[runner] metadata에 image_subject/image_points(최소 2개) 없음, 이미지 생성 건너뜀: ${folderName}`);
    return;
  }

  console.log(`[runner] 이미지 생성 시작 (${existingCount}/5): ${folderName}`);
  const args = [
    'scripts/generate-images.js',
    '--title', meta.title,
    '--keyword', keyword,
    '--subject', meta.image_subject,
    '--points', points.join('|||'),
    '--output', `output/${folderName}/images`,
  ];

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
  const qualityReportPath = join(folder, 'quality-report.json');
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

  let qualityReport = null;
  if (existsSync(qualityReportPath)) {
    try { qualityReport = JSON.parse(readFileSync(qualityReportPath, 'utf8')); } catch {}
  }

  const images = [];
  if (existsSync(imagesDir)) {
    readdirSync(imagesDir)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .forEach(f => images.push({ filename: f, path: join(imagesDir, f) }));
  }
  // 대표 이미지(01-hero) — 메일 본문 인라인용, cid로 참조
  const heroImage = images.find(img => img.filename.startsWith('01-hero')) || images[0] || null;

  console.log(`[runner]   fullContent 길이: ${fullContent.length}, 이미지: ${images.length}장`);

  return {
    keyword: metadata.keyword || folderName,
    title: metadata.title || folderName,
    folder: folderName,
    excerpt,
    fullContent,
    metadata,
    images,
    heroImage,
    qualityReport,
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

  const { picked, reset } = pickUnused(allRows);

  // ⚠️ 예전엔 여기서 clearAllUsedDates()로 B열 전체를 초기화하고 순환 재사용했다.
  // 이미 발행된 주제가 경고 없이 그대로 다시 뽑히는 부작용이 있어(2026-08-11 지적)
  // 순환을 없앴다 — 미사용 주제가 없으면 그냥 멈추고, 사람이 시트에 새 주제를 채워야 한다.
  if (reset) {
    console.log('[runner] 미사용 키워드가 없습니다 — 시트에 새 주제를 추가해주세요. 발행 건너뜀.');
    process.exit(0);
  }

  console.log(`[runner] 오늘의 키워드: ${picked.map(r => r.keyword).join(' / ')}`);

  // 실행 전 폴더 목록 캡처
  const beforeFolders = getOutputFolderSet();

  const succeeded = [];
  for (const row of picked) {
    if (runBlogNew(row.keyword)) succeeded.push(row);
  }

  // 실행 후 새로 생긴 폴더 감지 — execSync가 타임아웃으로 죽어도
  // /blog-new 자체는 이미 post.md/metadata.json을 디스크에 써놓은 경우가 있으므로
  // 프로세스 종료 상태가 아니라 실제 생성된 폴더로 성공 여부를 판단한다.
  const afterFolders = getOutputFolderSet();
  const newFolders = [...afterFolders].filter(f => !beforeFolders.has(f));
  console.log(`[runner] 새 폴더 감지: ${newFolders.join(', ')}`);

  if (newFolders.length === 0) {
    console.error('[runner] 포스트 생성 전부 실패 — 새로 생성된 폴더 없음.');
    process.exit(1);
  }

  if (succeeded.length === 0) {
    console.warn('[runner] claude 프로세스는 타임아웃/에러로 종료됐지만, 디스크에 새 폴더가 확인되어 계속 진행합니다.');
  }

  // Google Sheets B열에 사용일 기록 — execSync 성공 판정 + 실제 폴더가 생성된 키워드 모두 포함
  const newFolderKeywords = new Set(
    newFolders
      .map(f => {
        try {
          const meta = JSON.parse(readFileSync(join(ROOT, 'output', f, 'metadata.json'), 'utf8'));
          return meta.keyword || meta.main_keyword;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );
  const rowsToMark = picked.filter(row => succeeded.includes(row) || newFolderKeywords.has(row.keyword));

  const today = todayKST();
  for (const row of rowsToMark) {
    const ok = await markKeywordUsed(env.SHEETS_ID, row.rowIndex, today);
    if (ok) console.log(`[runner] 시트 기록: "${row.keyword}" → ${today}`);
  }

  // 모든 새 폴더에 이미지 5장이 있는지 확인 후 없으면 직접 생성
  for (const folderName of newFolders) {
    generateImagesForFolder(folderName, env);
  }

  // 메일 발송 전 preview.html을 미리 생성해둔다 — 안 만들어두면 메일 본문의
  // previewPath 링크가 존재하지 않는 파일을 가리키게 된다.
  for (const folderName of newFolders) {
    try {
      execFileSync(process.execPath, ['scripts/preview.js', '--folder', `output/${folderName}`, '--no-open'], {
        cwd: ROOT, timeout: 60_000, stdio: 'inherit', env,
      });
    } catch (e) {
      console.error(`[runner] ✗ preview.html 생성 실패: ${folderName} — ${e.message}`);
    }
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
