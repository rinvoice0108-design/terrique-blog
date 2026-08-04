#!/usr/bin/env node
/**
 * Claude Code PostToolUse 훅 라우터.
 * stdin으로 받은 JSON을 파싱해서 파일 경로가 output/<폴더>/post.md 일 때만
 * quality-check + duplicate-check을 자동 실행합니다.
 *
 * quality-check.js/duplicate-check.js 중 하나라도 exit 2(하드 게이트 실패)를
 * 반환하면 이 훅도 exit 2로 종료해 Claude에게 재작성이 필요함을 알립니다.
 * 단, 같은 post.md에 대해 게이트 실패가 MAX_GATE_RETRIES회를 넘게 누적되면
 * 무한 재작성 루프를 막기 위해 강제로 exit 0으로 전환하고 사람이 검토하도록
 * 안내합니다 (output/<폴더>/.gate-retry-count 파일로 누적 횟수 관리).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MAX_GATE_RETRIES = 3;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // stdin이 이미 닫혀 있으면 즉시 resolve
    if (process.stdin.readableEnded) resolve(data);
  });
}

function extractPath(payload) {
  try {
    const j = JSON.parse(payload);
    return (
      j?.tool_input?.file_path ||
      j?.tool_input?.path ||
      j?.file_path ||
      null
    );
  } catch {
    return null;
  }
}

function extractKeyword(filePath) {
  // metadata.json 우선(keyword 또는 main_keyword 필드명 둘 다 허용 — 실제 생성물에서
  // 두 필드명이 섞여 쓰이고 있었음), 없으면 폴더명에서 파싱
  try {
    const metaPath = join(dirname(filePath), 'metadata.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta.keyword) return meta.keyword;
    if (meta.main_keyword) return meta.main_keyword;
  } catch {
    // metadata.json 없거나 파싱 실패 → 폴더명 fallback
  }
  // output/2026-04-08_상세페이지AI/post.md → 상세페이지AI
  const folder = basename(dirname(filePath));
  return folder.replace(/^\d{4}-\d{2}-\d{2}_/, '');
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  return r.status;
}

function retryCountPath(filePath) {
  return join(dirname(filePath), '.gate-retry-count');
}

function readRetryCount(filePath) {
  try {
    return parseInt(readFileSync(retryCountPath(filePath), 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}

function writeRetryCount(filePath, n) {
  try {
    writeFileSync(retryCountPath(filePath), String(n));
  } catch {
    // 카운터 파일 기록 실패해도 훅 자체는 계속 진행
  }
}

function clearRetryCount(filePath) {
  try {
    if (existsSync(retryCountPath(filePath))) unlinkSync(retryCountPath(filePath));
  } catch {
    // 무시
  }
}

async function main() {
  const payload = await readStdin();
  const filePath = extractPath(payload);
  if (!filePath) process.exit(0);

  // output/<anything>/post.md 만 대상
  const normalized = filePath.replace(/\\/g, '/');
  if (!/\/output\/[^/]+\/post\.md$/.test(normalized)) process.exit(0);

  const keyword = extractKeyword(filePath);

  console.log(`\n🤖 [자동 훅] post.md 감지 → 품질검사 + 유사도검사 실행`);
  const qualityStatus = run('node', ['scripts/quality-check.js', '--file', filePath, '--keyword', keyword]);
  const duplicateStatus = run('node', ['scripts/duplicate-check.js', '--file', filePath]);

  const gateFailed = qualityStatus === 2 || duplicateStatus === 2;

  if (!gateFailed) {
    clearRetryCount(filePath);
    process.exit(0);
  }

  const failedChecks = [
    qualityStatus === 2 ? 'quality-check' : null,
    duplicateStatus === 2 ? 'duplicate-check' : null,
  ].filter(Boolean);

  const retryCount = readRetryCount(filePath) + 1;
  writeRetryCount(filePath, retryCount);

  if (retryCount > MAX_GATE_RETRIES) {
    console.error(
      `\n⛔ [자동 훅] ${failedChecks.join(', ')} 게이트 실패가 ${retryCount}회 누적됨 — 자동 수정 한계로 판단해 더 이상 차단하지 않습니다. quality-report.json을 사람이 직접 검토하세요.`
    );
    clearRetryCount(filePath);
    process.exit(0);
  }

  console.error(
    `\n⛔ [자동 훅] ${failedChecks.join(', ')} 게이트 실패 (${retryCount}/${MAX_GATE_RETRIES}회) — 위 리포트를 참고해 post.md(및 metadata.json)를 수정한 뒤 다시 저장하세요.`
  );
  process.exit(2);
}

main().catch(() => process.exit(0));
