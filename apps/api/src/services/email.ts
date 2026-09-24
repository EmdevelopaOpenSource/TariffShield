import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends a plain-text email through the SendGrid v3 API. Throws on any
 * non-2xx response so callers can record the failure and retry.
 *
 * When SENDGRID_API_KEY / REPORT_FROM_EMAIL are not configured (local dev,
 * tests) the message is logged instead of sent, mirroring the existing
 * compliance-report notification stub.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!env.SENDGRID_API_KEY || !env.REPORT_FROM_EMAIL) {
    logger.info(
      { to: message.to, subject: message.subject },
      'email not configured; skipping send'
    );
    return;
  }

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: message.to }] }],
      from: { email: env.REPORT_FROM_EMAIL },
      subject: message.subject,
      content: [{ type: 'text/plain', value: message.text }],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendGrid responded ${res.status}: ${body.slice(0, 500)}`);
  }
}
