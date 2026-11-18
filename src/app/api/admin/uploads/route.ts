import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { apiAdmin } from '@/lib/auth';
import { db, schema } from '@/lib/db';
import { LIMITS, MIME, checkSize, checkDimensions, type Kind } from '@/lib/limits';
import { createMultipart, listParts, originalKey } from '@/lib/storage';

const Body = z.object({
  batchId: z.string().uuid(),
  filename: z.string().min(1).max(300),
  bytes: z.number().int().positive(),
  kind: z.enum(['jpeg', 'png', 'tiff']),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

/**
 * Start (or resume) the upload of one original. The checks the browser already ran are
 * repeated here; the worker checks again after a full decode.
 */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof Response) return admin;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad request.' }, { status: 400 });
  const b = parsed.data;
  const err = checkSize(b.filename, b.kind as Kind, b.bytes) ?? (b.width && b.height ? checkDimensions(b.filename, b.width, b.height) : null);
  if (err) return Response.json({ error: err }, { status: 422 });

  const d = await db();
  // Same file, same size, still in flight → resume it instead of starting over.
  const [pending] = await d.select().from(schema.uploads)
    .where(and(eq(schema.uploads.sha256, b.sha256), eq(schema.uploads.bytes, b.bytes), eq(schema.uploads.status, 'uploading')));
  if (pending?.s3UploadId) {
    try {
      const parts = await listParts(pending.storageKey, pending.s3UploadId);
      return Response.json({ id: pending.id, partSize: pending.partSize, done: parts.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size })) });
    } catch { /* the multipart upload expired: start a fresh one below */ }
    await d.update(schema.uploads).set({ status: 'aborted', updatedAt: new Date() }).where(eq(schema.uploads.id, pending.id));
  }

  const id = crypto.randomUUID();
  const key = originalKey(id, b.filename);
  const s3UploadId = await createMultipart(key, MIME[b.kind as Kind], {
    'original-filename': encodeURIComponent(b.filename).slice(0, 1000), sha256: b.sha256,
  });
  await d.insert(schema.uploads).values({
    id, batchId: b.batchId, filename: b.filename, bytes: b.bytes, mime: MIME[b.kind as Kind], sha256: b.sha256,
    storageKey: key, s3UploadId, partSize: LIMITS.partSize, status: 'uploading',
  });
  return Response.json({ id, partSize: LIMITS.partSize, done: [] });
}
