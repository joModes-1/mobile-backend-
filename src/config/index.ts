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
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  // NOT z.coerce.boolean(): that applies JS truthiness, under which the
  // string "false" is true — so SMTP_SECURE=false switched TLS ON and the
  // handshake failed against plaintext port 587 with "wrong version number".
  // Parse the text as text.
  SMTP_SECURE: z
    .enum(['true', 'false', '1', '0', ''])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('Car Wash Loyalty <no-reply@carwash.local>'),
  // Where in-app issue reports are emailed. Optional: with no value the
  // report is still saved and visible in the app, it just is not emailed —
  // support must not break because SMTP has not been set up yet.
  SUPPORT_EMAIL: z.string().optional(),

  // Africa's Talking, for SMS verification codes. Both optional: without
  // them SMS is simply off and the app falls back to email signup.
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
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
