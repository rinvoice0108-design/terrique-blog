// scripts/sheets-tracker.js
// Google Sheets에서 키워드 읽기 + 사용일 기록
// A열: 키워드, B열: 사용일 (비어있으면 미사용)

import { google } from 'googleapis';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { shingles, jaccard, containment } from './duplicate-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SERVICE_ACCOUNT_PATH = join(ROOT, 'service-account.json');
const FINGERPRINT_LOG_PATH = join(ROOT, 'knowledge', 'topic-fingerprints.json');

function getAuth() {
  if (!existsSync(SERVICE_ACCOUNT_PATH)) return null;
  return new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// A열 키워드, B열 사용일 읽기
export async function fetchKeywordsWithStatus(sheetsId) {
  const auth = getAuth();
  if (!auth) throw new Error('service-account.json 없음');

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetsId,
    range: 'A:B',
  });

  const rows = res.data.values || [];
  const result = [];

  for (let i = 0; i < rows.length; i++) {
    const keyword = rows[i][0]?.trim();
    if (!keyword) continue;

    // 헤더 행 스킵
    const headerWords = ['키워드', 'keyword', '순번', '번호', 'no', 'title', '제목'];
    if (i === 0 && headerWords.some(h => keyword.toLowerCase().includes(h))) continue;

    // URL, 날짜, 숫자만 있는 행 스킵
    if (/^https?:\/\//.test(keyword)) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(keyword)) continue;
    if (/^\d+$/.test(keyword)) continue;

    const usedDate = rows[i][1]?.trim() || '';
    result.push({ keyword, usedDate, rowIndex: i + 1 }); // 1-based
  }

  return result;
}

// A열에 새 키워드 행 추가 (B열은 비워둠 = 미사용). terrique-custom의
// lib/google-sheets.ts addTopic()과 대칭 — 관리자 사이트뿐 아니라
// blog-topics-research 같은 로컬 명령에서도 승인된 후보를 바로 추가할 수 있게.
export async function addKeyword(sheetsId, keyword) {
  const auth = getAuth();
  if (!auth) throw new Error('service-account.json 없음');

  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetsId,
    range: 'A:B',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[keyword, '']] },
  });
}

// "후보" 탭에 AI가 조사한 주제 후보를 추가한다. 실제 "키워드" 탭과는 별개 —
// 사람이 관리자 사이트("블로그 예상 주제")에서 검토·수정 후 채택해야
// 진짜 키워드 탭으로 넘어간다. blog-topics-research 명령이 이 함수를 쓴다.
export async function addCandidate(sheetsId, candidate) {
  const auth = getAuth();
  if (!auth) throw new Error('service-account.json 없음');

  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetsId,
    range: '후보!A:G',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        candidate.keyword,
        candidate.opportunity || '',
        candidate.competition || '',
        candidate.trend || '',
        candidate.journeyStage || '',
        candidate.rationale || '',
        candidate.addedAt || '',
      ]],
    },
  });
}

// B열에 사용일 기록
export async function markKeywordUsed(sheetsId, rowIndex, date) {
  const auth = getAuth();
  if (!auth) {
    console.warn('[sheets] service-account.json 없음 — 날짜 기록 건너뜀');
    return false;
  }

  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetsId,
    range: `B${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[date]] },
  });
  return true;
}

// service-account.json 환경변수에서 파일로 복원
export function restoreServiceAccount() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) return false;
  if (existsSync(SERVICE_ACCOUNT_PATH)) return true;
  writeFileSync(SERVICE_ACCOUNT_PATH, json, 'utf8');
  return true;
}

// ── 주제 지문(fingerprint) 유사도 ──────────────────────────────────
// duplicate-check.js와 동일한 shingle/jaccard/containment 로직을 재사용한다
// (본문 유사도 검사와 다른 알고리즘을 새로 만들지 않기 위함).
// 키워드는 문장 단위로 매우 짧아서(3~15자) 6-gram이면 셰이글이 거의 안 남는다
// — 3-gram으로 좀 더 민감하게 본다.
function keywordShingles(keyword) {
  return shingles(keyword, 3);
}

// candidate 키워드가 existingRows(사용됐거나 이미 오늘 선택된 키워드들) 중
// 유사한 게 있는지 검사. jaccard/containment 중 더 높은 값을 채택 —
// 길이가 크게 다른 키워드 쌍(예: "수건" vs "수건 세탁 주기")도 놓치지 않기 위함.
export function findSimilarKeywords(candidate, existingRows, threshold = 45) {
  const candShingles = keywordShingles(candidate);
  const hits = [];
  for (const row of existingRows) {
    const other = row.keyword || row;
    if (other === candidate) continue;
    const otherShingles = keywordShingles(other);
    const sim = Math.max(jaccard(candShingles, otherShingles), containment(candShingles, otherShingles));
    if (sim >= threshold) {
      hits.push({ keyword: other, similarity: Math.round(sim), usedDate: row.usedDate || null });
    }
  }
  return hits.sort((a, b) => b.similarity - a.similarity);
}

function loadFingerprintLog() {
  if (!existsSync(FINGERPRINT_LOG_PATH)) return { warnings: [] };
  try {
    const data = JSON.parse(readFileSync(FINGERPRINT_LOG_PATH, 'utf8'));
    return Array.isArray(data.warnings) ? data : { warnings: [] };
  } catch {
    return { warnings: [] };
  }
}

// 지문 경고 이력을 로컬 파일에 남긴다 (감사·추후 검토용 — 시트 자체가 항상
// source of truth이므로 이 파일은 캐시가 아니라 로그).
export function logFingerprintWarning(candidate, similarKeywords) {
  if (!similarKeywords.length) return;
  const log = loadFingerprintLog();
  log.warnings.push({
    candidate,
    similar: similarKeywords,
    detected_at: new Date().toISOString().slice(0, 10),
  });
  try {
    writeFileSync(FINGERPRINT_LOG_PATH, JSON.stringify(log, null, 2));
  } catch {
    // 로그 기록 실패해도 픽 로직은 계속 진행
  }
}
