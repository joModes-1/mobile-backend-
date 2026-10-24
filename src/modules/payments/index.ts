import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { getPool } from '@/db';
import { logger } from '@/app';
import { createAppError } from '@/middleware/errorHandler';
import { notify } from '@/modules/notify';
import { submitOrder, getStatus, pesapalEnabled, channelFor, publicBase } from './pesapal';

/**
 * Online payment of a wash through PesaPal.
 *
 *   POST /me/payments       client: start paying a wash, get the checkout link
 *   GET  /me/payments/:id   client: where is this payment
 *   GET  /payments/ipn      PesaPal: "something changed" (public, verified)
 *   GET  /payments/return   the page the customer's browser lands on after paying
 *
 * Paying does not settle the wash. It marks it paid, so the worker is told
 * there is nothing to collect and confirms with one tap; the wallet and
 * commission rules in settlement stay exactly as they were.
 */

/** Brings a payment up to date with PesaPal. Idempotent: IPN, return and polling may all call it. */
export async function refreshPayment(paymentId: string): Promise<any> {
  const pool = getPool();
  const found = await pool.query(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
  const p = found.rows[0];
  if (!p) return null;
  if (p.status !== 'pending' || !p.order_tracking_id) return p;

  const s = await getStatus(p.order_tracking_id, p.org_id);
  if (s.state === 'pending') return p;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock so an IPN, the return page and a poll arriving together agree.
    const locked = await client.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    const cur = locked.rows[0];
    if (cur.status !== 'pending') { await client.query('COMMIT'); return cur; }

    if (s.state === 'succeeded') {
      // The money that arrived must match what we asked for, or it is
      // flagged and not credited.
      if (s.amount != null && Math.round(s.amount) !== Number(cur.amount_ugx)) {
        logger.error({ paymentId, asked: cur.amount_ugx, got: s.amount }, '[PESAPAL] amount mismatch, not credited');
        await client.query(`UPDATE payments SET status = 'failed', provider_status = $2, updated_at = now() WHERE id = $1`, [paymentId, `Amount mismatch: ${s.amount}`]);
        await client.query('COMMIT');
        return { ...cur, status: 'failed' };
      }
      const channel = channelFor(s.method);
      await client.query(
        `UPDATE payments SET status = 'succeeded', provider_status = $2, provider_method = $3,
                confirmation_code = $4, paid_at = now(), updated_at = now() WHERE id = $1`,
        [paymentId, s.description, s.method, s.confirmationCode]
      );
      await client.query(
        `UPDATE washes SET paid_online_at = now(), online_payment_ref = $2, online_payment_method = $3,
                declared_payment_method = $3, updated_at = now() WHERE id = $1`,
        [cur.wash_id, s.confirmationCode, channel]
      );
      await client.query('COMMIT');
      notify('client', cur.client_id || '', 'payment_received', { wash_id: cur.wash_id, amount_ugx: cur.amount_ugx });
      return { ...cur, status: 'succeeded' };
    }

    await client.query(`UPDATE payments SET status = 'failed', provider_status = $2, updated_at = now() WHERE id = $1`, [paymentId, s.description]);
    await client.query('COMMIT');
    return { ...cur, status: 'failed' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Client routes (authenticated; mounted at /me/payments) ──────────────
export const clientPaymentRouter = Router();

const startSchema = z.object({
  wash_id: z.string().uuid(),
  phone: z.string().max(20).optional(),
});

clientPaymentRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') throw createAppError(403, 'FORBIDDEN', 'Client access required');
    if (!pesapalEnabled()) throw createAppError(503, 'PAYMENTS_OFF', 'Online payment is not available yet');
    const body = startSchema.parse(req.body);
    const pool = getPool();

    const w = await pool.query(
      `SELECT w.id, w.org_id, w.status, w.is_redemption, w.quoted_amount_ugx, w.points_value_ugx,
              w.paid_online_at, w.job_no
         FROM washes w WHERE w.id = $1 AND w.client_id = $2`,
      [body.wash_id, req.actor.sub]
    );
    const wash = w.rows[0];
    if (!wash) throw createAppError(404, 'NOT_FOUND', 'Wash not found');
    if (!['requested', 'in_progress', 'ready'].includes(wash.status)) throw createAppError(409, 'BAD_STATE', 'This wash is already closed');
    if (wash.paid_online_at) throw createAppError(409, 'ALREADY_PAID', 'This wash is already paid');

    const amount = wash.is_redemption ? 0 : Math.max(0, Number(wash.quoted_amount_ugx) - Number(wash.points_value_ugx || 0));
    if (amount <= 0) throw createAppError(422, 'NOTHING_TO_PAY', 'There is nothing to pay for this wash');

    // A short unique reference PesaPal echoes back to us (50 characters at most).
    const ref = `CW-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
    const order = await submitOrder({
      merchantReference: ref,
      amountUgx: amount,
      description: `Car wash${wash.job_no ? ` #${wash.job_no}` : ''}`,
      phone: body.phone,
      callbackUrl: `${publicBase()}/api/v1/payments/return?ref=${encodeURIComponent(ref)}`,
      orgId: wash.org_id,
    });

    const ins = await pool.query(
      `INSERT INTO payments (org_id, wash_id, client_id, environment, merchant_reference, order_tracking_id, amount_ugx, payer_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [wash.org_id, wash.id, req.actor.sub, order.env, ref, order.orderTrackingId, amount, body.phone || null]
    );
    res.json({ ok: true, data: { payment_id: ins.rows[0].id, amount_ugx: amount, redirect_url: order.redirectUrl, environment: order.env } });
  } catch (err: any) {
    if (err?.name === 'ZodError') { next(createAppError(400, 'VALIDATION_ERROR', 'Request validation failed', err.errors)); return; }
    if (!err?.status && !err?.statusCode && /PesaPal|PUBLIC_API_URL/.test(String(err?.message))) {
      logger.error({ err: String(err.message) }, '[PESAPAL] could not start payment');
      next(createAppError(502, 'PAYMENT_PROVIDER', 'Could not reach the payment provider. Try again.'));
      return;
    }
    next(err);
  }
});

clientPaymentRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') throw createAppError(403, 'FORBIDDEN', 'Client access required');
    const own = await getPool().query(`SELECT id FROM payments WHERE id = $1 AND client_id = $2`, [req.params.id, req.actor.sub]);
    if (own.rows.length === 0) throw createAppError(404, 'NOT_FOUND', 'Payment not found');
    // Ask PesaPal now, so the app does not wait for the IPN to arrive.
    const p = await refreshPayment(String(req.params.id));
    res.json({ ok: true, data: { id: p.id, status: p.status, amount_ugx: p.amount_ugx, wash_id: p.wash_id } });
  } catch (err) {
    next(err);
  }
});

// ─── Public routes (PesaPal and the customer's browser; mounted at /payments) ──
export const publicPaymentRouter = Router();

publicPaymentRouter.get('/ipn', async (req: Request, res: Response) => {
  const trackingId = String(req.query.OrderTrackingId || '');
  const ref = String(req.query.OrderMerchantReference || '');
  const type = String(req.query.OrderNotificationType || 'IPNCHANGE');
  let status = 200;
  try {
    // The query values only locate a payment we created; the outcome comes
    // from asking PesaPal directly.
    const row = await getPool().query(
      `SELECT id FROM payments WHERE order_tracking_id = $1 OR merchant_reference = $2 LIMIT 1`,
      [trackingId, ref]
    );
    if (row.rows[0]) await refreshPayment(row.rows[0].id);
  } catch (err: any) {
    logger.error({ err: String(err?.message) }, '[PESAPAL] IPN handling failed');
    status = 500;
  }
  res.json({ orderNotificationType: type, orderTrackingId: trackingId, orderMerchantReference: ref, status });
});

publicPaymentRouter.get('/return', async (req: Request, res: Response) => {
  const ref = String(req.query.ref || req.query.OrderMerchantReference || '');
  let message = 'Thank you. You can close this page and go back to the 92 CarWash app.';
  try {
    const row = await getPool().query(`SELECT id FROM payments WHERE merchant_reference = $1`, [ref]);
    if (row.rows[0]) {
      const p = await refreshPayment(row.rows[0].id);
      if (p?.status === 'succeeded') message = 'Payment received. Go back to the 92 CarWash app.';
      else if (p?.status === 'failed') message = 'The payment did not go through. Go back to the app to try again.';
    }
  } catch { /* informational page; the app polls for the real status */ }
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>92 CarWash</title>
<style>body{font-family:system-ui,sans-serif;background:#F3F2FA;color:#121628;display:grid;place-items:center;min-height:100vh;margin:0}
.c{background:#fff;border-radius:20px;padding:32px 28px;max-width:360px;text-align:center;box-shadow:0 8px 28px rgba(60,30,150,.12)}
h1{font-size:20px;margin:0 0 8px}p{color:#4A5169;line-height:1.5;margin:0}</style></head>
<body><div class="c"><h1>92 CarWash</h1><p>${message}</p></div></body></html>`);
});
