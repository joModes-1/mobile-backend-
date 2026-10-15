/**
 * One place that turns DATABASE_URL into pg connection options, shared by
 * the app pool (src/db/index.ts) and the migration CLI (knexfile.ts). No
 * imports on purpose: knexfile.ts runs under plain ts-node, without the
 * "@/" path aliases the app uses.
 *
 * Hosted Postgres (Supabase, Render, Neon...) needs TLS but presents a
 * certificate signed by the provider's own authority, which Node doesn't
 * trust. `rejectUnauthorized: false` still encrypts the connection; it just
 * skips verifying the CA, which is how those providers' own docs connect.
 *
 * `sslmode=` in the URL is stripped before connecting. node-postgres lets a
 * URL's sslmode override the `ssl` option we pass, and since pg 8.x treats
 * `sslmode=require` as full certificate verification, leaving it in produces
 * "self-signed certificate in certificate chain" against a hosted database.
 * Stripping it makes the `ssl` option below authoritative, so a plain
 * `?sslmode=require` on the URL just works.
 *
 * Plain local Postgres (no sslmode, localhost) never speaks TLS in dev, so
 * it is left alone.
 */

const HOSTED = /(^|\.)(supabase\.(com|co)|render\.com|neon\.tech)$/i;

export function dbConnection(rawUrl: string): {
  connectionString: string;
  ssl: { rejectUnauthorized: false } | undefined;
} {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { connectionString: rawUrl, ssl: undefined };
  }

  const sslRequested = url.searchParams.has('sslmode') && url.searchParams.get('sslmode') !== 'disable';
  const needsSsl = sslRequested || HOSTED.test(url.hostname);

  if (!needsSsl) return { connectionString: rawUrl, ssl: undefined };

  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } };
}
