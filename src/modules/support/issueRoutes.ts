import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { getEnv } from '@/config';
import { createAppError } from '@/middleware/errorHandler';
import { authenticate } from '@/middleware/auth';
import { sendIssueReportEmail, sendIssueResolvedEmail } from '@/utils/email';

const router = Router();

// Every route here needs a signed-in user of some kind, but deliberately no
// requireRole — reporting a problem is the one thing every role can do,
// including customers.
router.use(authenticate);

const createSchema = z.object({
  category: z.enum(['bug', 'wrong_data', 'cannot_do_my_job', 'suggestion', 'account_access', 'other']),
  severity: z.enum(['low', 'normal', 'high', 'blocking']).default('normal'),
  subject: z.string().min(3).max(200),
  body: z.string().min(10).max(4000),
  /** Whatever the app knows: screen name, app version, platform. */
  context: z.record(z.any()).optional(),
});

const updateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']),
  resolution: z.string().max(2000).optional(),
  /** Org admin handing a report they cannot fix to the platform team. */
  escalate: z.boolean().optional(),
  escalation_note: z.string().max(1000).optional(),
});

/** Human-quotable reference: CW-8F3A2B. */
function makeReference(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return `CW-${out}`;
}

/**
 * Look up who is reporting. The actor could be staff, a platform admin or a
 * customer, and each lives in its own table — so this resolves a display name
 * and location once rather than every caller re-deriving it.
 */
async function resolveReporter(pool: any, actor: any) {
  if (actor.type === 'platform') {
    const r = await pool.query('SELECT full_name, email FROM platform_admins WHERE id = $1', [actor.sub]);
    return {
      name: r.rows[0]?.full_name || 'Platform admin',
      email: r.rows[0]?.email || null,
      role: 'sysadmin',
      orgId: null as string | null,
      branchId: null as string | null,
      orgName: null as string | null,
      branchName: null as string | null,
    };
  }

  if (actor.type === 'client') {
    const r = await pool.query(
      `SELECT c.full_name, c.email, c.org_id, o.name AS org_name
       FROM clients c JOIN organizations o ON o.id = c.org_id WHERE c.id = $1`,
      [actor.sub]
    );
    return {
      name: r.rows[0]?.full_name || 'Customer',
      email: r.rows[0]?.email || null,
      role: 'client',
      orgId: r.rows[0]?.org_id || null,
      branchId: null,
      orgName: r.rows[0]?.org_name || null,
      branchName: null,
    };
  }

  const r = await pool.query(
    `SELECT s.full_name, s.email, s.role, s.org_id, s.branch_id,
            o.name AS org_name, b.name AS branch_name
     FROM staff_users s
     JOIN organizations o ON o.id = s.org_id
     LEFT JOIN branches b ON b.id = s.branch_id
     WHERE s.id = $1`,
    [actor.sub]
  );
  const row = r.rows[0];
  return {
    name: row?.full_name || 'Staff',
    email: row?.email || null,
    role: row?.role || actor.role || null,
    orgId: row?.org_id || null,
    branchId: row?.branch_id || null,
    orgName: row?.org_name || null,
    branchName: row?.branch_name || null,
  };
}

