import type { Knex } from 'knex';

/**
 * Two-tier issue handling.
 *
 * Most reports from a worker are their own organisation's to fix — a wrong
 * price, a customer who cannot be found, a branch setting. Those should never
 * have to wait on the platform team. What genuinely needs the platform team
 * is a bug in the software itself, so an org admin can hand one over rather
 * than sitting on something they cannot fix.
 *
 * `escalated_at` marks that hand-off. `resolved_by_type` records which tier
 * closed it, since resolved_by alone is ambiguous across two admin tables.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE issue_reports
      ADD COLUMN escalated_at      TIMESTAMPTZ,
      ADD COLUMN escalated_by      UUID,
      ADD COLUMN escalation_note   TEXT,
      -- 'staff' (org admin) or 'platform' (sysadmin). resolved_by points at
      -- one of two different tables, so the id alone cannot say which.
      ADD COLUMN resolved_by_type  TEXT,
      -- Captured at submission: a reporter can change their address, or the
      -- account can be deleted, and the notification should still have gone
      -- to wherever they actually were at the time.
      ADD COLUMN reporter_email    TEXT,
      -- Mirrors emailed_at/email_error, but for telling the REPORTER their
      -- issue was resolved rather than telling support it arrived.
      ADD COLUMN resolved_notified_at TIMESTAMPTZ,
      ADD COLUMN resolved_notify_error TEXT
  `);

  await knex.raw(`
    ALTER TABLE issue_reports
      ADD CONSTRAINT issue_reports_resolved_by_type_chk
      CHECK (resolved_by_type IS NULL OR resolved_by_type IN ('staff', 'platform'))
  `);

  // The platform team's queue: escalated reports, newest first.
  await knex.raw(`
    CREATE INDEX issue_reports_escalated_idx
      ON issue_reports (escalated_at DESC) WHERE escalated_at IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS issue_reports_escalated_idx`);
  await knex.raw(`ALTER TABLE issue_reports DROP CONSTRAINT IF EXISTS issue_reports_resolved_by_type_chk`);
  await knex.raw(`
    ALTER TABLE issue_reports
      DROP COLUMN IF EXISTS escalated_at,
      DROP COLUMN IF EXISTS escalated_by,
      DROP COLUMN IF EXISTS escalation_note,
      DROP COLUMN IF EXISTS resolved_by_type,
      DROP COLUMN IF EXISTS reporter_email,
      DROP COLUMN IF EXISTS resolved_notified_at,
      DROP COLUMN IF EXISTS resolved_notify_error
  `);
}
