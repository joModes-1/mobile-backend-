import type { Knex } from 'knex';
import dotenv from 'dotenv';
import { dbConnection } from './src/db/connection';

dotenv.config();

// TLS handling for hosted Postgres (Supabase, Render...) lives in
// src/db/connection.ts so the migration connection and the app pool can't
// drift apart — they are separate connections, and a migrate against a
// hosted database fails even when the app itself connects fine if only one
// of them gets it right.
const config: { [key: string]: Knex.Config } = {
  development: {
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
  },
};

export default config;
