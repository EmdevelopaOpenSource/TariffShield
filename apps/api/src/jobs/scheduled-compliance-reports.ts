import { createHash, randomBytes } from 'node:crypto';
import { pool, createNotification } from '../db.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { NOTIFICATION_KINDS } from '../constants/notification-kinds.js';
import { sendEmail } from '../services/email.js';
import { buildReportData, generateAndUploadPdf } from './compliance-report.js';

/**
 * Issue #1013 — scheduled automated delivery of compliance reports.
 *
 * A surety admin configures a schedule (report type, weekly/monthly cadence,
 * recipient emails). Each scheduler pass:
 *   1. claims schedules whose next_run_at has passed, generates the report for
 *      the period that just closed via the existing compliance-report logic,
 *      and queues one delivery per recipient;
 *   2. sends due deliveries — each email carries a single-recipient, expiring
 *      download link — retrying failures with exponential backoff.
 */

export const SCHEDULED_REPORT_TYPES = ['compliance_summary'] as const;
export type ScheduledReportType = (typeof SCHEDULED_REPORT_TYPES)[number];

export const REPORT_CADENCES = ['weekly', 'monthly'] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

// Runs line up with the monthly report job's 06:00 UTC slot.
const RUN_HOUR_UTC = 6;
export const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_BASE_MS = 5 * 60 * 1000;
export const DOWNLOAD_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A claimed delivery is leased for this long so concurrent instances skip it.
const DELIVERY_LEASE = '10 minutes';

/** Next run strictly after `from`: Mondays for weekly, the 1st for monthly, at 06:00 UTC. */
export function computeNextRunAt(cadence: ReportCadence, from: Date): Date {
  if (cadence === 'weekly') {
    const d = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), RUN_HOUR_UTC)
    );
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7)); // advance to Monday
    if (d <= from) d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1, RUN_HOUR_UTC));
  if (d <= from) d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/** The period a run at `runAt` reports on: the 7 days, or calendar month, before that day. */
export function reportingPeriod(cadence: ReportCadence, runAt: Date): { start: Date; end: Date } {
  const endExclusive = new Date(
    Date.UTC(runAt.getUTCFullYear(), runAt.getUTCMonth(), runAt.getUTCDate())
  );
  const start =
    cadence === 'weekly'
      ? new Date(endExclusive.getTime() - 7 * 24 * 60 * 60 * 1000)
      : new Date(Date.UTC(endExclusive.getUTCFullYear(), endExclusive.getUTCMonth() - 1, 1));
  return { start, end: new Date(endExclusive.getTime() - 1) };
}

/** Delay before retry number `attempts` + 1: 5m, 15m, 45m, 2h15m. */
export function retryDelayMs(attempts: number): number {
  return RETRY_BASE_MS * 3 ** Math.max(0, attempts - 1);
}

export function hashDownloadToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface DueSchedule {
  id: string;
  surety_id: string;
  cadence: ReportCadence;
  recipients: string[];
  next_run_at: Date;
}

/**
 * Generates the report for one due schedule and queues its deliveries, all in
 * one transaction with the schedule row locked, so a failed generation leaves
 * next_run_at untouched and the run is retried on the next pass.
 */
