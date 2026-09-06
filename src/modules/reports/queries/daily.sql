-- Daily report: washes started, settled, cancelled; gross; redemptions; breakdowns
-- Params: $1=org_id, $2=branch_id (nullable for manager scope), $3=date

-- Summary
SELECT
  COUNT(*) FILTER (WHERE status IN ('settled','reversed')) AS total_washes,
  COUNT(*) FILTER (WHERE status = 'settled') AS settled_washes,
  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_washes,
  COUNT(*) FILTER (WHERE status = 'reversed') AS reversed_washes,
  COALESCE(SUM(amount_ugx) FILTER (WHERE status = 'settled'), 0) AS gross_ugx,
  COUNT(*) FILTER (WHERE status = 'settled' AND is_redemption) AS redemption_count,
  COALESCE(SUM(quoted_amount_ugx) FILTER (WHERE status = 'settled' AND is_redemption), 0) AS redemption_value_ugx,
  COUNT(*) FILTER (WHERE status = 'settled' AND client_id IS NULL) AS walkin_count,
  COUNT(*) FILTER (WHERE status = 'settled' AND handover_reason IS NOT NULL) AS handover_count
FROM washes
WHERE org_id = $1
  AND ($2::uuid IS NULL OR branch_id = $2)
  AND started_at::date = $3;

-- By car type
SELECT vc.name AS vehicle_class_name,
  COUNT(*) FILTER (WHERE w.status = 'settled') AS settled,
  COALESCE(SUM(w.amount_ugx) FILTER (WHERE w.status = 'settled'), 0) AS gross_ugx
FROM washes w
JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
WHERE w.org_id = $1
  AND ($2::uuid IS NULL OR w.branch_id = $2)
  AND w.started_at::date = $3
GROUP BY vc.name ORDER BY gross_ugx DESC;

-- By service
SELECT s.name AS service_name,
  COUNT(*) FILTER (WHERE w.status = 'settled') AS settled,
  COALESCE(SUM(w.amount_ugx) FILTER (WHERE w.status = 'settled'), 0) AS gross_ugx
FROM washes w
JOIN services s ON w.service_id = s.id
WHERE w.org_id = $1
  AND ($2::uuid IS NULL OR w.branch_id = $2)
  AND w.started_at::date = $3
GROUP BY s.name ORDER BY gross_ugx DESC;

-- By worker
SELECT su.full_name AS worker_name,
  COUNT(*) FILTER (WHERE w.status = 'settled' AND w.started_by_worker_id = su.id) AS started,
  COUNT(*) FILTER (WHERE w.status = 'settled' AND w.settled_by_worker_id = su.id) AS settled,
  COALESCE(SUM(w.amount_ugx) FILTER (WHERE w.status = 'settled' AND w.settled_by_worker_id = su.id), 0) AS cash_taken_ugx
FROM washes w
JOIN staff_users su ON (w.started_by_worker_id = su.id OR w.settled_by_worker_id = su.id)
WHERE w.org_id = $1
  AND ($2::uuid IS NULL OR w.branch_id = $2)
  AND w.started_at::date = $3
GROUP BY su.id, su.full_name;
