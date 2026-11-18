import { PutBucketCorsCommand, PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import { apiAdmin } from '@/lib/auth';
import { db, schema } from '@/lib/db';
import { env } from '@/lib/env';
import { buckets, s3 } from '@/lib/storage';

const denied = (e: unknown) => {
  const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === 'AccessDenied' || err.Code === 'AccessDenied' || err.$metadata?.httpStatusCode === 403;
};

/**
 * One-time storage rules:
 * - originals bucket: the browser may PUT upload parts from this site and read their ETags;
 *   unfinished uploads are cleared after 7 days (R2 also has this as a default rule).
 * - web bucket: anyone may GET (images on the wall load as plain <img>, so this is a nicety).
 *
 * A bucket-scoped R2 key ("Object Read & Write") can't change bucket settings. In that case the
 * response carries the CORS rule to paste in the Cloudflare dashboard, and a second call with
 * { manual: true } records that it was done there.
 */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof Response) return admin;
  const body = (await req.json().catch(() => ({}))) as { manual?: boolean };

  const origin = new URL(env().SITE_URL).origin;
  const origins = [...new Set([origin, 'http://localhost:3000', ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : [])])];
  const rule = { AllowedOrigins: origins, AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 };

  let how: 'api' | 'dashboard' = 'api';
  if (body.manual) {
    how = 'dashboard';
  } else {
    try {
      await s3().send(new PutBucketCorsCommand({ Bucket: buckets().originals, CORSConfiguration: { CORSRules: [rule] } }));
    } catch (e) {
      if (!denied(e)) throw e;
      return Response.json({
        ok: false,
        manual: true,
        bucket: buckets().originals,
        message: `Your R2 key can only read and write files, not change bucket settings. Add this CORS policy in Cloudflare → R2 → ${buckets().originals} → Settings → CORS Policy, then click “I’ve added it”.`,
        cors: [{ ...rule, AllowedOrigins: [origin] }],
      }, { status: 409 });
    }
    // Best effort: R2 already aborts unfinished multipart uploads after 7 days by default.
    await s3().send(new PutBucketLifecycleConfigurationCommand({
      Bucket: buckets().originals,
      LifecycleConfiguration: { Rules: [{ ID: 'abort-unfinished-uploads', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }] },
    })).catch(() => {});
    await s3().send(new PutBucketCorsCommand({
      Bucket: buckets().web,
      CORSConfiguration: { CORSRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['*'], MaxAgeSeconds: 86400 }] },
    })).catch(() => {});
  }

  const value = { at: new Date().toISOString(), origins, how };
  const d = await db();
  await d.insert(schema.settings).values({ key: 'storageSetup', value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
  return Response.json({ ok: true, origins, how });
}