async function runSchedule(scheduleId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<DueSchedule>(
      `SELECT id, surety_id, cadence, recipients, next_run_at
       FROM compliance_report_schedules
       WHERE id = $1 AND is_paused = FALSE AND next_run_at <= now()
       FOR UPDATE SKIP LOCKED`,
      [scheduleId]
    );
    const schedule = locked.rows[0];
    if (!schedule) {
      await client.query('ROLLBACK');
      return false;
    }

    const { start, end } = reportingPeriod(schedule.cadence, new Date(schedule.next_run_at));
    const periodStart = start.toISOString().slice(0, 10);
    const periodEnd = end.toISOString().slice(0, 10);

    const reportData = await buildReportData(start, end);
    const pdfKey = await generateAndUploadPdf(
      reportData,
      schedule.surety_id,
      `scheduled/${schedule.id}/${periodStart}`
    );

    await client.query(
      `UPDATE compliance_reports SET superseded_at = now()
       WHERE schedule_id = $1 AND report_month = $2 AND superseded_at IS NULL`,
      [schedule.id, periodStart]
    );
    const report = await client.query<{ id: string }>(
      `INSERT INTO compliance_reports
         (surety_id, report_month, period_end, report_data, pdf_s3_key, schedule_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [schedule.surety_id, periodStart, periodEnd, JSON.stringify(reportData), pdfKey, schedule.id]
    );

    await client.query(
      `INSERT INTO compliance_report_deliveries (schedule_id, report_id, recipient)
       SELECT $1, $2, unnest($3::text[])`,
      [schedule.id, report.rows[0]!.id, schedule.recipients]
    );

    // Advance from now rather than from the missed slot so a long outage
    // produces one catch-up report, not a burst of them.
    await client.query(
      `UPDATE compliance_report_schedules
       SET next_run_at = $2, last_run_at = now(), last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [schedule.id, computeNextRunAt(schedule.cadence, new Date())]
    );

    await client.query('COMMIT');
    logger.info(
      { scheduleId: schedule.id, periodStart, periodEnd, recipients: schedule.recipients.length },
      'scheduled compliance report generated'
    );
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function runDueSchedules(): Promise<void> {
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM compliance_report_schedules
     WHERE is_paused = FALSE AND next_run_at <= now()
     ORDER BY next_run_at
     LIMIT 100`
  );

  for (const { id } of due.rows) {
    try {
      await runSchedule(id);
    } catch (err) {
      logger.error({ err, scheduleId: id }, 'scheduled compliance report generation failed');
      await pool
        .query(
          `UPDATE compliance_report_schedules SET last_error = $2, updated_at = now() WHERE id = $1`,
          [id, err instanceof Error ? err.message : String(err)]
        )
        .catch(() => undefined);
    }
  }
}

interface DueDelivery {
  id: string;
  recipient: string;
  attempts: number;
  schedule_id: string;
  surety_id: string;
  cadence: ReportCadence;
  report_month: string;
  period_end: string | null;
}

function buildReportEmail(delivery: DueDelivery, link: string, expiresAt: Date) {
  const period = `${delivery.report_month} to ${delivery.period_end ?? delivery.report_month}`;
  return {
    to: delivery.recipient,
    subject: `TariffShield ${delivery.cadence} compliance report (${period})`,
    text: [
      `Your scheduled ${delivery.cadence} TariffShield compliance report for ${period} is ready.`,
      '',
      `Download it here: ${link}`,
      '',
      `This link is unique to you and expires on ${expiresAt.toUTCString()}. Do not forward it.`,
    ].join('\n'),
  };
}

export async function processPendingDeliveries(): Promise<void> {
  const due = await pool.query<DueDelivery>(
    `UPDATE compliance_report_deliveries d
     SET next_attempt_at = now() + interval '${DELIVERY_LEASE}'
     FROM compliance_reports r, compliance_report_schedules s
     WHERE d.id IN (
             SELECT d2.id FROM compliance_report_deliveries d2
             JOIN compliance_report_schedules s2 ON s2.id = d2.schedule_id
             WHERE d2.status = 'pending' AND d2.next_attempt_at <= now() AND s2.is_paused = FALSE
             ORDER BY d2.next_attempt_at
             LIMIT 100
             FOR UPDATE OF d2 SKIP LOCKED
           )
       AND r.id = d.report_id
       AND s.id = d.schedule_id
     RETURNING d.id, d.recipient, d.attempts, d.schedule_id, s.surety_id, s.cadence,
               to_char(r.report_month, 'YYYY-MM-DD') AS report_month,
               to_char(r.period_end, 'YYYY-MM-DD') AS period_end`
  );

  for (const delivery of due.rows) {
    const attempts = delivery.attempts + 1;
    // A fresh token per attempt: only the hash is stored, so a retry cannot
    // resend a previously generated link.
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + DOWNLOAD_LINK_TTL_MS);
    const link = `${env.API_PUBLIC_URL.replace(/\/$/, '')}/compliance-report-links/${token}`;

    try {
      await pool.query(
        `UPDATE compliance_report_deliveries
         SET download_token_hash = $2, token_expires_at = $3
         WHERE id = $1`,
        [delivery.id, hashDownloadToken(token), expiresAt]
      );
      await sendEmail(buildReportEmail(delivery, link, expiresAt));
      await pool.query(
        `UPDATE compliance_report_deliveries
         SET status = 'sent', attempts = $2, sent_at = now(), last_error = NULL
         WHERE id = $1`,
        [delivery.id, attempts]
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
      await pool.query(
        `UPDATE compliance_report_deliveries
         SET status = $2, attempts = $3, last_error = $4, download_token_hash = NULL,
             token_expires_at = NULL, next_attempt_at = $5
         WHERE id = $1`,
        [
          delivery.id,
          exhausted ? 'failed' : 'pending',
          attempts,
          message,
          new Date(Date.now() + retryDelayMs(attempts)),
        ]
      );

      if (exhausted) {
        logger.error(
          { err, deliveryId: delivery.id, scheduleId: delivery.schedule_id, attempts },
          'scheduled compliance report delivery failed permanently'
        );
        await createNotification(
          delivery.surety_id,
          NOTIFICATION_KINDS.REPORT_DELIVERY_FAILED,
          `Scheduled compliance report for ${delivery.report_month} could not be emailed to ${delivery.recipient} after ${attempts} attempts.`
        ).catch(() => undefined);
      } else {
        logger.warn(
          { err, deliveryId: delivery.id, scheduleId: delivery.schedule_id, attempts },
          'scheduled compliance report delivery failed; will retry'
        );
      }
    }
  }
}

export function startScheduledComplianceReportDelivery(): void {
  const INTERVAL_MS = 15 * 60 * 1000;

  async function tick(): Promise<void> {
    try {
      await runDueSchedules();
      await processPendingDeliveries();
    } catch (err) {
      logger.error({ err }, 'scheduled compliance report pass failed');
    }
  }

  tick();
  setInterval(tick, INTERVAL_MS);
}
