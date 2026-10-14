import { Router, Request, Response, NextFunction } from 'express';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';

/**
 * Shared guard for the client-only branch endpoints in this file. Inline on
 * purpose: `requireRole()` explicitly always rejects type==='client', so the
 * generic helper cannot express "client AND nobody else" — the same shape
 * /resolve already uses below.
 */
function requireClientActor(req: Request): boolean {
  return !!req.actor && req.actor.type === 'client';
}

const router = Router();

/**
 * GET /me/branches/resolve?code=NTD&org_id=<uuid>
 *
 * Turns a wall-mounted branch QR into the branch it names, so a client's app
 * can scope the rest of a self-service booking to it.
 *
 * The QR encodes org_id + code together, not the bare code: `code` is only
 * unique per organisation (see branches' own uniqueness check in
 * branchRoutes.ts), so a code alone is ambiguous across orgs. It does not
 * fall back to the calling client's own org_id — the QR itself is the source
 * of truth for which branch (and organisation) the client is physically
 * standing at, the same way a worker's scan of a customer's code is trusted
 * over anything already on the worker's own token.
 */
router.get('/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireClientActor(req)) {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const code = String(req.query.code || '').trim();
    const orgId = String(req.query.org_id || '').trim();
    if (!code || !orgId) {
      next(createAppError(400, 'VALIDATION_ERROR', 'code and org_id are required'));
      return;
    }

    const pool = getPool();
    const result = await pool.query(
      `SELECT id, name, code, status FROM branches WHERE org_id = $1 AND upper(code) = upper($2)`,
      [orgId, code]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'BRANCH_NOT_FOUND', 'That branch code was not recognised'));
      return;
    }

    const branch = result.rows[0];
    if (branch.status !== 'active') {
      next(createAppError(409, 'BRANCH_INACTIVE', 'This branch is not currently accepting bookings'));
      return;
    }

    res.json({ ok: true, data: { id: branch.id, name: branch.name, code: branch.code } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /me/branches/nearby?org_id=<uuid>&lat=<num>&lng=<num>&radius_km=<num?>
 *
 * The client's nearby-branch picker: active branches of ONE organisation
 * with real coordinates, sorted by how far they are from the device's
 * current GPS fix, closest first.
 *
 * Design notes (see NEARBY_BRANCH_LOCATION.md for the full plan):
 *  - `org_id` comes from the query, not the token: a client is scoped to the
 *    org whose QR/app they are using, the same reasoning /resolve documents.
 *  - `lat`/`lng` are the device's current fix. They are used ONLY to compute
 *    distance in this query — no INSERT/UPDATE touches them, nothing is
 *    persisted, and no arrival history is kept. If that is ever wanted it is
 *    a separate, explicitly-consented feature.
 *  - lat/lng are OPTIONAL. Without them (location permission declined, GPS
 *    off, or the web build) the endpoint returns ALL active branches of the
 *    org alphabetically with no distance figure — the picker degrades to a
 *    plain list rather than ever blocking a client who could otherwise scan
 *    a QR. A 400 for a *malformed* fix ("abc", lat 999) stays a 400: that is
 *    a bug to surface, not a permission to work around.
 *  - `radius_km` defaults to 25. Branches beyond it are omitted entirely —
 *    a client who has relocated out of coverage sees an empty list, not a
 *    nonsensical "412km away" row.
 *  - Distance is plain Haversine in SQL. No PostGIS — adding an extension
 *    for one query is an infra change this does not justify. The subquery
 *    exists because the WHERE on the computed alias has to run after the
 *    SELECT that computes it; `least/greatest` clamps acos's argument into
 *    [-1, 1] so floating-point drift at distance ~0 cannot throw.
 *  - Branches with NULL latitude/longitude are excluded, not shown last —
 *    a branch without coordinates has no honest distance to show, and the
 *    orgadmin sets coordinates per branch via the existing PATCH /branches/:id.
 */
router.get('/nearby', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireClientActor(req)) {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const orgId = String(req.query.org_id || '').trim();
    // Absent/empty means "no fix available" (permission declined, GPS off,
    // web without geolocation) — a valid state, not an error. Present but
    // unparseable means the caller has a bug — that stays a 400.
    const latRaw = String(req.query.lat ?? '').trim();
    const lngRaw = String(req.query.lng ?? '').trim();
    const lat = latRaw === '' ? null : Number(latRaw);
    const lng = lngRaw === '' ? null : Number(lngRaw);
    const radiusKm = req.query.radius_km !== undefined && String(req.query.radius_km).trim() !== ''
      ? Number(req.query.radius_km)
      : 25;

    if (!orgId) {
      next(createAppError(400, 'VALIDATION_ERROR', 'org_id is required'));
      return;
    }
    if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
      next(createAppError(400, 'VALIDATION_ERROR', 'lat must be a number between -90 and 90'));
      return;
    }
    if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) {
      next(createAppError(400, 'VALIDATION_ERROR', 'lng must be a number between -180 and 180'));
      return;
    }
    if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 500) {
      next(createAppError(400, 'VALIDATION_ERROR', 'radius_km must be a number between 0 and 500'));
      return;
    }

    const pool = getPool();

    // No fix: plain alphabetical list of the org's active branches, no
    // distance, no radius filter (a radius means nothing without a fix).
    if (lat === null || lng === null) {
      const plain = await pool.query(
        `SELECT id, name, code, address
           FROM branches
          WHERE org_id = $1 AND status = 'active'
          ORDER BY name ASC`,
        [orgId]
      );
      res.json({ ok: true, data: plain.rows });
      return;
    }

    const result = await pool.query(
      `SELECT sub.id, sub.name, sub.code, sub.address,
              round(sub.distance_km::numeric, 1)::float8 AS distance_km
         FROM (
           SELECT id, name, code, address,
                  ( 6371 * acos( least(1, greatest(-1,
                      cos(radians($2)) * cos(radians(latitude)) *
                      cos(radians(longitude) - radians($3)) +
                      sin(radians($2)) * sin(radians(latitude))
                  )) ) ) AS distance_km
             FROM branches
            WHERE org_id = $1
              AND status = 'active'
              AND latitude IS NOT NULL
              AND longitude IS NOT NULL
         ) sub
        WHERE sub.distance_km <= $4
        ORDER BY sub.distance_km ASC`,
      [orgId, lat, lng, radiusKm]
    );

    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
