import { Pool, types } from 'pg';
import { getEnv } from '@/config';
import { dbConnection } from '@/db/connection';

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
      ...dbConnection(getEnv().DATABASE_URL),
      max: 10,
      // Hosted poolers (Supabase's Supavisor, PgBouncer) close connections
      // that sit idle. Retire ours first so we don't hand out a dead one,
      // and keep live ones from being dropped as "silent" by a firewall.
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      // Fail a request that can't get a connection instead of hanging it.
      connectionTimeoutMillis: 10_000,
    });

    // A pooled connection can still be killed from the other end (provider
    // restart, network blip). pg reports that as an 'error' event on the
    // pool, and an unhandled 'error' event on an EventEmitter crashes the
    // whole process. Log it and carry on: the pool discards the dead
    // connection and opens a fresh one for the next query.
    pool.on('error', (err) => {
      console.error('[db] idle connection error (pool will reconnect):', err.message);
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
