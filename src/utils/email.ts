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
