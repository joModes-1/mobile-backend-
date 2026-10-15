import type { Knex } from 'knex';
import dotenv from 'dotenv';
import { dbConnection } from './src/db/connection';

dotenv.config();

// TLS handling for hosted Postgres (Supabase, Render...) lives in
// src/db/connection.ts so the migration connection and the app pool can't
// drift apart — they are separate connections, and a migrate against a
// hosted database fails even when the app itself connects fine if only one
// of them gets it right.
const shared: Knex.Config = {
  client: 'pg',
  connection: dbConnection(process.env.DATABASE_URL || ''),
  migrations: {
    directory: './src/db/migrations',
    extension: 'ts',
  },
  seeds: {
    directory: './src/db/seeds',
    extension: 'ts',
  },
};

// The knex CLI picks its config key from NODE_ENV *after* loading this file,
// and dotenv.config() above has by then copied NODE_ENV=production out of a
// server's .env. With only a `development` key, `npm run migrate` on any
// production box (or Render, which sets NODE_ENV=production) died with
// "Required configuration option 'client' is missing". Same settings for both.
const config: { [key: string]: Knex.Config } = {
  development: shared,
  production: shared,
};

export default config;
