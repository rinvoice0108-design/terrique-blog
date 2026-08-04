// scripts/send-email.js
// Gmail SMTP로 일일 블로그 리포트 발송 (nodemailer 사용)
import nodemailer from 'nodemailer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LOGS_DIR = join(ROOT, 'logs');

const GMAIL_USER = 'terriquead@gmail.com';
const MAX_SEND_ATTEMPTS = 3;

// 마크다운 표(| a | b |, 구분행 |---|---|)를 HTML 표로 변환. 나머지 치환보다
// 먼저 돌아야 한다 — 뒤 단계의 \n→<br> 치환이 표 문법을 줄단위로 쪼개버리면
// 더 이상 표로 인식할 수 없다.
function tableToHtml(md) {
  const tableBlockRe = /^\|.*\|[ \t]*\n\|[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|[ \t]*\n(\|.*\|[ \t]*\n?)*/gm;
  return md.replace(tableBlockRe, (block) => {
    const lines = block.trim().split('\n');
    const toCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const headerCells = toCells(lines[0]);
    const bodyLines = lines.slice(2);
    const th = headerCells
      .map((c) => `<th style="text-align:left;padding:5px 10px;border-bottom:1px solid #ddd;font-size:12px;color:#666;background:#fafafa;">${c}</th>`)
      .join('');
    const rows = bodyLines
      .map((line) => {
        const cells = toCells(line);
        return `<tr>${cells.map((c) => `<td style="padding:5px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#333;">${c}</td>`).join('')}</tr>`;
      })
      .join('');
    return `<table style="border-collapse:collapse;width:100%;margin:10px 0;"><tr>${th}</tr>${rows}</table>`;
  });
}

// [IMAGE: 설명] 마커를 실제 첨부된 이미지(cid)로 치환한다 — 마커 등장 순서대로
// images 배열(01-hero → 07-closing 순)을 하나씩 소비한다. 마커가 이미지보다
// 많으면 남는 마커는 지우고, 이미지가 마커보다 많으면 남는 이미지는 글 끝에
// 갤러리로 붙인다(버리지 않음).
function embedImages(md, images, cidPrefix) {
  let idx = 0;
  const withInline = md.replace(/\[IMAGE:[^\]]*\]/g, () => {
    const img = images[idx];
    if (!img) return '';
    const tag = `<img src="cid:${cidPrefix}-${idx}" alt="이미지" style="width:100%;border-radius:8px;display:block;margin:10px 0;" />`;
    idx++;
    return tag;
  });
  const leftover = images.slice(idx);
  const gallery = leftover.length
    ? '\n\n' + leftover.map((_, j) => `<img src="cid:${cidPrefix}-${idx + j}" alt="이미지" style="width:100%;border-radius:8px;display:block;margin:10px 0;" />`).join('\n')
    : '';
  return withInline + gallery;
}

function mdToHtml(md) {
  return tableToHtml(md)
    .replace(/^### (.+)$/gm, '<h3 style="font-size:15px;margin:16px 0 6px;color:#1A1A1A;">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:17px;margin:20px 0 8px;color:#1A1A1A;border-bottom:1px solid #eee;padding-bottom:5px;">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:20px;margin:0 0 14px;color:#1A1A1A;">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #eee;margin:14px 0;">')
    .replace(/\n{2,}/g, '</p><p style="margin:0 0 10px;line-height:1.85;">')
    .replace(/\n/g, '<br>')
    // 표/이미지는 블록 요소라 앞뒤로 붙던 문단 치환 잔재가 남으면 여백이 이상해진다.
    .replace(/<br>(\s*<table)/g, '$1')
    .replace(/(<\/table>)(\s*<br>)/g, '$1')
    .replace(/<br>(\s*<img)/g, '$1')
    .replace(/(<img[^>]*>)(\s*<br>)/g, '$1');
}

const BLOG_LABELS = ['개인 블로그', '브랜드 블로그'];
const BLOG_BADGE_COLORS = ['#A08878', '#D97A3A'];

// quality-report.json 요약 — 통과/경고/하드실패 개수와 실패 항목명만 간단히
function buildQualitySummary(report) {
  if (!report) return '';
  const allChecks = [
    ...(report.results || []),
    ...(report.title_checks || []),
    ...(report.image_meta_checks || []),
    ...(report.fact_checks || []),
  ];
  const total = allChecks.length;
  const warnings = allChecks.filter((r) => !r.pass).length;
  const passed = total - warnings;
  const hardFail = !!report.hard_fail;
  const hardFailItems = report.hard_fail_items || [];

  const statusColor = hardFail ? '#c0392b' : warnings > 0 ? '#d97a3a' : '#2e7d32';
  const statusLabel = hardFail ? '⛔ 하드 실패 있음' : warnings > 0 ? '⚠️ 경고 있음' : '✅ 전체 통과';

  return `
    <div style="background:#fafafa;border:1px solid #eee;border-radius:6px;padding:10px 14px;margin:0 20px 14px;font-size:12px;color:#555;">
      <span style="font-weight:700;color:${statusColor};">${statusLabel}</span>
      &nbsp;·&nbsp; 검사 ${total}개 중 통과 ${passed} / 경고 ${warnings}
      ${hardFailItems.length ? `<div style="margin-top:4px;color:#c0392b;">하드 실패 항목: ${hardFailItems.join(', ')}</div>` : ''}
    </div>`;
}

function buildCard(p, i) {
  const blogLabel = BLOG_LABELS[i];
  const blogBadge = blogLabel
    ? `<span style="display:inline-block;background:${BLOG_BADGE_COLORS[i]};color:#fff;font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;letter-spacing:0.5px;vertical-align:middle;margin-left:7px;">[${blogLabel}]</span>`
    : '';

  const header = `
    <div style="background:#1A1A1A;color:#fff;padding:14px 20px;">
      <div style="display:flex;align-items:center;gap:0;">
        <span style="font-size:11px;opacity:.5;letter-spacing:1px;">POST ${i + 1}</span>${blogBadge}<span style="font-size:11px;opacity:.5;letter-spacing:1px;">&nbsp;·&nbsp; ${p.keyword}</span>
      </div>
      <div style="font-size:18px;font-weight:700;margin-top:5px;line-height:1.4;">${p.title}</div>
      ${p.metadata?.tags ? `<div style="margin-top:6px;font-size:11px;opacity:.5;">${p.metadata.tags.map(t => '#' + t).join(' ')}</div>` : ''}
    </div>`;

  const qualitySummary = buildQualitySummary(p.qualityReport);

  // file:// 링크는 Gmail(https 페이지) 안에서는 브라우저 보안 정책상 클릭해도
  // 열리지 않는다(로컬 파일 접근 차단 — 우회 불가). 버튼으로 눈속임하지 말고
  // 처음부터 복사해서 주소창에 붙여넣는 방식으로 안내한다.
  const previewLink = p.previewPath
    ? `<div style="background:#F7F4F1;padding:12px 20px;border-bottom:1px solid #eee;font-size:12px;color:#888;">
        📂 발행 어시스턴트: 아래 경로를 <b>브라우저 주소창</b>에 붙여넣기
        <div style="margin-top:5px;font-family:monospace;font-size:11px;background:#ebebeb;padding:7px 10px;border-radius:4px;word-break:break-all;color:#444;">${p.previewPath}</div>
       </div>`
    : '';

  const cidPrefix = `img-${i}`;
  const bodyMd = embedImages(p.fullContent || p.excerpt, p.images || [], cidPrefix);
  const body = `<div style="padding:16px 20px;font-size:14px;line-height:1.85;color:#333;">
        <p style="margin:0 0 10px;line-height:1.85;">${mdToHtml(bodyMd)}</p>
       </div>`;

  return `<div style="margin-bottom:28px;border:1px solid #e0e0e0;border-radius:10px;overflow:hidden;font-family:-apple-system,sans-serif;">${header}${qualitySummary}${previewLink}${body}</div>`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sendEmail(posts, env) {
  const mailTo = env.MAIL_TO || GMAIL_USER;

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: GMAIL_USER,
      pass: env.GMAIL_APP_PASSWORD
    }
  });

  const today = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
  });

  const cards = posts.map((p, i) => buildCard(p, i)).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="background:#f0eeec;margin:0;padding:0;">
