import { Router, Request, Response, NextFunction } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { authenticate } from '@/middleware/auth';
import { requirePlatform } from '@/middleware/requirePlatform';
import { generateTempPassword } from '@/utils/tempPassword';
import { sendStaffTempPasswordEmail } from '@/utils/email';

const router = Router();

/**
 * Email a new admin their temporary password.
 *
 * Never throws: the account has already been created by the time this runs,
 * so a mail failure must not turn a successful creation into an error. The
 * caller reports whether it went out, and the password stays in the response
 * either way so the sysadmin can always fall back to reading it out.
 */
async function tryEmailTempPassword(
  email: string,
  fullName: string,
  username: string,
  tempPassword: string,
  reason: 'created' | 'reset'
): Promise<boolean> {
  try {
    await sendStaffTempPasswordEmail(email, fullName, username, tempPassword, reason);
    return true;
  } catch (err) {
    console.error(`[email] temp password to ${email} failed:`, err);
    return false;
  }
}

// All routes require platform auth
router.use(authenticate, requirePlatform);

// Validation schemas
const createOrgSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).max(50),
  phone: z.string().optional(),
  contact_name: z.string().optional(),
  admin_name: z.string().min(1),
  admin_email: z.string().email(),
  admin_phone: z.string().optional(),
});

const updateOrgSchema = z.object({
  name: z.string().min(1).optional(),
  contact_name: z.string().optional(),
  plan: z.string().optional(),
});

const suspendOrgSchema = z.object({
  reason: z.string().min(1),
});

const planSchema = z.object({
  code: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/, 'Code must be lowercase letters, numbers, _ or -'),
  name: z.string().min(1),
  price_ugx: z.number().int().min(0),
  billing_cycle: z.enum(['monthly', 'quarterly', 'yearly']).default('monthly'),
  max_branches: z.number().int().min(1).nullable().optional(),
  description: z.string().optional(),
  sort_order: z.number().int().optional(),
});

const updatePlanSchema = z.object({
  name: z.string().min(1).optional(),
  price_ugx: z.number().int().min(0).optional(),
  billing_cycle: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
  max_branches: z.number().int().min(1).nullable().optional(),
  description: z.string().optional(),
  sort_order: z.number().int().optional(),
  active: z.boolean().optional(),
});

const subscriptionSchema = z.object({
  plan_id: z.string().uuid().nullable().optional(),
  billing_status: z.enum(['trial', 'active', 'past_due', 'cancelled']).optional(),
  trial_ends_at: z.string().nullable().optional(),
  next_due_at: z.string().nullable().optional(),
  billing_notes: z.string().nullable().optional(),
});

