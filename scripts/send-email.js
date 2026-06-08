// scripts/send-email.js
// Gmail SMTP로 일일 블로그 리포트 발송 (nodemailer 사용)
import nodemailer from 'nodemailer';

const GMAIL_USER = 'terriquead@gmail.com';

function mdToHtml(md) {
  return md
    .replace(/\[IMAGE:[^\]]*\]/g, '<div style="background:#f5f5f5;padding:8px 12px;margin:8px 0;border-radius:4px;color:#999;font-size:12px;">📷 이미지 삽입 위치</div>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:15px;margin:16px 0 6px;color:#1A1A1A;">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:17px;margin:20px 0 8px;color:#1A1A1A;border-bottom:1px solid #eee;padding-bottom:5px;">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:20px;margin:0 0 14px;color:#1A1A1A;">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #eee;margin:14px 0;">')
    .replace(/\n{2,}/g, '</p><p style="margin:0 0 10px;line-height:1.85;">')
    .replace(/\n/g, '<br>');
}

function buildCard(p, i) {
  const header = `
    <div style="background:#1A1A1A;color:#fff;padding:14px 20px;">
      <div style="font-size:11px;opacity:.5;letter-spacing:1px;">POST ${i + 1} &nbsp;·&nbsp; ${p.keyword}</div>
      <div style="font-size:18px;font-weight:700;margin-top:5px;line-height:1.4;">${p.title}</div>
      ${p.metadata?.tags ? `<div style="margin-top:6px;font-size:11px;opacity:.5;">${p.metadata.tags.map(t => '#' + t).join(' ')}</div>` : ''}
    </div>`;

  const body = p.isCI
    ? `<div style="padding:16px 20px;font-size:14px;line-height:1.85;color:#333;">
        <p style="margin:0 0 10px;line-height:1.85;">${mdToHtml(p.fullContent || p.excerpt)}</p>
       </div>`
    : `<div style="background:#F7F4F1;padding:10px 20px;font-size:12px;color:#888;border-bottom:1px solid #eee;">
        📂 미리보기: 아래 경로를 <b>브라우저 주소창</b>에 붙여넣기
        <div style="margin-top:5px;font-family:monospace;font-size:11px;background:#ebebeb;padding:7px 10px;border-radius:4px;word-break:break-all;color:#444;">${p.previewPath}</div>
       </div>
       <div style="padding:16px 20px;font-size:14px;line-height:1.85;color:#333;white-space:pre-wrap;">${p.excerpt}</div>`;

  return `<div style="margin-bottom:28px;border:1px solid #e0e0e0;border-radius:10px;overflow:hidden;font-family:-apple-system,sans-serif;">${header}${body}</div>`;
}

export async function sendEmail(posts, env) {
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

  // 이미지 첨부파일 수집
  const attachments = [];
  posts.forEach(p => {
    (p.images || []).forEach(img => {
      attachments.push({ filename: `[${p.keyword}] ${img.filename}`, path: img.path });
    });
  });

  await transporter.sendMail({
    from: `테리크 블로그 <${GMAIL_USER}>`,
    to: GMAIL_USER,
    subject: `[테리크 블로그] ${today} 포스트 ${posts.length}개 완성`,
    html,
    attachments
  });

  console.log(`[email] ✓ 발송 완료 → ${GMAIL_USER}`);
}