<div style="max-width:680px;margin:0 auto;padding:24px;">

  <div style="background:#A08878;color:#fff;padding:18px 24px;border-radius:10px;margin-bottom:22px;">
    <div style="font-size:20px;font-weight:700;">📝 테리크 블로그 일일 리포트</div>
    <div style="opacity:.85;font-size:13px;margin-top:6px;">${today} &nbsp;·&nbsp; 포스트 ${posts.length}개 완성</div>
  </div>

  ${cards}

  <div style="text-align:center;color:#bbb;font-size:11px;margin-top:16px;">
    Claude Code Blog Builder &nbsp;·&nbsp; 자동 발송
  </div>
</div>
</body></html>`;

  // 이미지 전부를 cid로 인라인 첨부한다. generate-images.js가 imageSize: '1K'로
  // 생성해 장당 ~0.8MB 수준이라(예전 2K는 ~3.3MB — 이게 Gmail 25MB 제한을 넘겨
  // 발송 자체가 실패했던 원인), 5장×2포스트를 다 첨부해도 총량이 넉넉히 안전하다.
  const attachments = [];
  posts.forEach((p, i) => {
    (p.images || []).forEach((img, j) => {
      attachments.push({
        filename: `[${p.keyword}] ${img.filename}`,
        path: img.path,
        cid: `img-${i}-${j}`,
      });
    });
  });

  const mailOptions = {
    from: `테리크 블로그 <${GMAIL_USER}>`,
    to: mailTo,
    subject: `[테리크 블로그] ${today} 포스트 ${posts.length}개 완성`,
    html,
    attachments,
  };

  let lastErr;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      await transporter.sendMail(mailOptions);
      console.log(`[email] ✓ 발송 완료 → ${mailTo}`);
      return;
    } catch (e) {
      lastErr = e;
      console.error(`[email] ✗ ${attempt}회 시도 실패: ${e.message}`);
      if (attempt < MAX_SEND_ATTEMPTS) {
        const waitMs = 2 ** attempt * 1000;
        console.error(`[email]   ${waitMs}ms 후 재시도...`);
        await sleep(waitMs);
      }
    }
  }

  // 3회 모두 실패 — 원문을 logs/에 백업해 수동 발송/확인이 가능하게 남긴다
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    const backupPath = join(LOGS_DIR, `email-failed-${Date.now()}.json`);
    writeFileSync(
      backupPath,
      JSON.stringify(
        {
          to: mailTo,
          subject: mailOptions.subject,
          html: mailOptions.html,
          attachments: attachments.map((a) => ({ filename: a.filename, path: a.path, cid: a.cid || null })),
          error: lastErr?.message,
          failed_at: new Date().toISOString(),
        },
        null,
        2
      )
    );
    console.error(`[email] 발송 실패 — 백업 저장: ${backupPath}`);
  } catch (backupErr) {
    console.error(`[email] 백업 저장도 실패: ${backupErr.message}`);
  }

  throw lastErr;
}
