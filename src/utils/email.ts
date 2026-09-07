import nodemailer, { Transporter } from 'nodemailer';
import { getEnv } from '@/config';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  const env = getEnv();
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      // Without explicit timeouts nodemailer waits on the OS default, which
      // can be minutes — long enough for a slow SMTP handshake to hang the
      // HTTP request that triggered it. Creating a worker is not allowed to
      // stall on the mail server, so give up quickly and let the caller
      // report the failure instead.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      // Reuse one authenticated connection across sends rather than doing
      // the TLS + auth handshake for every single email.
      pool: true,
      maxConnections: 3,
    });
  }
  return transporter;
}

export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const env = getEnv();
  const t = getTransporter();

  if (!t) {
    // No SMTP configured — log so the flow is still testable in dev.
    console.log(`[EMAIL] To: ${to} | Subject: ${subject}\n${text}`);
    return;
  }

  await t.sendMail({ from: env.EMAIL_FROM, to, subject, text, html });
}

export async function sendVerificationCodeEmail(to: string, code: string): Promise<void> {
  await sendEmail(
    to,
    'Verify your Car Wash Loyalty account',
    `Your verification code is: ${code}\n\nThis code expires in 10 minutes.`,
    `<p>Your verification code is: <strong style="font-size:20px">${code}</strong></p><p>This code expires in 10 minutes.</p>`
  );
}

export async function sendPasswordResetCodeEmail(to: string, code: string): Promise<void> {
  await sendEmail(
    to,
    'Reset your Car Wash Loyalty password',
    `Your password reset code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    `<p>Your password reset code is: <strong style="font-size:20px">${code}</strong></p><p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`
  );
}

/**
 * Notify support that someone reported a problem from inside the app.
 *
 * Throws if SMTP is misconfigured so the caller can record the failure
 * against the report — the report itself is already saved by then, so a
 * broken mail server loses the notification, never the report.
 */
export async function sendIssueReportEmail(
  to: string,
  report: {
    reference: string;
    subject: string;
    body: string;
    category: string;
    severity: string;
    reporter_name: string;
    reporter_role?: string | null;
    org_name?: string | null;
    branch_name?: string | null;
    context?: Record<string, unknown> | null;
  }
): Promise<void> {
  const who = [report.reporter_name, report.reporter_role].filter(Boolean).join(' · ');
  const where = [report.org_name, report.branch_name].filter(Boolean).join(' · ') || 'No organisation';
  const ctx = report.context && Object.keys(report.context).length
    ? Object.entries(report.context).map(([k, v]) => `  ${k}: ${v}`).join('\n')
    : '  (none)';

  const text =
    `${report.severity.toUpperCase()} · ${report.category.replace(/_/g, ' ')}\n` +
    `Reference: ${report.reference}\n\n` +
    `From: ${who}\n` +
    `Where: ${where}\n\n` +
    `${report.subject}\n\n${report.body}\n\n` +
    `Context:\n${ctx}\n`;

  const esc = (v: unknown) =>
    String(v ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

  const html =
    `<p><strong>${esc(report.severity.toUpperCase())}</strong> · ${esc(report.category.replace(/_/g, ' '))}<br/>` +
    `Reference: <code>${esc(report.reference)}</code></p>` +
    `<p>From: <strong>${esc(who)}</strong><br/>Where: ${esc(where)}</p>` +
    `<h3>${esc(report.subject)}</h3>` +
    `<p style="white-space:pre-wrap">${esc(report.body)}</p>` +
    `<pre style="background:#f5f5f5;padding:10px;font-size:12px">${esc(ctx)}</pre>`;

  await sendEmail(to, `[${report.severity}] ${report.reference} — ${report.subject}`, text, html);
}

/**
 * Tell the person who reported a problem that it has been dealt with.
 *
 * Throws on failure so the caller can record it — the status change itself is
 * already saved, so a mail problem loses the notification, never the update.
 */
export async function sendIssueResolvedEmail(
  to: string,
  report: {
    reference: string;
    subject: string;
    status: string;
    resolution?: string | null;
    resolved_by_name?: string | null;
  }
): Promise<void> {
  const esc = (v: unknown) =>
    String(v ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

  const headline = report.status === 'resolved' ? 'has been fixed' : 'has been closed';
  const outcome = report.resolution?.trim()
    ? report.resolution.trim()
    : 'No further details were given.';
  const by = report.resolved_by_name ? `\n\nHandled by: ${report.resolved_by_name}` : '';

  const text =
    `Your report ${headline}.\n\n` +
    `Reference: ${report.reference}\n` +
    `${report.subject}\n\n` +
    `What was done:\n${outcome}${by}\n\n` +
    `If this is still happening, report it again and quote ${report.reference}.`;

  const html =
    `<p>Your report <strong>${esc(headline)}</strong>.</p>` +
    `<p>Reference: <code>${esc(report.reference)}</code><br/><strong>${esc(report.subject)}</strong></p>` +
    `<p><em>What was done:</em><br/>${esc(outcome)}</p>` +
    (report.resolved_by_name ? `<p>Handled by: ${esc(report.resolved_by_name)}</p>` : '') +
    `<p style="color:#666;font-size:13px">If this is still happening, report it again and quote ${esc(report.reference)}.</p>`;

  await sendEmail(to, `${report.reference} — your report ${headline}`, text, html);
}

export async function sendStaffTempPasswordEmail(to: string, fullName: string, username: string, tempPassword: string, reason: 'created' | 'reset'): Promise<void> {
  const subject = reason === 'created' ? 'Your Car Wash Loyalty staff account' : 'Your Car Wash Loyalty password was reset';
  const intro = reason === 'created'
    ? `Hi ${fullName}, an account has been created for you.`
    : `Hi ${fullName}, your password has been reset.`;
  await sendEmail(
    to,
    subject,
    `${intro}\n\nUsername: ${username}\nTemporary password: ${tempPassword}\n\nYou'll be asked to set a new password the first time you sign in.`,
    `<p>${intro}</p><p>Username: <strong>${username}</strong><br/>Temporary password: <strong style="font-size:18px">${tempPassword}</strong></p><p>You'll be asked to set a new password the first time you sign in.</p>`
  );
}
