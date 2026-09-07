import type { Knex } from 'knex';

/**
 * Issue reports — in-app support, available to every role.
 *
 * Anyone signed in (worker, manager, org admin, sysadmin, or a customer) can
 * raise a problem from inside the app, and it lands somewhere a human will
 * actually see it rather than being lost to a phone call.
 *
 * reporter_id is deliberately NOT a foreign key: the reporter can be a row in
 * staff_users, platform_admins or clients, and a single FK cannot point at
 * three tables. reporter_type says which one to look in — the same pattern
 * audit_logs and refresh_tokens already use here.
 *
 * org_id and branch_id are captured at submission time rather than resolved
 * later from the reporter, so a report still says where it came from after
 * the person moves branch or leaves.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE issue_reports (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reference     TEXT NOT NULL,

      reporter_type TEXT NOT NULL,
      reporter_id   UUID NOT NULL,
      reporter_name TEXT NOT NULL,
      reporter_role TEXT,

      org_id        UUID REFERENCES organizations(id),
      branch_id     UUID REFERENCES branches(id),

      category      TEXT NOT NULL,
      severity      TEXT NOT NULL DEFAULT 'normal',
      subject       TEXT NOT NULL,
      body          TEXT NOT NULL,

      -- What the app knew at the time. A report saying "it crashed" is far
      -- more useful with the screen and app version attached, and the user
      -- should not have to know or type any of it.
      context       JSONB,

      status        TEXT NOT NULL DEFAULT 'open',
      resolution    TEXT,
      resolved_by   UUID,
      resolved_at   TIMESTAMPTZ,

      -- Whether the notification email actually went out, so a report is
      -- never silently stranded when SMTP is misconfigured.
      emailed_at    TIMESTAMPTZ,
      email_error   TEXT,

      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT issue_reports_reporter_type_chk
        CHECK (reporter_type IN ('staff', 'platform', 'client')),
      CONSTRAINT issue_reports_category_chk
        CHECK (category IN ('bug', 'wrong_data', 'cannot_do_my_job', 'suggestion', 'account_access', 'other')),
      CONSTRAINT issue_reports_severity_chk
        CHECK (severity IN ('low', 'normal', 'high', 'blocking')),
      CONSTRAINT issue_reports_status_chk
        CHECK (status IN ('open', 'in_progress', 'resolved', 'closed'))
    )
  `);

  await knex.raw(`CREATE UNIQUE INDEX issue_reports_reference_idx ON issue_reports (reference)`);
  // The two lists that actually get read: a sysadmin triaging everything, and
  // an org admin seeing only their own organisation's reports.
  await knex.raw(`CREATE INDEX issue_reports_status_idx ON issue_reports (status, created_at DESC)`);
  await knex.raw(`CREATE INDEX issue_reports_org_idx ON issue_reports (org_id, created_at DESC)`);
  await knex.raw(`CREATE INDEX issue_reports_reporter_idx ON issue_reports (reporter_type, reporter_id)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS issue_reports`);
}
