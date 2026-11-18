import { PutBucketCorsCommand, PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import { apiAdmin } from '@/lib/auth';
import { db, schema } from '@/lib/db';
import { env } from '@/lib/env';
import { buckets, s3 } from '@/lib/storage';

/**
 * One-time storage rules, applied with the app's own keys:
 * - originals bucket: the browser may PUT upload parts from this site and read their ETags;
 *   unfinished uploads are cleared after 7 days.
 * - web bucket: anyone may GET (images on the wall).
 */
export async function POST() {
  const admin = await apiAdmin();
  if (admin instanceof Response) return admin;
  const origin = new URL(env().SITE_URL).origin;
  const origins = [...new Set([origin, 'http://localhost:3000', ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : [])])];
  await s3().send(new PutBucketCorsCommand({
    Bucket: buckets().originals,
    CORSConfiguration: { CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }] },
  }));
  await s3().send(new PutBucketLifecycleConfigurationCommand({
    Bucket: buckets().originals,
    LifecycleConfiguration: { Rules: [{ ID: 'abort-unfinished-uploads', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }] },
  }));
  await s3().send(new PutBucketCorsCommand({
    Bucket: buckets().web,
    CORSConfiguration: { CORSRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['*'], MaxAgeSeconds: 86400 }] },
  }));
  const d = await db();
  await d.insert(schema.settings).values({ key: 'storageSetup', value: { at: new Date().toISOString(), origins } })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: { at: new Date().toISOString(), origins } } });
  return Response.json({ ok: true, origins });
}
