// scripts/sheets-tracker.js
// Google Sheets에서 키워드 읽기 + 사용일 기록
// A열: 키워드, B열: 사용일 (비어있으면 미사용)

import { google } from 'googleapis';
import { existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SERVICE_ACCOUNT_PATH = join(ROOT, 'service-account.json');

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

// 모든 키워드의 B열 사용일 초기화 (순환 리셋)
export async function clearAllUsedDates(sheetsId, rows) {
  const auth = getAuth();
  if (!auth) return;

  const sheets = google.sheets({ version: 'v4', auth });
  const data = rows.map(r => ({ range: `B${r.rowIndex}`, values: [['']] }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetsId,
    requestBody: { valueInputOption: 'RAW', data },
  });
  console.log(`[sheets] 순환 리셋 — ${rows.length}개 사용일 초기화`);
}
