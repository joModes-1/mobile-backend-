import type { Knex } from 'knex';
import dotenv from 'dotenv';

dotenv.config();

// Same SSL reasoning as src/db/index.ts: Render's managed Postgres requires
// TLS but presents a cert Node won't verify by default, and knex's migration
// connection is separate from the app pool — without this, `npm run migrate`
// against a Render database fails even once the app itself connects fine.
const databaseUrl = process.env.DATABASE_URL || '';
const needsSsl = /sslmode=require|render\.com/.test(databaseUrl);

const config: { [key: string]: Knex.Config } = {
  development: {
    client: 'pg',
    connection: {
      connectionString: databaseUrl,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    },
    migrations: {
      directory: './src/db/migrations',
      extension: 'ts',
    },
    seeds: {
      directory: './src/db/seeds',
      extension: 'ts',
    },
  },
};

export default config;
