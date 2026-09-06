const http = require('http');

function api(method: string, path: string, body?: any, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts: any = {
      hostname: 'localhost', port: 3456, path, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
    };
    const req = http.request(opts, (res: any) => {
      let d = '';
      res.on('data', (c: string) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let passCount = 0, failCount = 0;
function check(name: string, cond: boolean) {
  if (cond) { passCount++; console.log('  ✓ ' + name); }
  else { failCount++; console.log('  ✗ ' + name); }
}

async function main() {
  // Login as orgadmin
  let oa = await api('POST', '/api/v1/auth/staff/login', { username: 'orgadmin', password: 'Orgadmin123!' });
  await api('POST', '/api/v1/auth/staff/change-password', { current_password: 'Orgadmin123!', new_password: 'Xoa1234!' }, oa.data.access_token);
  oa = await api('POST', '/api/v1/auth/staff/login', { username: 'orgadmin', password: 'Xoa1234!' });
  const oaToken = oa.data.access_token;

  // Login as manager
  let mg = await api('POST', '/api/v1/auth/staff/login', { username: 'grace', password: 'Manager123!' });
  await api('POST', '/api/v1/auth/staff/change-password', { current_password: 'Manager123!', new_password: 'Xmgr123!' }, mg.data.access_token);
  mg = await api('POST', '/api/v1/auth/staff/login', { username: 'grace', password: 'Xmgr123!' });
  const mgToken = mg.data.access_token;

  // Login as worker
  let w = await api('POST', '/api/v1/auth/staff/login', { username: 'joseph', password: 'Worker123!' });
  const wToken = w.data.access_token;

  // Get branch IDs
  const branches = await api('GET', '/api/v1/branches', null, oaToken);
  const ntdId = branches.data.find((b: any) => b.code === 'NTD')?.id;
  const kblId = branches.data.find((b: any) => b.code === 'KBL')?.id;

  console.log('\n=== CATALOGUE TESTS ===');

  // 1. List vehicle classes
  const vcs = await api('GET', '/api/v1/vehicle-classes', null, oaToken);
  check('List vehicle classes (5)', vcs.ok && vcs.data.length === 5);

  // 2. List services
  const svcs = await api('GET', '/api/v1/services', null, oaToken);
  check('List services (4)', svcs.ok && svcs.data.length === 4);
  check('One default service', svcs.data.filter((s: any) => s.is_default).length === 1);

  // 3. Duplicate vehicle class -> 409
  const dupVC = await api('POST', '/api/v1/vehicle-classes', { name: 'SUV' }, oaToken);
  check('Duplicate vehicle class (409)', dupVC.error?.code === 'DUPLICATE_NAME');

  // 4. Duplicate service -> 409
  const dupSvc = await api('POST', '/api/v1/services', { name: 'Full wash' }, oaToken);
  check('Duplicate service (409)', dupSvc.error?.code === 'DUPLICATE_NAME');

  console.log('\n=== PRICE MATRIX TESTS ===');

  // 5. GET /prices matrix
  const matrix = await api('GET', '/api/v1/prices?branch_id=' + ntdId, null, oaToken);
  check('GET /prices returns matrix', matrix.ok && matrix.data.matrix.length > 0);
  check('GET /prices returns services', matrix.data.services.length === 4);
  check('GET /prices returns vehicle_classes', matrix.data.vehicle_classes.length === 5);
  check('GET /prices missing array exists', Array.isArray(matrix.data.missing));

  // 6. Branch override wins over org default
  const ntdSuvFull = matrix.data.matrix.find((p: any) => {
    const vc = matrix.data.vehicle_classes.find((v: any) => v.name === 'SUV');
    const svc = matrix.data.services.find((s: any) => s.name === 'Full wash');
    return p.vehicle_class_id === vc?.id && p.service_id === svc?.id;
  });
  check('Branch override present for SUV at NTD', ntdSuvFull?.source === 'branch_override');
  check('Override price > org default', ntdSuvFull?.effective_price_ugx > ntdSuvFull?.org_price_ugx);

  // 7. Kabalagala (no override) gets org default
  const kblMatrix = await api('GET', '/api/v1/prices?branch_id=' + kblId, null, oaToken);
  const kblSuvFull = kblMatrix.data.matrix.find((p: any) => {
    const vc = kblMatrix.data.vehicle_classes.find((v: any) => v.name === 'SUV');
    const svc = kblMatrix.data.services.find((s: any) => s.name === 'Full wash');
    return p.vehicle_class_id === vc?.id && p.service_id === svc?.id;
  });
  check('No override for KBL -> uses org default', kblSuvFull?.source === 'org_default');

  console.log('\n=== EFFECTIVE PRICE TESTS ===');

  // 8. GET /prices/effective
  const effective = await api('GET', '/api/v1/prices/effective?branch_id=' + ntdId, null, oaToken);
  check('Effective prices returned', effective.ok && effective.data.vehicle_classes.length === 5);
  const effSuv = effective.data.vehicle_classes.find((vc: any) => vc.name === 'SUV');
  check('Effective has services nested', effSuv?.services?.length === 4);
  const effSuvFull = effSuv?.services.find((s: any) => s.name === 'Full wash');
  check('Effective SUV Full Wash has_price=true', effSuvFull?.has_price === true);
  check('Effective SUV Full Wash = override (27500)', effSuvFull?.price_ugx === 27500);

  console.log('\n=== PRICE WRITE TESTS ===');

  // 9. PUT /prices orgwide upsert
  const saloonClass = vcs.data.find((v: any) => v.name === 'Saloon');
  const halfWash = svcs.data.find((s: any) => s.name === 'Half wash');
  const upsert = await api('PUT', '/api/v1/prices', { service_id: halfWash.id, vehicle_class_id: saloonClass.id, price_ugx: 13000 }, oaToken);
  check('Orgadmin upserts org-wide price', upsert.ok);

  // 10. Manager upserts branch override
  const mgrUpsert = await api('PUT', '/api/v1/prices/branch/' + ntdId, { service_id: halfWash.id, vehicle_class_id: saloonClass.id, price_ugx: 14000 }, mgToken);
  check('Manager upserts branch override', mgrUpsert.ok);

  // 11. Manager tries another branch -> 403
  const mgrWrongBranch = await api('PUT', '/api/v1/prices/branch/' + kblId, { service_id: halfWash.id, vehicle_class_id: saloonClass.id, price_ugx: 14000 }, mgToken);
  check('Manager blocked from other branch (403)', mgrWrongBranch.error?.code === 'FORBIDDEN');

  // 12. Manager tries org-wide -> 403
  const mgrOrgWide = await api('PUT', '/api/v1/prices', { service_id: halfWash.id, vehicle_class_id: saloonClass.id, price_ugx: 14000 }, mgToken);
  check('Manager blocked from org-wide (403)', mgrOrgWide.error?.code === 'FORBIDDEN');

  // 13. Worker writes price -> 403
  const workerPrice = await api('PUT', '/api/v1/prices', { service_id: halfWash.id, vehicle_class_id: saloonClass.id, price_ugx: 5000 }, wToken);
  check('Worker blocked from price write (403)', workerPrice.error?.code === 'FORBIDDEN');

  // 14. resolvePrice
  const resolve = await api('POST', '/api/v1/prices/resolve', { service_id: halfWash.id, vehicle_class_id: saloonClass.id, branch_id: ntdId }, oaToken);
  check('resolvePrice works', resolve.ok && resolve.data.price_ugx > 0);

  // 15. resolvePrice inactive VC -> error
  await api('PATCH', '/api/v1/vehicle-classes/' + saloonClass.id, { active: false }, oaToken);
  const resolveInactive = await api('POST', '/api/v1/prices/resolve', { service_id: halfWash.id, vehicle_class_id: saloonClass.id, branch_id: ntdId }, oaToken);
  check('resolvePrice inactive VC', resolveInactive.error?.code === 'INACTIVE_ITEM');
  await api('PATCH', '/api/v1/vehicle-classes/' + saloonClass.id, { active: true }, oaToken);

  // 16. resolvePrice no price -> 422
  const truckClass = vcs.data.find((v: any) => v.name === 'Truck');
  const newSvc = await api('POST', '/api/v1/services', { name: 'Tyre Polish', earns_point: false }, oaToken);
  const resolveNoPrice = await api('POST', '/api/v1/prices/resolve', { service_id: newSvc.data.id, vehicle_class_id: truckClass.id, branch_id: ntdId }, oaToken);
  check('resolvePrice no price (422)', resolveNoPrice.error?.code === 'NO_PRICE_SET');

  // 17. Client token blocked
  let clientReg = await api('POST', '/api/v1/auth/client/register', { full_name: 'Test', phone: '+256700111111', password: 'test123' });
  let clientVerify = await api('POST', '/api/v1/auth/client/verify-otp', { phone: '+256700111111', code: clientReg.data.otp_code });
  const clientPrice = await api('GET', '/api/v1/prices', null, clientVerify.data.access_token);
  check('Client blocked from price endpoints', clientPrice.error?.code === 'FORBIDDEN');

  // 18. Bulk upsert
  const bulkResult = await api('POST', '/api/v1/prices/bulk', { prices: [
    { service_id: halfWash.id, vehicle_class_id: saloonClass.id, price_ugx: 13500 },
  ]}, oaToken);
  check('Bulk upsert works', bulkResult.ok && Array.isArray(bulkResult.data));

  // 19. Audit rows
  const history = await api('GET', '/api/v1/prices/history', null, oaToken);
  check('Price history from audit_logs', history.ok && history.data.length > 0);

  console.log('\n=== Results: ' + passCount + ' passed, ' + failCount + ' failed ===');
}

main().catch(console.error);
