// scripts/daily-runner.js
// 매일 9시 자동 실행: Google Sheets → 키워드 2개 선택 → /blog-new → Gmail 발송
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
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
  if (!res.ok) throw new Error(`Sheets 접근 실패 (${res.status}). 시트를 "링크 있는 모든 사용자 → 뷰어"로 공개했는지 확인하세요.`);
  const csv = await res.text();

  // A열 첫 번째 값만 추출 (헤더 행 자동 감지: 숫자로 시작하지 않고 URL 아니고 날짜 아닌 줄)
  const rows = csv.split('\n').map(l => l.split(',')[0].trim().replace(/^"|"$/g, '').trim());
  const keywords = rows.filter(l => {
    if (!l || l.startsWith('#')) return false;
    if (/^https?:\/\//.test(l)) return false;      // URL 제외
    if (/^\d{4}-\d{2}-\d{2}$/.test(l)) return false; // 날짜 제외
    if (/^\d+$/.test(l)) return false;               // 순번 제외
    return true;
  });

  // 첫 행이 헤더처럼 보이면 제거 (예: "키워드", "keyword", "순번" 등)
  const headerWords = ['키워드', 'keyword', '순번', '번호', 'no', 'title', '제목'];
  if (keywords.length > 0 && headerWords.some(h => keywords[0].toLowerCase().includes(h))) {
    keywords.shift();
  }

  return keywords;
}

// ── 사용된 키워드 추적 ───────────────────────────────────────────
function getUsedKeywords() {
  const p = join(ROOT, 'keywords-used.txt');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
}

function pickNext(all, used, n = 2) {
  const unused = all.filter(k => !used.includes(k));
  if (unused.length < n) {
    // 전부 소진 → 초기화 후 처음부터
    writeFileSync(join(ROOT, 'keywords-used.txt'), '');
    console.log('[runner] 키워드 목록 순환 — 처음부터 다시 시작합니다');
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

// ── output/_index.json에서 새 포스트 감지 ───────────────────────
function getIndexFolders() {
  const p = join(ROOT, 'output', '_index.json');
  if (!existsSync(p)) return new Set();
  return new Set((JSON.parse(readFileSync(p, 'utf8')).posts || []).map(p => p.folder));
}

function getNewPosts(beforeFolders) {
  const p = join(ROOT, 'output', '_index.json');
  if (!existsSync(p)) return [];
  const all = JSON.parse(readFileSync(p, 'utf8')).posts || [];
  return all.filter(post => !beforeFolders.has(post.folder));
}

function buildPostData(post) {
  const folder = join(ROOT, 'output', post.folder);
  const mdPath = join(folder, 'post.md');
  const previewPath = join(folder, 'preview.html');
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

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
  const metaPath = join(folder, 'metadata.json');
  if (existsSync(metaPath)) {
    try { metadata = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {}
  }

  // 이미지 파일 수집
  const imagesDir = join(folder, 'images');
  const images = [];
  if (existsSync(imagesDir)) {
    readdirSync(imagesDir)
      .filter(f => /\.(png|jpg|jpeg|gif)$/i.test(f))
      .forEach(f => images.push({ filename: f, path: join(imagesDir, f) }));
  }

  return {
    keyword: post.keyword,
    title: post.title,
    folder: post.folder,
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

  if (!env.SHEETS_ID) {
    console.error('[runner] .env에 SHEETS_ID가 없습니다. 설정 후 다시 실행하세요.');
    process.exit(1);
  }
  if (!env.GMAIL_APP_PASSWORD) {
    console.error('[runner] .env에 GMAIL_APP_PASSWORD가 없습니다.');
    process.exit(1);
  }

  console.log('[runner] Google Sheets 키워드 로드 중...');
  const allKeywords = await fetchKeywords(env.SHEETS_ID);
  console.log(`[runner] 총 ${allKeywords.length}개 키워드 로드됨`);

  const usedKeywords = getUsedKeywords();
  const keywords = pickNext(allKeywords, usedKeywords, 2);
  console.log(`[runner] 오늘의 키워드: ${keywords.join(' / ')}`);

  const beforeFolders = getIndexFolders();
  const succeeded = [];

  for (const kw of keywords) {
    if (runBlogNew(kw)) succeeded.push(kw);
  }

  if (succeeded.length === 0) {
    console.error('[runner] 포스트 생성 전부 실패. 이메일 발송 취소.');
    process.exit(1);
  }

  markUsed(succeeded);

  const newPosts = getNewPosts(beforeFolders);
  if (newPosts.length === 0) {
    console.error('[runner] _index.json에서 새 포스트를 찾지 못했습니다.');
    process.exit(1);
  }

  const postData = newPosts.map(buildPostData);

  // 디버그: 파일 경로 및 내용 확인
  postData.forEach((p, i) => {
    console.log(`[debug] 포스트 ${i+1}: ${p.folder}`);
    console.log(`[debug] fullContent 길이: ${p.fullContent?.length || 0}`);
    console.log(`[debug] 이미지 수: ${p.images?.length || 0}`);
    console.log(`[debug] isCI: ${p.isCI}`);
  });

  const { sendEmail } = await import('./send-email.js');
  await sendEmail(postData, env);

  console.log('\n[runner] ✅ 완료! 이메일이 발송되었습니다.');
}

main().catch(err => {
  console.error('[runner] 치명적 오류:', err.message);
  process.exit(1);
});
