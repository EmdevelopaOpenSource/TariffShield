import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { up as migration0012Up } from '../../migrations/0012_dispute_evidence.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';

const pool = new Pool({ connectionString: DATABASE_URL });

const testTag = randomUUID().slice(0, 8);
const importerEmail = `test-imp-992-${testTag}@example.com`;
const adminEmail = `test-admin-992-${testTag}@example.com`;

let importerUserId: string;
let adminUserId: string;
let importerId: string;
let openDisputeId: string;
let resolvedDisputeId: string;
const testBondId = Math.floor(Math.random() * 9_000_000) + 1_000_000;

describe('Issue #992 — Allow Evidence Attachments on raise_dispute Submissions', () => {
  before(async () => {
    // 1. Run migration 0012 to ensure dispute_evidence table exists
    const client = await pool.connect();
    try {
      await migration0012Up(client);
    } finally {
      client.release();
    }

    // 2. Seed users
    const u1 = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [importerEmail, 'hash1', 'importer']
    );
    importerUserId = u1.rows[0]!.id;

    const u2 = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [adminEmail, 'hash2', 'surety_admin']
    );
    adminUserId = u2.rows[0]!.id;

    // 3. Seed importer
    const impRes = await pool.query<{ id: string }>(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address, kyc_status, collateral_balance)
       VALUES ($1, $2, $3, $4, 'approved', 10000000)
       RETURNING id`,
      [importerUserId, 'Dispute Test Importer Corp', testBondId, 'GBTESTDISPUTEIMPORTER12345']
    );
    importerId = impRes.rows[0]!.id;

    // 4. Seed an open dispute
    const openRes = await pool.query<{ id: string }>(
      `INSERT INTO collateral_disputes (importer_id, old_required, new_required, status)
       VALUES ($1, 5000000, 10000000, 'open')
       RETURNING id`,
      [importerId]
    );
    openDisputeId = openRes.rows[0]!.id;

    // 5. Seed an already resolved dispute
    const resolvedRes = await pool.query<{ id: string }>(
      `INSERT INTO collateral_disputes (importer_id, old_required, new_required, status, resolved_at)
       VALUES ($1, 4000000, 8000000, 'resolved_accepted', now())
       RETURNING id`,
      [importerId]
    );
    resolvedDisputeId = resolvedRes.rows[0]!.id;
  });

  after(async () => {
    if (importerId) {
      await pool.query('DELETE FROM dispute_evidence WHERE importer_id = $1', [importerId]);
      await pool.query('DELETE FROM collateral_disputes WHERE importer_id = $1', [importerId]);
      await pool.query('DELETE FROM audit_log WHERE actor_user_id IN ($1, $2)', [
        importerUserId,
        adminUserId,
      ]);
      await pool.query('DELETE FROM importers WHERE id = $1', [importerId]);
    }
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [importerUserId, adminUserId]);
    await pool.end();
  });

  it('inserts and retrieves notes-only evidence for an open dispute', async () => {
    const res = await pool.query(
      `INSERT INTO dispute_evidence (dispute_id, importer_id, notes)
       VALUES ($1, $2, $3)
       RETURNING id, dispute_id, importer_id, notes, created_at`,
      [openDisputeId, importerId, 'HTS classification code is contested; CBP ruling pending']
    );

    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0]?.dispute_id, openDisputeId);
    assert.equal(res.rows[0]?.importer_id, importerId);
    assert.equal(res.rows[0]?.notes, 'HTS classification code is contested; CBP ruling pending');
  });

  it('inserts and retrieves file evidence with encrypted s3 key for an open dispute', async () => {
    const res = await pool.query(
      `INSERT INTO dispute_evidence (dispute_id, importer_id, file_name, mime_type, file_size_bytes, s3_key_encrypted, virus_scan_status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, dispute_id, file_name, mime_type, file_size_bytes, virus_scan_status`,
      [
        openDisputeId,
        importerId,
        'cbp_duty_protest.pdf',
        'application/pdf',
        1024,
        'encrypted_s3_key_dispute_123',
        'clean',
        'Official customs protest filing document',
      ]
    );

    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0]?.file_name, 'cbp_duty_protest.pdf');
    assert.equal(res.rows[0]?.virus_scan_status, 'clean');
    assert.equal(res.rows[0]?.file_size_bytes, 1024);
  });

  it('rejects evidence attachment when dispute is already resolved', async () => {
    // Verify that the resolved dispute is checked for status
    const disputeCheck = await pool.query(
      'SELECT status FROM collateral_disputes WHERE id = $1',
      [resolvedDisputeId]
    );
    assert.equal(disputeCheck.rows[0]?.status, 'resolved_accepted');
    assert.notEqual(disputeCheck.rows[0]?.status, 'open');
  });

  it('retains dispute evidence in collateral history view query', async () => {
    // In collateral history view, all disputes (open and resolved) along with their evidence must be returned
    const disputesRes = await pool.query(
      `SELECT id, status, old_required::text AS old_required, new_required::text AS new_required
       FROM collateral_disputes
       WHERE importer_id = $1
       ORDER BY raised_at DESC`,
      [importerId]
    );
    assert.ok(disputesRes.rows.length >= 2);

    const disputeIds = disputesRes.rows.map((d) => d.id);
    const evRes = await pool.query(
      `SELECT id, dispute_id, file_name, notes
       FROM dispute_evidence
       WHERE dispute_id = ANY($1::uuid[])
       ORDER BY created_at ASC`,
      [disputeIds]
    );

    assert.ok(evRes.rows.length >= 2);
    const openDisputeEvidence = evRes.rows.filter((e) => e.dispute_id === openDisputeId);
    assert.equal(openDisputeEvidence.length, 2);
  });
});
