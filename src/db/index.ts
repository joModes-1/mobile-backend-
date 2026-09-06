import { Pool, types } from 'pg';
import { getEnv } from '@/config';

// A DATE column is a calendar day, not an instant. node-postgres parses it
// into a JS Date at *local* midnight, which then serialises to JSON as the
// previous day for any timezone east of UTC — in UTC+3, a billing period
// stored as 2026-10-06 reached the client as "2026-10-05T21:00:00.000Z" and
// rendered a day early. Hand DATE back as the plain "YYYY-MM-DD" string it
// already is and the round-trip stops lying. (TIMESTAMPTZ is untouched: those
// really are instants and must stay Date objects.)
const PG_TYPE_DATE = 1082;
types.setTypeParser(PG_TYPE_DATE, (v: string) => v);

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getEnv().DATABASE_URL,
      // Render's managed Postgres requires SSL and presents a certificate
      // that isn't in Node's trust chain, so a bare `ssl: true` gets rejected
      // with SELF_SIGNED_CERT_IN_CHAIN. `rejectUnauthorized: false` still
      // encrypts the connection — it just doesn't verify the CA — which
      // matches how Render's own docs and most hosts on it connect. Local
      // Postgres (DATABASE_URL without sslmode=require) is untouched: it
      // never speaks TLS in dev, so forcing ssl there would break `npm run
      // dev` instead of fixing anything.
      ssl: /sslmode=require|render\.com/.test(getEnv().DATABASE_URL)
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
