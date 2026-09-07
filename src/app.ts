import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import pino from 'pino';
import { z } from 'zod';
import { errorHandler } from '@/middleware/errorHandler';
import { authenticate } from '@/middleware/auth';
import { requirePasswordChanged } from '@/middleware/requirePasswordChanged';
import { requireRole, getOrgId } from '@/middleware/requireRole';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';

// Auth routes
import platformAuthRouter from '@/modules/auth/platformAuth';
import staffAuthRouter from '@/modules/auth/staffAuth';
import clientAuthRouter from '@/modules/clients/clientAuth';
import meRouter from '@/modules/auth/meRouter';

// Platform routes
import platformOrgRouter from '@/modules/platform/orgRoutes';

// Staff routes
import staffRouter from '@/modules/staff/staffRoutes';

// Branch routes
import branchRouter from '@/modules/branches/branchRoutes';
import catalogueRouter from '@/modules/catalogue/catalogueRoutes';
import priceRouter from '@/modules/pricing/priceRoutes';
import shiftRouter from '@/modules/shifts/shiftRoutes';
import deviceRouter from '@/modules/clients/deviceRoutes';

// Phase 4 routes
import tokenRouter from '@/modules/tokens/tokenRoutes';
import washRouter from '@/modules/washes/washRoutes';
import clientWashRouter from '@/modules/washes/clientWashRoutes';
import reportRouter from '@/modules/reports/reportRoutes';
import issueRouter from '@/modules/support/issueRoutes';
import exceptionRouter from '@/modules/washes/exceptionRoutes';

export const logger = pino({
  name: 'carwash-api',
  level: 'info',
});

const app = express();

// Middleware
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// Request ID middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.headers['x-request-id'] = req.headers['x-request-id'] as string || crypto.randomUUID();
  _res.setHeader('X-Request-Id', req.headers['x-request-id'] as string);
  next();
});

// Health check (no auth needed)
app.get('/api/v1/health', (_req, res) => {
  res.json({ ok: true, data: { status: 'healthy', timestamp: new Date().toISOString() } });
});

// Auth routes (public) — login, refresh, logout
// These must come BEFORE the authenticate/password-changed middleware
app.use('/api/v1/auth/platform', platformAuthRouter);
app.use('/api/v1/auth/staff', staffAuthRouter);
app.use('/api/v1/auth/client', clientAuthRouter);

// Global auth + password-changed check for all protected routes
app.use('/api/v1/me', authenticate, requirePasswordChanged, meRouter);
app.use('/api/v1/platform', authenticate, requirePasswordChanged, platformOrgRouter);
app.use('/api/v1/staff', authenticate, requirePasswordChanged, staffRouter);
app.use('/api/v1/branches', authenticate, requirePasswordChanged, branchRouter);
app.use('/api/v1', authenticate, requirePasswordChanged, catalogueRouter);
app.use('/api/v1/prices', authenticate, requirePasswordChanged, priceRouter);
app.use('/api/v1/shifts', authenticate, requirePasswordChanged, shiftRouter);
app.use('/api/v1/me/device', authenticate, requirePasswordChanged, deviceRouter);