const paymentSchema = z.object({
  amount_ugx: z.number().int().positive(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(['cash', 'mobile_money', 'bank_transfer', 'card', 'other']).default('cash'),
  reference: z.string().optional(),
  note: z.string().optional(),
  // Roll next_due_at forward to period_end. On by default because recording a
  // payment without advancing the due date leaves the org showing as overdue.
  advance_due_date: z.boolean().default(true),
});

const addAdminSchema = z.object({
  full_name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
});

// Platform admins sign in with a username. It is optional on the wire: when
// omitted we derive it from the email's local part, matching how orgadmin
// usernames are generated.
const addPlatformAdminSchema = addAdminSchema.extend({
  username: z
    .string()
    .min(3)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Username may only contain letters, numbers, dot, underscore or hyphen')
    .optional(),
});

/**
 * GET /platform/orgs
 * List all organizations with counts
 */
router.get('/orgs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    // Each org row carries three different things a platform admin weighs
    // together: how big the tenant is, how much business it is doing on the
    // software, and whether it is paying for it. days_to_due is signed —
    // negative means overdue — so the client sorts and colours off one number.
    const result = await pool.query(`
      SELECT 
        o.id, o.name, o.slug, o.phone, o.contact_name, o.plan, o.status, o.created_at,
        o.billing_status, o.onboarded_at, o.trial_ends_at::date AS trial_ends_at, o.next_due_at::date AS next_due_at, o.billing_notes,
        p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
        p.price_ugx AS plan_price_ugx, p.billing_cycle, p.max_branches,
        (SELECT COUNT(*) FROM branches WHERE org_id = o.id) as branch_count,
        (SELECT COUNT(*) FROM staff_users WHERE org_id = o.id AND status = 'active') as staff_count,
        (SELECT COUNT(*) FROM clients WHERE org_id = o.id) as client_count,
        (SELECT COUNT(*) FROM washes w
           WHERE w.org_id = o.id AND w.status = 'settled'
             AND w.started_at >= date_trunc('month', now())) AS washes_this_month,
        (SELECT COALESCE(SUM(w.amount_ugx), 0) FROM washes w
           WHERE w.org_id = o.id AND w.status = 'settled'
             AND w.started_at >= date_trunc('month', now())) AS gross_this_month,
        (SELECT MAX(w.started_at) FROM washes w WHERE w.org_id = o.id) AS last_activity_at,
        (SELECT COALESCE(SUM(pay.amount_ugx), 0) FROM org_payments pay WHERE pay.org_id = o.id) AS paid_total_ugx,
        (SELECT MAX(pay.created_at) FROM org_payments pay WHERE pay.org_id = o.id) AS last_paid_at,
        CASE WHEN o.next_due_at IS NULL THEN NULL
             ELSE (o.next_due_at::date - (now() AT TIME ZONE 'UTC')::date)
        END AS days_to_due
      FROM organizations o
      LEFT JOIN subscription_plans p ON p.id = o.plan_id
      ORDER BY o.created_at DESC
    `);

    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/orgs
 * Create organization, its first orgadmin, and return temp password
 */
router.post('/orgs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createOrgSchema.parse(req.body);
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Create org
      const orgResult = await client.query(
        `INSERT INTO organizations (name, slug, phone, contact_name, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [data.name, data.slug, data.phone || null, data.contact_name || null, req.actor!.sub]
      );
      const orgId = orgResult.rows[0].id;

      // Generate temp password for orgadmin
      const tempPassword = generateTempPassword();
      const passwordHash = await argon2.hash(tempPassword);

      // Create orgadmin (no branch_id, as per constraint).
      // created_by is NULL: it references staff_users(id), and the creator here
      // is a platform admin, which is a different table. The platform actor is
      // recorded in the audit_logs row below instead.
      const adminResult = await client.query(
        `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by)
         VALUES ($1, NULL, 'orgadmin', $2, $3, $4, $5, true, NULL) RETURNING id`,
        [orgId, data.admin_name, data.admin_email.split('@')[0], data.admin_email, passwordHash]
      );

      // Audit log
      await client.query(
        `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
         VALUES ($1, 'platform', $2, 'org.created', 'organization', $3, $4)`,
        [orgId, req.actor!.sub, orgId, JSON.stringify({ name: data.name, slug: data.slug })]
      );

      await client.query('COMMIT');

      // Email the credentials to the new admin. staffRoutes has always done
      // this for staff it creates; the platform routes did not, so an org
      // admin created here only ever learned their password if the sysadmin
      // read it off the screen and passed it on by hand.
      // After COMMIT, and non-fatal: the organisation exists either way, and
      // the password is still returned below as the fallback.
      const emailed = await tryEmailTempPassword(
        data.admin_email, data.admin_name, data.admin_email.split('@')[0], tempPassword, 'created'
      );

      res.status(201).json({
        ok: true,
        data: {
          org_id: orgId,
          admin_id: adminResult.rows[0].id,
          temp_password: tempPassword,
          emailed,
          message: emailed
            ? `Organization created. The temporary password was emailed to ${data.admin_email}.`
            : 'Organization created. Share the temp password with the admin. It will not be shown again.',
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/orgs/:id
 * Get org details with branch counts
 */
router.get('/orgs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(`
      SELECT o.*,
        -- Re-projected after o.* so the calendar-day form wins: these are due
        -- dates, not instants, and a raw timestamptz reads a day early east
        -- of UTC. See the DATE type parser in db/index.ts.
        o.next_due_at::date AS next_due_at,
        o.trial_ends_at::date AS trial_ends_at,
        p.code AS plan_code, p.name AS plan_name, p.price_ugx AS plan_price_ugx,
        p.billing_cycle, p.max_branches,
        (SELECT COUNT(*) FROM branches WHERE org_id = o.id) as branch_count,
        (SELECT COUNT(*) FROM staff_users WHERE org_id = o.id AND status = 'active') as staff_count,
        (SELECT COUNT(*) FROM clients WHERE org_id = o.id) as client_count,
        (SELECT COUNT(*) FROM washes w WHERE w.org_id = o.id AND w.status = 'settled') AS washes_total,
        (SELECT COUNT(*) FROM washes w
           WHERE w.org_id = o.id AND w.status = 'settled'
             AND w.started_at >= date_trunc('month', now())) AS washes_this_month,
        (SELECT COALESCE(SUM(w.amount_ugx), 0) FROM washes w
           WHERE w.org_id = o.id AND w.status = 'settled'
             AND w.started_at >= date_trunc('month', now())) AS gross_this_month,
        (SELECT MAX(w.started_at) FROM washes w WHERE w.org_id = o.id) AS last_activity_at,
        (SELECT COALESCE(SUM(pay.amount_ugx), 0) FROM org_payments pay WHERE pay.org_id = o.id) AS paid_total_ugx,
        CASE WHEN o.next_due_at IS NULL THEN NULL
             ELSE (o.next_due_at::date - (now() AT TIME ZONE 'UTC')::date)
        END AS days_to_due
      FROM organizations o
      LEFT JOIN subscription_plans p ON p.id = o.plan_id
      WHERE o.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Organization not found'));
      return;
    }

    // Get branches with counts
    const branches = await pool.query(
      `SELECT id, name, code, status,
        (SELECT COUNT(*) FROM staff_users WHERE branch_id = branches.id AND status = 'active') as staff_count
       FROM branches WHERE org_id = $1 ORDER BY name`,
      [id]
    );

    // Six months of usage — the platform admin's read on whether a tenant is
    // growing into its plan or drifting toward churn.
    const usage = await pool.query(`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', now()) - interval '5 months',
          date_trunc('month', now()),
          '1 month'::interval
        ) AS m
      )
      SELECT to_char(months.m, 'YYYY-MM') AS month,
        COUNT(w.id) FILTER (WHERE w.status = 'settled') AS washes,
        COALESCE(SUM(w.amount_ugx) FILTER (WHERE w.status = 'settled'), 0) AS gross_ugx
      FROM months
      LEFT JOIN washes w
        ON w.org_id = $1 AND date_trunc('month', w.started_at) = months.m
      GROUP BY months.m
      ORDER BY months.m
    `, [id]);

    const payments = await pool.query(`
      SELECT pay.id, pay.amount_ugx, pay.period_start, pay.period_end,
             pay.method, pay.reference, pay.note, pay.created_at,
             pa.full_name AS recorded_by_name,
             sp.name AS plan_name
      FROM org_payments pay
      LEFT JOIN platform_admins pa ON pa.id = pay.recorded_by
      LEFT JOIN subscription_plans sp ON sp.id = pay.plan_id
      WHERE pay.org_id = $1
      ORDER BY pay.period_end DESC, pay.created_at DESC
      LIMIT 24
    `, [id]);

    const admins = await pool.query(`
      SELECT id, full_name, username, email, phone, status, must_change_password, last_login_at
      FROM staff_users
      WHERE org_id = $1 AND role = 'orgadmin'
      ORDER BY created_at
    `, [id]);

    res.json({
      ok: true,
      data: {
        ...result.rows[0],
        branches: branches.rows,
        usage: usage.rows,
        payments: payments.rows,
        admins: admins.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /platform/orgs/:id
 * Update org details
 */
router.patch('/orgs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateOrgSchema.parse(req.body);
    const pool = getPool();
    const { id } = req.params;

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.name !== undefined) { updates.push(`name = $${paramIndex++}`); values.push(data.name); }
    if (data.contact_name !== undefined) { updates.push(`contact_name = $${paramIndex++}`); values.push(data.contact_name); }
    if (data.plan !== undefined) { updates.push(`plan = $${paramIndex++}`); values.push(data.plan); }

    if (updates.length === 0) {
      next(createAppError(400, 'NO_CHANGES', 'No fields to update'));
      return;
    }

    updates.push(`updated_at = now()`);
    values.push(id);

    const result = await pool.query(
      `UPDATE organizations SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Organization not found'));
      return;
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/orgs/:id/suspend
 */
router.post('/orgs/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = suspendOrgSchema.parse(req.body);
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE organizations SET status = 'suspended', suspended_at = now(), suspend_reason = $1, updated_at = now()
       WHERE id = $2 AND status = 'active' RETURNING id`,
      [reason, id]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Organization not found or already suspended'));
      return;
    }

    // Audit
    await pool.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
       VALUES ($1, 'platform', $2, 'org.suspended', 'organization', $3, $4)`,
      [id, req.actor!.sub, id, JSON.stringify({ status: 'suspended', reason })]
    );

    res.json({ ok: true, data: { message: 'Organization suspended' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/orgs/:id/activate
 */
router.post('/orgs/:id/activate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE organizations SET status = 'active', suspended_at = NULL, suspend_reason = NULL, updated_at = now()
       WHERE id = $1 AND status = 'suspended' RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Organization not found or already active'));
      return;
    }

    // Audit
    await pool.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
       VALUES ($1, 'platform', $2, 'org.activated', 'organization', $3, $4)`,
      [id, req.actor!.sub, id, JSON.stringify({ status: 'active' })]
    );

    res.json({ ok: true, data: { message: 'Organization activated' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/orgs/:id/admins
 * Add or reset an orgadmin for the org
 */
router.post('/orgs/:id/admins', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = addAdminSchema.parse(req.body);
    const pool = getPool();
    const { id } = req.params;

    // Verify org exists
    const orgCheck = await pool.query('SELECT id FROM organizations WHERE id = $1', [id]);
    if (orgCheck.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Organization not found'));
      return;
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await argon2.hash(tempPassword);

    // created_by stays NULL — see the note in POST /orgs: the creating actor is
    // a platform admin, and that column references staff_users(id).
    const result = await pool.query(
      `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by)
       VALUES ($1, NULL, 'orgadmin', $2, $3, $4, $5, true, NULL) RETURNING id`,
      [id, data.full_name, data.email.split('@')[0], data.email, passwordHash]
    );

    // Audit
    await pool.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
       VALUES ($1, 'platform', $2, 'orgadmin.created', 'staff_users', $3, $4)`,
      [id, req.actor!.sub, result.rows[0].id, JSON.stringify({ email: data.email, role: 'orgadmin' })]
    );

    const emailed = await tryEmailTempPassword(
      data.email, data.full_name, data.email.split('@')[0], tempPassword, 'created'
    );

    res.status(201).json({
      ok: true,
      data: {
        admin_id: result.rows[0].id,
        temp_password: tempPassword,
        emailed,
        message: emailed
          ? `Orgadmin created. The temporary password was emailed to ${data.email}.`
          : 'Orgadmin created. Share the temp password. It will not be shown again.',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/admins
 * List all platform admins
 */
router.get('/admins', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      'SELECT id, full_name, username, email, phone, status, must_change_password, last_login_at, created_at FROM platform_admins ORDER BY created_at'
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/admins
 * Add a new platform admin
 */
router.post('/admins', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = addPlatformAdminSchema.parse(req.body);
    const pool = getPool();
    const username = (data.username || data.email.split('@')[0]).trim();

    // Fail with a clear message rather than a raw unique-violation.
    const clash = await pool.query(
      'SELECT 1 FROM platform_admins WHERE lower(username) = lower($1) OR lower(email) = lower($2)',
      [username, data.email]
    );
    if (clash.rows.length > 0) {
      next(createAppError(409, 'ALREADY_EXISTS', 'That username or email is already taken'));
      return;
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await argon2.hash(tempPassword);

    const result = await pool.query(
      `INSERT INTO platform_admins (full_name, username, email, phone, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
      [data.full_name, username, data.email, data.phone || null, passwordHash]
    );

    const emailed = await tryEmailTempPassword(
      data.email, data.full_name, username, tempPassword, 'created'
    );

    res.status(201).json({
      ok: true,
      data: {
        admin_id: result.rows[0].id,
        username,
        temp_password: tempPassword,
        emailed,
        message: emailed
          ? `Admin created. The temporary password was emailed to ${data.email}.`
          : 'Admin created. Share the temp password. It will not be shown again.',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/admins/:id/reset-password
 * Reset another sysadmin's password (cannot target self)
 */
router.post('/admins/:id/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    // Cannot reset self
    if (id === req.actor!.sub) {
      next(createAppError(403, 'CANNOT_RESET_SELF', 'Cannot reset your own password through this endpoint'));
      return;
    }

    // Check target exists. Name/username/email come back too so the new
    // password can be emailed rather than read off a screen.
    const target = await pool.query(
      'SELECT id, full_name, username, email FROM platform_admins WHERE id = $1',
      [id]
    );
    if (target.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Admin not found'));
      return;
    }
    const targetAdmin = target.rows[0];

    const tempPassword = generateTempPassword();
    const passwordHash = await argon2.hash(tempPassword);

    await pool.query(
      'UPDATE platform_admins SET password_hash = $1, must_change_password = true, updated_at = now() WHERE id = $2',
      [passwordHash, id]
    );

    // Revoke all refresh tokens
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE owner_type = $1 AND owner_id = $2 AND revoked_at IS NULL',
      ['platform', id]
    );

    const emailed = await tryEmailTempPassword(
      targetAdmin.email, targetAdmin.full_name, targetAdmin.username, tempPassword, 'reset'
    );

    res.json({
      ok: true,
      data: {
        temp_password: tempPassword,
        emailed,
        message: emailed
          ? `Password reset. The new temporary password was emailed to ${targetAdmin.email}.`
          : 'Password reset. Share the temp password. It will not be shown again.',
      },
    });
  } catch (err) {
    next(err);
  }
});


// ═══════════════════════════════════════════════════════════════
// Subscription plans — the price list the platform sells against
// ═══════════════════════════════════════════════════════════════

/**
 * GET /platform/plans
 * The plan catalogue, with how many orgs sit on each.
 */
router.get('/plans', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT p.*,
        (SELECT COUNT(*) FROM organizations o WHERE o.plan_id = p.id) AS org_count,
        (SELECT COUNT(*) FROM organizations o
           WHERE o.plan_id = p.id AND o.billing_status = 'active') AS paying_org_count
      FROM subscription_plans p
      ORDER BY p.sort_order, p.price_ugx
    `);
    res.json({ ok: true, data: result.rows });
  } catch (err) { next(err); }
});

/**
 * POST /platform/plans
 */
router.post('/plans', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = planSchema.parse(req.body);
    const pool = getPool();

    const clash = await pool.query('SELECT 1 FROM subscription_plans WHERE lower(code) = lower($1)', [data.code]);
    if (clash.rows.length > 0) {
      next(createAppError(409, 'ALREADY_EXISTS', 'A plan with that code already exists'));
      return;
    }

    const result = await pool.query(
      `INSERT INTO subscription_plans (code, name, price_ugx, billing_cycle, max_branches, description, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        data.code.toLowerCase(), data.name, data.price_ugx, data.billing_cycle,
        data.max_branches ?? null, data.description || null, data.sort_order ?? 0,
      ]
    );
    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

/**
 * PATCH /platform/plans/:id
 */
router.patch('/plans/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updatePlanSchema.parse(req.body);
    const pool = getPool();
    const { id } = req.params;

    const updates: string[] = [];
    const values: any[] = [];
    let i = 1;
    const set = (col: string, val: any) => { updates.push(`${col} = $${i++}`); values.push(val); };

    if (data.name !== undefined) set('name', data.name);
    if (data.price_ugx !== undefined) set('price_ugx', data.price_ugx);
    if (data.billing_cycle !== undefined) set('billing_cycle', data.billing_cycle);
    if (data.max_branches !== undefined) set('max_branches', data.max_branches);
    if (data.description !== undefined) set('description', data.description);
    if (data.sort_order !== undefined) set('sort_order', data.sort_order);
    if (data.active !== undefined) set('active', data.active);

    if (updates.length === 0) {
      next(createAppError(400, 'NO_CHANGES', 'No fields to update'));
      return;
    }
    updates.push('updated_at = now()');
    values.push(id);

    const result = await pool.query(
      `UPDATE subscription_plans SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Plan not found'));
      return;
    }
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// Per-org subscription & payments
// ═══════════════════════════════════════════════════════════════

/**
 * PUT /platform/orgs/:id/subscription
 * Set which plan an org is on and its billing state.
 */
router.put('/orgs/:id/subscription', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = subscriptionSchema.parse(req.body);
    const pool = getPool();
    const { id } = req.params;

    if (data.plan_id) {
      const planCheck = await pool.query('SELECT id FROM subscription_plans WHERE id = $1', [data.plan_id]);
      if (planCheck.rows.length === 0) {
        next(createAppError(404, 'NOT_FOUND', 'Plan not found'));
        return;
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    let i = 1;
    const set = (col: string, val: any) => { updates.push(`${col} = $${i++}`); values.push(val); };

    if (data.plan_id !== undefined) set('plan_id', data.plan_id);
    if (data.billing_status !== undefined) set('billing_status', data.billing_status);
    if (data.trial_ends_at !== undefined) set('trial_ends_at', data.trial_ends_at);
    if (data.next_due_at !== undefined) set('next_due_at', data.next_due_at);
    if (data.billing_notes !== undefined) set('billing_notes', data.billing_notes);

    if (updates.length === 0) {
      next(createAppError(400, 'NO_CHANGES', 'No fields to update'));
      return;
    }

    // Keep the legacy free-text plan column in step so anything still reading
    // it does not go stale against plan_id.
    if (data.plan_id) {
      updates.push(`plan = COALESCE((SELECT code FROM subscription_plans WHERE id = $${i++}), plan)`);
      values.push(data.plan_id);
    }
    updates.push('updated_at = now()');
    values.push(id);

    const result = await pool.query(
      `UPDATE organizations SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, plan, plan_id, billing_status, trial_ends_at::date AS trial_ends_at, next_due_at::date AS next_due_at, billing_notes`,
      values
    );
    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Organization not found'));
      return;
    }

    await pool.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
       VALUES ($1, 'platform', $2, 'org.subscription_updated', 'organization', $3, $4)`,
      [id, req.actor!.sub, id, JSON.stringify(result.rows[0])]
    );

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

/**
 * POST /platform/orgs/:id/payments
 * Record a subscription payment received from the org.
 */
router.post('/orgs/:id/payments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = paymentSchema.parse(req.body);
    const pool = getPool();
    const { id } = req.params;

    const org = await pool.query('SELECT id, plan_id FROM organizations WHERE id = $1', [id]);
    if (org.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Organization not found'));
      return;
    }

    if (data.period_end < data.period_start) {
      next(createAppError(400, 'INVALID_PERIOD', 'Period end must not be before period start'));
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const pay = await client.query(
        `INSERT INTO org_payments (org_id, plan_id, amount_ugx, period_start, period_end, method, reference, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          id, org.rows[0].plan_id, data.amount_ugx, data.period_start, data.period_end,
          data.method, data.reference || null, data.note || null, req.actor!.sub,
        ]
      );

      // A recorded payment that leaves the org flagged past_due is a
      // bookkeeping trap — clearing it here is the point of the flag.
      if (data.advance_due_date) {
        await client.query(
          `UPDATE organizations
           SET next_due_at = GREATEST(COALESCE(next_due_at, $2::date), $2::date),
               billing_status = CASE WHEN billing_status IN ('trial','past_due') THEN 'active' ELSE billing_status END,
               updated_at = now()
           WHERE id = $1`,
          [id, data.period_end]
        );
      }

      await client.query(
        `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
         VALUES ($1, 'platform', $2, 'org.payment_recorded', 'org_payments', $3, $4)`,
        [id, req.actor!.sub, pay.rows[0].id, JSON.stringify({ amount_ugx: data.amount_ugx, period_end: data.period_end })]
      );

      await client.query('COMMIT');
      res.status(201).json({ ok: true, data: pay.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

/**
 * GET /platform/billing/summary
 * The platform's own revenue view: MRR, who owes, who is onboarding.
 */
router.get('/billing/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();

    // MRR normalises every cycle to a monthly figure so plans of different
    // cadence can be added together without over-counting a yearly.
    const summary = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM organizations) AS total_orgs,
        (SELECT COUNT(*) FROM organizations WHERE billing_status = 'active') AS paying_orgs,
        (SELECT COUNT(*) FROM organizations WHERE billing_status = 'trial') AS trial_orgs,
        (SELECT COUNT(*) FROM organizations WHERE billing_status = 'past_due') AS past_due_orgs,
        (SELECT COUNT(*) FROM organizations WHERE billing_status = 'cancelled') AS cancelled_orgs,
        (SELECT COUNT(*) FROM organizations
           WHERE onboarded_at >= date_trunc('month', now())) AS onboarded_this_month,
        (SELECT COALESCE(SUM(
            CASE p.billing_cycle
              WHEN 'yearly'    THEN p.price_ugx / 12.0
              WHEN 'quarterly' THEN p.price_ugx / 3.0
              ELSE p.price_ugx
            END), 0)::bigint
         FROM organizations o JOIN subscription_plans p ON p.id = o.plan_id
         WHERE o.billing_status = 'active') AS mrr_ugx,
        (SELECT COALESCE(SUM(amount_ugx), 0) FROM org_payments
           WHERE created_at >= date_trunc('month', now())) AS collected_this_month,
        (SELECT COALESCE(SUM(amount_ugx), 0) FROM org_payments) AS collected_all_time
    `);

    // Onboarding curve — new orgs per month, six months back.
    const onboarding = await pool.query(`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', now()) - interval '5 months',
          date_trunc('month', now()),
          '1 month'::interval
        ) AS m
      )
      SELECT to_char(months.m, 'YYYY-MM') AS month,
        COUNT(o.id) AS onboarded,
        COALESCE((SELECT SUM(pay.amount_ugx) FROM org_payments pay
                  WHERE date_trunc('month', pay.created_at) = months.m), 0) AS collected_ugx
      FROM months
      LEFT JOIN organizations o ON date_trunc('month', o.onboarded_at) = months.m
      GROUP BY months.m
      ORDER BY months.m
    `);

    // Who needs chasing: overdue first, then due soonest.
    const attention = await pool.query(`
      SELECT o.id, o.name, o.billing_status, o.next_due_at::date AS next_due_at,
             p.name AS plan_name, p.price_ugx AS plan_price_ugx,
             (o.next_due_at::date - (now() AT TIME ZONE 'UTC')::date) AS days_to_due
      FROM organizations o
      LEFT JOIN subscription_plans p ON p.id = o.plan_id
      WHERE o.billing_status <> 'cancelled'
        AND (o.billing_status = 'past_due'
             OR (o.next_due_at IS NOT NULL
                 AND o.next_due_at::date <= (now() AT TIME ZONE 'UTC')::date + 7))
      ORDER BY o.next_due_at NULLS LAST
      LIMIT 25
    `);

    res.json({
      ok: true,
      data: {
        summary: summary.rows[0],
        onboarding: onboarding.rows,
        needs_attention: attention.rows,
      },
    });
  } catch (err) { next(err); }
});

export default router;
