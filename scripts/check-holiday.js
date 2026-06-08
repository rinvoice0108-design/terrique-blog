#!/usr/bin/env node
/**
 * 오늘(KST)이 한국 공휴일/주말인지 체크합니다.
 * - 평일이면 exit(0) → 블로그 생성 진행
 * - 공휴일/주말이면 exit(1) → 건너뜀
 *
 * 연도가 바뀌어도 자동으로 해당 연도 공휴일을 조회합니다.
 * 데이터 출처: date.nager.at (무료 공개 API, 인증 불필요)
 *
 * Usage:
 *   node scripts/check-holiday.js          # 오늘 KST 기준 체크
 *   node scripts/check-holiday.js --force  # 체크 건너뜀 (수동 실행용)
 */

const args = process.argv.slice(2);
const FORCE = args.includes('--force');

if (FORCE) {
  console.log('[holiday] --force 플래그 — 공휴일 체크 건너뜀, 진행합니다.');
  process.exit(0);
}

// KST 기준 오늘 날짜 계산 (UTC + 9)
const now = new Date();
const kstMs = now.getTime() + (9 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000);
const kst = new Date(kstMs);
const today = kst.toISOString().slice(0, 10);
const year = today.slice(0, 4);
const dow = kst.getDay(); // 0=일, 1=월 ... 6=토

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

// 주말 체크
if (dow === 0 || dow === 6) {
  console.log(`[holiday] ${today} (${DAY_NAMES[dow]}요일) — 주말이므로 건너뜁니다.`);
  process.exit(1);
}

console.log(`[holiday] ${today} (${DAY_NAMES[dow]}요일) — 공휴일 확인 중...`);

// 한국 공휴일 조회 (date.nager.at — 연도 자동 반영)
// 설날/추석 등 음력 공휴일도 양력 날짜로 정확히 반환됩니다.
fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/KR`)
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then(holidays => {
    const match = holidays.find(h => h.date === today);
    if (match) {
      console.log(`[holiday] 🎌 공휴일: ${match.localName} (${match.name}) — 건너뜁니다.`);
      process.exit(1);
    }
    console.log(`[holiday] ✅ 평일 확인 — 블로그 생성을 시작합니다.`);
    process.exit(0);
  })
  .catch(err => {
    // API 오류 시 안전하게 진행 (공휴일 체크 실패가 블로그 생성을 막지 않음)
    console.error(`[holiday] ⚠️  API 오류 (무시하고 진행): ${err.message}`);
    process.exit(0);
  });