// Phase 4: Wash lifecycle
// Client token endpoints (mounted under /me/washes/tokens)
app.use('/api/v1/me/washes', authenticate, requirePasswordChanged, tokenRouter);
// Client wash read endpoints (active, history, loyalty, qr)
app.use('/api/v1/me/washes', authenticate, requirePasswordChanged, clientWashRouter);
// Staff wash endpoints (start, queue, wash-done, settle, cancel, list)
app.use('/api/v1/washes', authenticate, requirePasswordChanged, washRouter);
// Phase 5: Exceptions (correct, reverse, dispute, resolve-dispute)
app.use('/api/v1/washes', authenticate, requirePasswordChanged, exceptionRouter);
// Phase 5: Loyalty adjustment (orgadmin only) — inline to avoid router mount conflicts
app.post('/api/v1/clients/:id/loyalty/adjust', authenticate, requirePasswordChanged, requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { Pool } = await import('pg');
    const { getPool } = await import('@/db');
    const { ensureAccount, lockAccount, writeLedgerEntry } = await import('@/modules/loyalty');
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const adminId = req.actor!.sub;
    const clientId = String(req.params.id);
    const { wash_delta, credit_delta, reason } = req.body;

    if (!reason || typeof wash_delta !== 'number' || typeof credit_delta !== 'number') {
      next(createAppError(422, 'VALIDATION', 'wash_delta, credit_delta, and reason are required'));
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await ensureAccount(client, clientId, orgId);
      const account = await lockAccount(client, clientId);
      if (!account) { await client.query('ROLLBACK'); next(createAppError(404, 'NOT_FOUND', 'Account not found')); return; }

      const newWc = account.wash_count + wash_delta;
      const newCc = account.free_wash_credits + credit_delta;
      if (newWc < 0 || newCc < 0) {
        await client.query('ROLLBACK');
        next(createAppError(422, 'NEGATIVE_BALANCE', 'Would go negative'));
        return;
      }

      await client.query('UPDATE loyalty_accounts SET wash_count=$1, free_wash_credits=$2, updated_at=now() WHERE client_id=$3', [newWc, newCc, clientId]);
      await writeLedgerEntry(client, { clientId, washId: null, entryType: 'manual_adjust', washDelta: wash_delta, creditDelta: credit_delta, washCountAfter: newWc, creditsAfter: newCc, reason, createdBy: adminId });
      await client.query('COMMIT');
      res.json({ ok: true, data: { client_id: clientId, wash_count: newWc, free_wash_credits: newCc } });
    } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
  } catch (err) { next(err); }
});

// Phase 6: Reports
app.use('/api/v1/reports', authenticate, requirePasswordChanged, reportRouter);

// Support: deliberately WITHOUT requirePasswordChanged. Someone stuck behind
// a broken forced-password-change is exactly the person who needs to report
// it, and gating support on completing that flow would trap them.
app.use('/api/v1/issues', issueRouter);

