// #1007 — importer credit-line pre-approvals.
//
// A credit line is a surety-admin granted, time-boxed amount that temporarily
// covers a collateral shortfall off-chain while the on-chain deposit is still
// pending (deposit_collateral in the contract remains the system of record —
// see contracts/tariff-shield/src/lib.rs). Collateral health checks consult
// the active credit lines through `evaluateCollateralHealth`, expiry is
// enforced by `expireDueCreditLines` (hourly job), and every grant/revoke/
// expiry lands in the audit trail via logAudit.
import { pool, logAudit, createNotification } from '../db.js';
import { NOTIFICATION_KINDS } from '../constants/notification-kinds.js';
import { logger } from '../lib/logger.js';

export type CreditLineStatus = 'active' | 'expired' | 'revoked';

export interface CreditLine {
  id: string;
  importer_id: string;
  importer_legal_name?: string;
  granted_by: string | null;
  amount: string;
  reason: string | null;
  status: CreditLineStatus;
  granted_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  notified_expiring: boolean;
  created_at: string;
}

export interface CollateralHealth {
  /** On-chain collateral balance, in stroops. */
  balance: string;
  /** Required collateral currently in force, in stroops. */
  requiredCollateral: string;
  /** max(0, required - balance), in stroops. */
  shortfall: string;
  /** Sum of still-active credit lines, in stroops. */
  creditLineTotal: string;
  /** Credit-line amount left after covering the shortfall, in stroops. */
  creditLineRemaining: string;
  /**
   * healthy              — balance meets requirement without help;
   * covered_by_credit_line — shortfall exists but active credit lines cover it;
   * shortfall             — uncovered shortfall remains (strict requirements).
   */
  status: 'healthy' | 'covered_by_credit_line' | 'shortfall';
  creditLines: CreditLine[];
}

const CREDIT_LINE_COLUMNS = `id, importer_id, granted_by, amount::text AS amount, reason, status,
  granted_at, expires_at, revoked_at, revoked_by, notified_expiring, created_at`;

/** Active credit lines for an importer — only unexpired, unrevoked rows. */
export async function getActiveCreditLines(importerId: string): Promise<CreditLine[]> {
  const result = await pool.query(
    `SELECT ${CREDIT_LINE_COLUMNS}
     FROM credit_lines
     WHERE importer_id = $1 AND status = 'active' AND expires_at > now()
     ORDER BY expires_at ASC`,
    [importerId]
  );
  return result.rows as CreditLine[];
}

/**
 * Collateral health check that treats active credit lines as temporary
 * coverage of any shortfall (#1007 AC: "collateral health checks treat the
 * credit line as temporary coverage"). Pure function so routes and tests can
 * pass in balances directly.
 */
export function evaluateCollateralHealth(input: {
  balance: bigint;
  requiredCollateral: bigint;
  creditLines: CreditLine[];
}): CollateralHealth {
  const shortfall =
    input.requiredCollateral > input.balance ? input.requiredCollateral - input.balance : 0n;
  let creditLineTotal = 0n;
  for (const line of input.creditLines) {
    try {
      creditLineTotal += BigInt(line.amount);
    } catch {
      // Malformed amount rows are skipped rather than failing the check.
    }
  }
  const covered = shortfall > 0n && shortfall <= creditLineTotal;
  const status =
    shortfall === 0n ? 'healthy' : covered ? 'covered_by_credit_line' : 'shortfall';

  return {
    balance: input.balance.toString(),
    requiredCollateral: input.requiredCollateral.toString(),
    shortfall: shortfall.toString(),
    creditLineTotal: creditLineTotal.toString(),
    creditLineRemaining:
      (creditLineTotal > shortfall ? creditLineTotal - shortfall : 0n).toString(),
    status,
    creditLines: input.creditLines,
  };
}

async function importerUserId(importerId: string): Promise<string | null> {
  const result = await pool.query('SELECT user_id FROM importers WHERE id = $1', [importerId]);
  return result.rows[0]?.user_id ?? null;
}

/**
 * Marks every active credit line whose window has passed as `expired` and
 * notifies the importer — after expiry, collateral health checks fall back to
 * the strict (credit-line-free) requirement automatically because
 * `getActiveCreditLines` filters on `expires_at > now()`.
 */
export async function expireDueCreditLines(): Promise<number> {
  const expired = await pool.query(
    `UPDATE credit_lines
        SET status = 'expired'
      WHERE status = 'active' AND expires_at <= now()
      RETURNING id, importer_id, amount::text AS amount`,
    []
  );

  for (const row of expired.rows) {
    const userId = await importerUserId(row.importer_id);
    if (userId) {
      await createNotification(
        userId,
        NOTIFICATION_KINDS.CREDIT_LINE_EXPIRED,
        `Your credit line of ${row.amount} stroops has expired. Collateral requirements are strictly enforced again until the shortfall is deposited.`
      );
    }
    await logAudit(null, 'credit_line_expired', row.id, {
      importerId: row.importer_id,
      amount: row.amount,
    });
  }

  if (expired.rowCount && expired.rowCount > 0) {
    logger.info({ count: expired.rowCount }, 'credit lines expired');
  }
  return expired.rowCount ?? 0;
}

/**
 * One-time pre-expiry warning (48h lead by default) so importers are notified
 * before the credit line disappears (#1007 AC). Deduplicated via the
 * `notified_expiring` flag.
 */
export async function notifyExpiringCreditLines(
  leadMs: number = 48 * 60 * 60 * 1000
): Promise<number> {
  const due = await pool.query(
    `UPDATE credit_lines
        SET notified_expiring = TRUE
      WHERE status = 'active'
        AND notified_expiring = FALSE
        AND expires_at > now()
        AND expires_at <= now() + make_interval(secs => $1::double precision)
      RETURNING id, importer_id, amount::text AS amount, expires_at`,
    [Math.floor(leadMs / 1000)]
  );

  for (const row of due.rows) {
    const userId = await importerUserId(row.importer_id);
    if (userId) {
      await createNotification(
        userId,
        NOTIFICATION_KINDS.CREDIT_LINE_EXPIRING_SOON,
        `Your credit line of ${row.amount} stroops expires at ${new Date(row.expires_at).toISOString()}. Deposit collateral before then to avoid losing the temporary coverage.`
      );
    }
  }

  if (due.rowCount && due.rowCount > 0) {
    logger.info({ count: due.rowCount }, 'credit line pre-expiry notifications sent');
  }
  return due.rowCount ?? 0;
}
