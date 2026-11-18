import { z } from 'zod';

/**
 * All configuration comes from environment variables (Vercel project settings in production,
 * .env.local for local development). Parsed lazily so `next build` works without secrets.
 */
const schema = z.object({
  /** Supabase Postgres connection string (transaction pooler, port 6543). Unset = local in-process Postgres. */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('.data/pglite'),

  /** Cloudflare R2 S3 API endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com */
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.string().optional(),
  /** Private bucket for untouched originals. */
  S3_BUCKET_ORIGINALS: z.string().default('polaroid-originals'),
  /** Public bucket for web copies. */
  S3_BUCKET_WEB: z.string().default('polaroid-web'),
  /** Public base URL of the web bucket (custom domain or r2.dev), no trailing slash. */
  PUBLIC_IMAGE_BASE: z.string().url(),

  NEXT_PUBLIC_SUPABASE_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  /** Comma-separated emails allowed into the dashboard. */
  ADMIN_EMAILS: z.string().default(''),
  /** Local development only: skip login. Ignored in production. */
  AUTH_DEV_BYPASS: z.string().optional(),

  /** Optional: run scan processing on Trigger.dev instead of inside the web app. */
  TRIGGER_SECRET_KEY: z.string().optional(),

  SITE_URL: z.string().default('http://localhost:3000'),
});

export type Env = z.infer<typeof schema>;
let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    // Trim pasted values: a stray space or newline from copy-paste breaks URLs and keys.
    const trimmed = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    const parsed = schema.safeParse(trimmed);
    if (!parsed.success) {
      const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
      throw new Error(`Missing or invalid configuration: ${missing}. See README → Environment variables.`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const adminEmails = () =>
  env().ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export const devAuthBypass = () => process.env.NODE_ENV !== 'production' && env().AUTH_DEV_BYPASS === '1';
