import { getPool } from '@/db';

export interface PriceResult {
  price_id: string;
  price_ugx: number;
}

/**
 * Resolve the effective price for a (service, car type, branch) combination.
 *
 * Resolution order:
 * 1. Branch-specific override if one exists and is active
 * 2. Org-wide default (branch_id IS NULL) if one exists and is active
 * 3. null — never fall back to 0 or another price
 */
export async function resolvePrice(
  serviceId: string,
  vehicleClassId: string,
  branchId: string,
  orgId: string
): Promise<PriceResult | null> {
  const pool = getPool();

  const checkResult = await pool.query(
    `SELECT
       (SELECT active FROM services WHERE id = $1 AND org_id = $3) AS service_active,
       (SELECT active FROM vehicle_classes WHERE id = $2 AND org_id = $3) AS vc_active`,
    [serviceId, vehicleClassId, orgId]
  );

  const row = checkResult.rows[0];
  if (!row.service_active || !row.vc_active) {
    return null;
  }

  const priceResult = await pool.query(
    `SELECT id, price_ugx FROM prices
     WHERE service_id = $1 AND vehicle_class_id = $2 AND active
       AND (branch_id = $3 OR branch_id IS NULL)
       AND org_id = $4
     ORDER BY branch_id NULLS LAST
     LIMIT 1`,
    [serviceId, vehicleClassId, branchId, orgId]
  );

  if (priceResult.rows.length === 0) {
    return null;
  }

  return {
    price_id: priceResult.rows[0].id,
    price_ugx: Number(priceResult.rows[0].price_ugx),
  };
}