// Client lookup (worker use) — must be after auth middleware
app.get('/api/v1/clients/lookup', authenticate, requirePasswordChanged, requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const { member_code, phone } = req.query;

    if (!member_code && !phone) {
      next(createAppError(400, 'QUERY_REQUIRED', 'Provide member_code or phone'));
      return;
    }

    let query = `SELECT c.id, c.full_name, c.member_code,
                    COALESCE(la.wash_count, 0) as wash_count,
                    COALESCE(la.free_wash_credits, 0) as free_wash_credits
                 FROM clients c
                 LEFT JOIN loyalty_accounts la ON c.id = la.client_id
                 WHERE c.org_id = $1`;
    const params: any[] = [orgId];

    if (member_code) {
      query += ` AND c.member_code = $2`;
      params.push(member_code as string);
    } else {
      query += ` AND c.phone = $2`;
      params.push(phone as string);
    }

    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      next(createAppError(404, 'CLIENT_NOT_FOUND', 'Client not found'));
      return;
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /clients — search/list clients (orgadmin only)
app.get('/api/v1/clients', authenticate, requirePasswordChanged, requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const q = (req.query.q as string || '').trim();
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    let query = `
      SELECT c.id, c.full_name, c.phone, c.member_code, c.status, c.created_at,
             COALESCE(la.wash_count, 0) as wash_count,
             COALESCE(la.free_wash_credits, 0) as free_wash_credits,
             COALESCE(la.lifetime_washes, 0) as lifetime_washes
      FROM clients c
      LEFT JOIN loyalty_accounts la ON c.id = la.client_id
      WHERE c.org_id = $1
    `;
    const params: any[] = [orgId];

    if (q) {
      query += ` AND (c.full_name ILIKE $2 OR c.phone ILIKE $2 OR c.member_code ILIKE $2)`;
      params.push(`%${q}%`);
    }

    const countResult = await pool.query(`SELECT COUNT(*) FROM (${query}) t`, params);

    // c.id breaks ties: two customers registered in the same instant would
    // otherwise order arbitrarily per query, so a row could repeat or be
    // skipped as the client pages through with an offset.
    query += ` ORDER BY c.created_at DESC, c.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    res.json({ ok: true, data: { clients: result.rows, total: parseInt(countResult.rows[0].count) } });
  } catch (err) {
    next(err);
  }
});

// POST /clients — register client at the bay
app.post('/api/v1/clients', authenticate, requirePasswordChanged, requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const { phone, name } = req.body;

    if (!phone || !name) {
      next(createAppError(422, 'VALIDATION', 'phone and name are required'));
      return;
    }

    // Check for duplicate phone
    const existing = await pool.query(
      `SELECT id FROM clients WHERE phone = $1 AND org_id = $2`,
      [phone, orgId]
    );
    if (existing.rows.length > 0) {
      next(createAppError(409, 'DUPLICATE_PHONE', 'Client with this phone already exists'));
      return;
    }

    const memberCode = 'MC-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const walkInUsername = 'walkin_' + Math.random().toString(36).substring(2, 10);
    const walkInEmail = `${walkInUsername}@walkin.local`;
    const result = await pool.query(
      `INSERT INTO clients (org_id, full_name, phone, member_code, phone_verified, username, email)
       VALUES ($1, $2, $3, $4, false, $5, $6) RETURNING id, full_name, phone, member_code`,
      [orgId, name, phone, memberCode, walkInUsername, walkInEmail]
    );

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Loyalty configs endpoint (orgadmin only)
app.get('/api/v1/loyalty-config', authenticate, requirePasswordChanged, requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const result = await pool.query(
      `SELECT * FROM loyalty_configs WHERE org_id = $1`,
      [orgId]
    );
    if (result.rows.length === 0) {
      res.json({ ok: true, data: { washes_required: 7, min_amount_ugx: 0 } });
      return;
    }
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

const updateLoyaltyConfigSchema = z.object({
  washes_required: z.number().int().min(1).max(100),
  min_amount_ugx: z.number().int().min(0),
  credit_expiry_days: z.number().int().min(1).nullable().optional(),
});

app.put('/api/v1/loyalty-config', authenticate, requirePasswordChanged, requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateLoyaltyConfigSchema.parse(req.body);
    const pool = getPool();
    const orgId = getOrgId(req.actor!);

    const result = await pool.query(
      `INSERT INTO loyalty_configs (org_id, washes_required, min_amount_ugx, credit_expiry_days)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id) DO UPDATE SET
         washes_required = $2, min_amount_ugx = $3, credit_expiry_days = $4, updated_at = now()
       RETURNING *`,
      [orgId, data.washes_required, data.min_amount_ugx, data.credit_expiry_days ?? null]
    );

    await pool.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
       VALUES ($1, 'staff', $2, 'loyalty_config.updated', 'loyalty_configs', $3, $4)`,
      [orgId, req.actor!.sub, result.rows[0].id, JSON.stringify(data)]
    );

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /audit-logs — filterable audit trail (orgadmin only)
app.get('/api/v1/audit-logs', authenticate, requirePasswordChanged, requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const action = req.query.action as string | undefined;
    const from = req.query.from as string || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    let query = `
      SELECT al.id, al.action, al.entity, al.entity_id, al.before, al.after, al.created_at,
             al.actor_type, al.actor_id,
             COALESCE(su.full_name, pa.full_name) as actor_name
      FROM audit_logs al
      LEFT JOIN staff_users su ON al.actor_id = su.id AND al.actor_type = 'staff'
      LEFT JOIN platform_admins pa ON al.actor_id = pa.id AND al.actor_type = 'platform'
      WHERE al.org_id = $1 AND al.created_at::date BETWEEN $2 AND $3
    `;
    const params: any[] = [orgId, from, to];

    if (action) {
      query += ` AND al.action = $${params.length + 1}`;
      params.push(action);
    }

    const countResult = await pool.query(`SELECT COUNT(*) FROM (${query}) t`, params);

    query += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    res.json({ ok: true, data: { logs: result.rows, total: parseInt(countResult.rows[0].count) } });
  } catch (err) {
    next(err);
  }
});

// Catch-all for unmatched /api routes
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Endpoint not found' },
    });
  } else {
    next();
  }
});

// Error handler (must be last)
app.use(errorHandler);

export default app;
