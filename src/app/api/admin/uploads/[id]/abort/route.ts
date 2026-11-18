import { eq } from 'drizzle-orm';
import { apiAdmin } from '@/lib/auth';
import { db, schema } from '@/lib/db';
import { abortMultipart } from '@/lib/storage';

/** Cancel: drop the parts already sent. Nothing reaches the library or the wall. */
export async function POST(_req: Request, ctx: RouteContext<'/api/admin/uploads/[id]/abort'>) {
  const admin = await apiAdmin();
  if (admin instanceof Response) return admin;
  const { id } = await ctx.params;
  const d = await db();
  const [u] = await d.select().from(schema.uploads).where(eq(schema.uploads.id, id));
  if (u?.status === 'uploading' && u.s3UploadId) {
    try { await abortMultipart(u.storageKey, u.s3UploadId); } catch { /* already gone */ }
    await d.update(schema.uploads).set({ status: 'aborted', updatedAt: new Date() }).where(eq(schema.uploads.id, id));
  }
  return Response.json({ ok: true });
}
