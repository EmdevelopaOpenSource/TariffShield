import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db.js';
import { presignReportUrl } from '../jobs/compliance-report.js';
import { hashDownloadToken } from '../jobs/scheduled-compliance-reports.js';

// Issue #1013 — unauthenticated download links emailed by scheduled compliance
// report delivery. The token itself is the credential: 256 bits of randomness,
// one per recipient per delivery, stored only as a SHA-256 hash, and expiring
// after DOWNLOAD_LINK_TTL_MS. A valid link redirects to a short-lived
// pre-signed report URL.
export const complianceReportLinksRouter = Router();

complianceReportLinksRouter.use(
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false })
);

// GET /compliance-report-links/:token
complianceReportLinksRouter.get('/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token ?? '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    res.status(404).json({ error: 'download link not found or expired' });
    return;
  }

  const result = await pool.query<{ id: string; pdf_s3_key: string | null }>(
    `UPDATE compliance_report_deliveries d
     SET last_accessed_at = now()
     FROM compliance_reports r
     WHERE d.download_token_hash = $1
       AND d.status = 'sent'
       AND d.token_expires_at > now()
       AND r.id = d.report_id
     RETURNING d.id, r.pdf_s3_key`,
    [hashDownloadToken(token)]
  );
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: 'download link not found or expired' });
    return;
  }
  if (!row.pdf_s3_key) {
    res.status(404).json({ error: 'report PDF not available' });
    return;
  }

  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.redirect(302, presignReportUrl(row.pdf_s3_key));
});
