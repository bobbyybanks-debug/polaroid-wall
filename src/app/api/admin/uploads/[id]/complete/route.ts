import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { apiAdmin } from '@/lib/auth';
import { db, schema } from '@/lib/db';
import { completeMultipart, headOriginal, listParts } from '@/lib/storage';
import { enqueue } from '@/lib/jobs';

export const maxDuration = 300;

/** All parts are in: assemble the file, check its size, record the original, start processing. */
export async function POST(req: Request, ctx: RouteContext<'/api/admin/uploads/[id]/complete'>) {
  const admin = await apiAdmin();
  if (admin instanceof Response) return admin;
  const { id } = await ctx.params;
  const parsed = z.object({ parts: z.array(z.object({ PartNumber: z.number().int(), ETag: z.string() })).optional() }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: 'Bad request.' }, { status: 400 });
  const d = await db();
  const [u] = await d.select().from(schema.uploads).where(eq(schema.uploads.id, id));
  if (!u) return Response.json({ error: 'Upload not found.' }, { status: 404 });
  if (u.status !== 'uploading' || !u.s3UploadId) return Response.json({ ok: true, status: u.status });

  // Trust storage, not the browser, for the part list.
  const parts = await listParts(u.storageKey, u.s3UploadId);
  const expected = Math.ceil(u.bytes / u.partSize);
  if (parts.length !== expected) {
    return Response.json({ error: `${u.filename}: ${parts.length} of ${expected} parts arrived. Retry to send the rest.` }, { status: 409 });
  }
  await completeMultipart(u.storageKey, u.s3UploadId, parts.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })));
  const head = await headOriginal(u.storageKey);
  if (head.ContentLength !== u.bytes) {
    await d.update(schema.uploads).set({ status: 'failed', error: `${u.filename} arrived at the wrong size. Upload it again.`, updatedAt: new Date() }).where(eq(schema.uploads.id, id));
    return Response.json({ error: 'Size mismatch.' }, { status: 422 });
  }
  const [orig] = await d.insert(schema.originals).values({
    storageKey: u.storageKey, filename: u.filename, bytes: u.bytes, sha256: u.sha256, mime: u.mime,
  }).returning({ id: schema.originals.id });
  await d.update(schema.uploads).set({ status: 'processing', originalId: orig.id, partsDone: parts.length, updatedAt: new Date() }).where(eq(schema.uploads.id, id));
  await enqueue('ingest-upload', id);
  return Response.json({ ok: true, status: 'processing' });
}
