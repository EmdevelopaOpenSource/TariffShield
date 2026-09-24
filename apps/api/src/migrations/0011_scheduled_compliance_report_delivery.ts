import type { PoolClient } from 'pg';

// ── #1013: Scheduled Automated Delivery of Compliance Reports ───────────────
export const up = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS compliance_report_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      surety_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_type TEXT NOT NULL CHECK (report_type IN ('compliance_summary')),
      cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
      recipients TEXT[] NOT NULL CHECK (cardinality(recipients) > 0),
      is_paused BOOLEAN NOT NULL DEFAULT FALSE,
      next_run_at TIMESTAMPTZ NOT NULL,
      last_run_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_compliance_report_schedules_surety
      ON compliance_report_schedules(surety_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compliance_report_schedules_due
      ON compliance_report_schedules(next_run_at) WHERE is_paused = FALSE;
  `);

  // Scheduled runs produce one report per reporting period (weekly periods can
  // share a calendar month), so (surety_id, report_month) can no longer be
  // globally unique. Uniqueness is kept per source: one live monthly-job
  // report per surety+month, and one live report per schedule+period.
  await client.query(`
    ALTER TABLE compliance_reports
      DROP CONSTRAINT IF EXISTS compliance_reports_surety_id_report_month_key;
    ALTER TABLE compliance_reports
      ADD COLUMN IF NOT EXISTS schedule_id UUID
        REFERENCES compliance_report_schedules(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS period_end DATE;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_reports_monthly_live
      ON compliance_reports(surety_id, report_month)
      WHERE schedule_id IS NULL AND superseded_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_reports_schedule_period
      ON compliance_reports(schedule_id, report_month)
      WHERE schedule_id IS NOT NULL AND superseded_at IS NULL;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS compliance_report_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      schedule_id UUID NOT NULL REFERENCES compliance_report_schedules(id) ON DELETE CASCADE,
      report_id UUID NOT NULL REFERENCES compliance_reports(id) ON DELETE CASCADE,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- SHA-256 of the one-time download token emailed to the recipient; the
      -- raw token is never stored.
      download_token_hash TEXT UNIQUE,
      token_expires_at TIMESTAMPTZ,
      last_accessed_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_compliance_report_deliveries_pending
      ON compliance_report_deliveries(next_attempt_at) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_compliance_report_deliveries_schedule
      ON compliance_report_deliveries(schedule_id, created_at DESC);
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS compliance_report_deliveries CASCADE;
    DELETE FROM compliance_reports WHERE schedule_id IS NOT NULL;
    DROP INDEX IF EXISTS uq_compliance_reports_schedule_period;
    DROP INDEX IF EXISTS uq_compliance_reports_monthly_live;
    ALTER TABLE compliance_reports DROP COLUMN IF EXISTS period_end;
    ALTER TABLE compliance_reports DROP COLUMN IF EXISTS schedule_id;
    DROP TABLE IF EXISTS compliance_report_schedules CASCADE;
    -- Superseded monthly reports that now share a month with a live one would
    -- violate the restored constraint.
    DELETE FROM compliance_reports old
      USING compliance_reports live
      WHERE old.surety_id = live.surety_id
        AND old.report_month = live.report_month
        AND old.superseded_at IS NOT NULL
        AND live.superseded_at IS NULL;
    ALTER TABLE compliance_reports
      ADD CONSTRAINT compliance_reports_surety_id_report_month_key UNIQUE (surety_id, report_month);
  `);
};
