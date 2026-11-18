import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { apiAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Setup check for the dashboard. Reports the *shape* of each secret (length, whether it still has a
 * placeholder, etc.) and whether it actually works — never the secret itself — so a screenshot of
 * this page is safe to share.
 */
export async function GET() {
  const admin = await apiAdmin();
  if (admin instanceof Response) return admin;

  const problems: string[] = [];
  const database = await checkDatabase(process.env.DATABASE_URL, problems);
  const storage = await checkStorage(problems);

  return Response.json(
    { ok: problems.length === 0, problems, database, storage },
    { headers: { 'cache-control': 'no-store' } },
  );
}

async function checkDatabase(raw: string | undefined, problems: string[]) {
  if (!raw) {
    problems.push('DATABASE_URL is not set.');
    return { set: false };
  }
  const value = raw.trim();
  const out: Record<string, unknown> = { set: true, hadExtraSpacesAroundIt: raw !== value };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push('DATABASE_URL is not a connection string. It should start with postgresql://');
    return { ...out, isConnectionString: false };
  }

  let pw = url.password;
  try { pw = decodeURIComponent(pw); } catch { /* keep raw */ }
  const password = {
    length: pw.length,
    stillSaysYourPassword: /YOUR-PASSWORD/i.test(pw),
    hasSquareBrackets: /[[\]]/.test(pw),
    hasSpaces: /\s/.test(pw),
    lettersAndNumbersOnly: /^[A-Za-z0-9]+$/.test(pw),
  };
  Object.assign(out, {
    isConnectionString: url.protocol.startsWith('postgres'),
    user: decodeURIComponent(url.username),
    host: url.hostname,
    port: url.port,
    database: url.pathname.slice(1),
    password,
  });

  if (!pw) problems.push('DATABASE_URL has no password in it.');
  if (password.stillSaysYourPassword) problems.push('DATABASE_URL still has the [YOUR-PASSWORD] placeholder. Replace it with your database password.');
  else if (password.hasSquareBrackets) problems.push('The password in DATABASE_URL has [ ] brackets around it. Remove the brackets.');
  if (url.port !== '6543') problems.push(`DATABASE_URL uses port ${url.port || '(none)'}. Use the Transaction pooler string (port 6543).`);
  if (!url.hostname.endsWith('pooler.supabase.com')) problems.push('DATABASE_URL is not the pooler address. Use Connect → Direct → Transaction pooler.');

  try {
    const { default: postgres } = await import('postgres');
    const sql = postgres(value, { prepare: false, max: 1, connect_timeout: 8, idle_timeout: 1 });
    try {
      await sql`select 1`;
      out.connects = true;
    } finally {
      await sql.end({ timeout: 2 }).catch(() => {});
    }
  } catch (e) {
    out.connects = false;
    const err = e as { code?: string; message?: string };
    out.error = err.code ? `${err.code}: ${err.message}` : err.message;
    if (err.code === '28P01') problems.push('Supabase rejected the database password. The password in DATABASE_URL does not match the one set in Supabase → Database → Settings.');
    else problems.push(`Could not connect to the database (${out.error}).`);
  }
  return out;
}

async function checkStorage(problems: string[]) {
  const endpointRaw = (process.env.S3_ENDPOINT ?? '').trim();
  const keyId = (process.env.S3_ACCESS_KEY_ID ?? '').trim();
  const secret = (process.env.S3_SECRET_ACCESS_KEY ?? '').trim();

  let host: string | null = null;
  let hasPath = false;
  try {
    const u = new URL(endpointRaw);
    host = u.hostname;
    hasPath = u.pathname !== '/' && u.pathname !== '';
  } catch { /* not a URL */ }
  const looksLikeR2 = !!host && /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(host);

  const out: Record<string, unknown> = {
    endpoint: { set: !!endpointRaw, looksLikeR2, host: looksLikeR2 ? host : undefined, hasBucketNameOnTheEnd: hasPath },
    accessKeyId: { length: keyId.length, expected: 32 },
    secretAccessKey: { length: secret.length, expected: 64 },
  };

  if (!looksLikeR2) problems.push('S3_ENDPOINT should look like https://<32 letters/numbers>.r2.cloudflarestorage.com');
  if (hasPath) problems.push('S3_ENDPOINT has something after .com. Delete everything after .com');
  if (keyId.length !== 32) problems.push(`S3_ACCESS_KEY_ID is ${keyId.length} characters; an R2 Access Key ID is 32.`);
  if (secret.length !== 64) problems.push(`S3_SECRET_ACCESS_KEY is ${secret.length} characters; an R2 Secret Access Key is 64.`);

  if (looksLikeR2 && keyId && secret) {
    const client = new S3Client({
      endpoint: endpointRaw, region: process.env.S3_REGION || 'auto',
      credentials: { accessKeyId: keyId, secretAccessKey: secret },
    });
    for (const bucket of [process.env.S3_BUCKET_ORIGINALS || 'polaroid-originals', process.env.S3_BUCKET_WEB || 'polaroid-web']) {
      try {
        await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
        out[bucket] = 'ok';
      } catch (e) {
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        out[bucket] = `${err.name ?? 'Error'} (${err.$metadata?.httpStatusCode ?? '?'})`;
        problems.push(`Storage keys can't open the ${bucket} bucket (${out[bucket]}). Check the R2 token has Object Read & Write on both buckets.`);
      }
    }
  }
  return out;
}