/**
 * POST /issues — report a problem. Any signed-in user.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createSchema.parse(req.body);
    const pool = getPool();
    const actor = req.actor!;
    const who = await resolveReporter(pool, actor);
    const reference = makeReference();

    const inserted = await pool.query(
      `INSERT INTO issue_reports
         (reference, reporter_type, reporter_id, reporter_name, reporter_role,
          reporter_email, org_id, branch_id, category, severity, subject, body, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, reference, created_at`,
      [
        reference, actor.type, actor.sub, who.name, who.role, who.email,
        who.orgId, who.branchId, data.category, data.severity,
        data.subject, data.body, data.context ? JSON.stringify(data.context) : null,
      ]
    );
    const saved = inserted.rows[0];

    // The report is already stored. Emailing is best-effort on top of that:
    // a failure is recorded on the row rather than thrown, so a broken mail
    // server never costs the user their report or shows them an error for
    // something that did in fact save.
    const supportTo = getEnv().SUPPORT_EMAIL;
    if (supportTo) {
      try {
        await sendIssueReportEmail(supportTo, {
          reference,
          subject: data.subject,
          body: data.body,
          category: data.category,
          severity: data.severity,
          reporter_name: who.name,
          reporter_role: who.role,
          org_name: who.orgName,
          branch_name: who.branchName,
          context: data.context || null,
        });
        await pool.query('UPDATE issue_reports SET emailed_at = now() WHERE id = $1', [saved.id]);
      } catch (mailErr: any) {
        await pool.query(
          'UPDATE issue_reports SET email_error = $1 WHERE id = $2',
          [String(mailErr?.message || mailErr).slice(0, 500), saved.id]
        );
      }
    }

    res.status(201).json({
      ok: true,
      data: {
        id: saved.id,
        reference: saved.reference,
        created_at: saved.created_at,
        message: 'Thanks — your report has been sent.',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /issues — what the caller is allowed to see.
 *
 *   sysadmin  → every report on the platform
 *   orgadmin  → every report from their own organisation
 *   everyone else → only their own reports
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const actor = req.actor!;
    const status = req.query.status as string | undefined;

    const params: any[] = [];
    let scope: string;

    if (actor.type === 'platform') {
      scope = '1=1';
    } else if (actor.type === 'staff' && actor.role === 'orgadmin') {
      params.push(actor.org_id);
      scope = `r.org_id = $${params.length}`;
    } else {
      params.push(actor.type, actor.sub);
      scope = `r.reporter_type = $${params.length - 1} AND r.reporter_id = $${params.length}`;
    }

    let statusClause = '';
    if (status && ['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
      params.push(status);
      statusClause = ` AND r.status = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT r.id, r.reference, r.category, r.severity, r.subject, r.body,
              r.status, r.resolution, r.resolved_at, r.created_at,
              r.reporter_name, r.reporter_role, r.reporter_email,
              r.emailed_at, r.email_error,
              r.escalated_at, r.escalation_note, r.resolved_by_type,
              r.resolved_notified_at, r.resolved_notify_error,
              o.name AS org_name, b.name AS branch_name
       FROM issue_reports r
       LEFT JOIN organizations o ON o.id = r.org_id
       LEFT JOIN branches b ON b.id = r.branch_id
       WHERE ${scope}${statusClause}
       ORDER BY
         CASE r.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
         -- An org admin has already looked at an escalated report and could
         -- not fix it, so it outranks an untouched one of the same severity.
         CASE WHEN r.escalated_at IS NOT NULL THEN 0 ELSE 1 END,
         CASE r.severity WHEN 'blocking' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         r.created_at DESC
       LIMIT 200`,
      params
    );

    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /issues/:id — triage.
 *
 * Two tiers. An org admin handles reports from their own organisation, which
 * is most of them — a wrong price or a branch setting is theirs to fix and
 * should not queue behind the platform team. What they cannot fix, they
 * escalate. A platform admin can act on anything.
 */
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = req.actor!;
    const isPlatform = actor.type === 'platform';
    const isOrgAdmin = actor.type === 'staff' && actor.role === 'orgadmin';

    if (!isPlatform && !isOrgAdmin) {
      next(createAppError(403, 'FORBIDDEN', 'Only an org admin or platform admin can update a report'));
      return;
    }

    const data = updateSchema.parse(req.body);
    const pool = getPool();
    const id = String(req.params.id);

    // Load first: an org admin may only touch their own organisation's
    // reports, and the reporter's address is needed to notify them.
    const existing = await pool.query(
      `SELECT id, reference, subject, org_id, status, reporter_email, escalated_at
       FROM issue_reports WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Report not found'));
      return;
    }
    const report = existing.rows[0];

    if (isOrgAdmin && report.org_id !== actor.org_id) {
      next(createAppError(403, 'FORBIDDEN', 'That report belongs to another organisation'));
      return;
    }

    // Escalating hands a report to the platform team. Only an org admin does
    // this — there is no higher tier for a platform admin to pass it to.
    const escalating = data.escalate === true && isOrgAdmin;
    if (data.escalate === true && isPlatform) {
      next(createAppError(400, 'ALREADY_TOP_TIER', 'A platform admin is already the escalation point'));
      return;
    }

    const done = data.status === 'resolved' || data.status === 'closed';

    const result = await pool.query(
      `UPDATE issue_reports
       SET status = $1,
           resolution = COALESCE($2, resolution),
           resolved_by = CASE WHEN $3::boolean THEN $4 ELSE resolved_by END,
           resolved_by_type = CASE WHEN $3::boolean THEN $5 ELSE resolved_by_type END,
           resolved_at = CASE WHEN $3::boolean THEN now() ELSE NULL END,
           escalated_at = CASE WHEN $6::boolean THEN now() ELSE escalated_at END,
           escalated_by = CASE WHEN $6::boolean THEN $4 ELSE escalated_by END,
           escalation_note = CASE WHEN $6::boolean THEN COALESCE($7, escalation_note) ELSE escalation_note END,
           updated_at = now()
       WHERE id = $8
       RETURNING id, reference, subject, status, resolution, resolved_at,
                 resolved_by_type, escalated_at, escalation_note, reporter_email`,
      [
        data.status,
        data.resolution ?? null,
        done,
        actor.sub,
        isPlatform ? 'platform' : 'staff',
        escalating,
        data.escalation_note ?? null,
        id,
      ]
    );

    const updated = result.rows[0];

    // Tell the reporter their problem was dealt with. Best-effort and after
    // the update: the status change is already committed, so a mail failure
    // is recorded on the row rather than failing the request.
    let notified = false;
    const justResolved = done && report.status !== data.status;
    if (justResolved && updated.reporter_email) {
      try {
        const nameRow = isPlatform
          ? await pool.query('SELECT full_name FROM platform_admins WHERE id = $1', [actor.sub])
          : await pool.query('SELECT full_name FROM staff_users WHERE id = $1', [actor.sub]);
        await sendIssueResolvedEmail(updated.reporter_email, {
          reference: updated.reference,
          subject: updated.subject,
          status: updated.status,
          resolution: updated.resolution,
          resolved_by_name: nameRow.rows[0]?.full_name || null,
        });
        await pool.query('UPDATE issue_reports SET resolved_notified_at = now() WHERE id = $1', [id]);
        notified = true;
      } catch (mailErr: any) {
        await pool.query(
          'UPDATE issue_reports SET resolved_notify_error = $1 WHERE id = $2',
          [String(mailErr?.message || mailErr).slice(0, 500), id]
        );
      }
    }

    res.json({ ok: true, data: { ...updated, reporter_notified: notified } });
  } catch (err) {
    next(err);
  }
});

export default router;
