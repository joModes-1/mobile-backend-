import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(8),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  SEED_SYSADMIN_EMAIL: z.string().email(),
  SEED_SYSADMIN_PASSWORD: z.string().min(6),
  PORT: z.coerce.number().default(3000),

  // All SMTP / email configuration was removed from the platform — no email
  // is sent from anywhere any more (auth codes go by SMS; issue reports save
  // in-app and are not emailed). Do not re-add these without a caller.

  // Africa's Talking, for SMS verification codes. Both optional: without
  // them SMS is simply off and phone sign-up cannot complete.
  //
  // Named AFRICASTALKING_USERNAME rather than USERNAME on purpose — USERNAME
  // is a built-in Windows environment variable, and dotenv will not override
  // one that already exists, so the file value was being silently ignored in
  // favour of the developer's Windows login name.
  AFRICASTALKING_USERNAME: z.string().optional(),
  AFRICASTALKING: z.string().optional(),

  // Set true while testing signup/login flows without spending real SMS
  // credit. With this on, sendOtpSms talks to the sandbox endpoint and the
  // OTP is always returned in the API response — sandbox never actually
  // delivers to a handset, so without this, "the code arrived" would have
  // no way to happen at all.
  TEST_MODE: z.enum(['true', 'false', '1', '0', '']).default('false')
    .transform((v) => v === 'true' || v === '1'),

  // Name-lookup-by-phone, for a brand-new client's sign-up. Both optional —
  // no provider is wired in yet, so without them a new client is simply
  // called "Customer" until they rename themselves, exactly as before this
  // was added. Set both once a provider is chosen; nothing else changes.
  NAME_LOOKUP_URL: z.string().optional(),
  NAME_LOOKUP_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
