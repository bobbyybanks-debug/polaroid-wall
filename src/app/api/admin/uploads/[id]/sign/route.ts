import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { apiAdmin } from '@/lib/auth';
import { db, schema } from '@/lib/db';
import { signParts } from '@/lib/storage';

/** Signed URLs for a few parts at a time; the browser sends each part straight to storage. */
export async function POST(req: Request, ctx: RouteContext<'/api/admin/uploads/[id]/sign'>) {
  const admin = await apiAdmin();
  if (admin instanceof Response) return admin;
  const { id } = await ctx.params;
  const parsed = z.object({ parts: z.array(z.number().int().min(1).max(10000)).min(1).max(20) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad request.' }, { status: 400 });
  const d = await db();
  const [u] = await d.select().from(schema.uploads).where(eq(schema.uploads.id, id));
  if (!u || u.status !== 'uploading' || !u.s3UploadId) return Response.json({ error: 'This upload is no longer open.' }, { status: 409 });
  const maxPart = Math.ceil(u.bytes / u.partSize);
  if (parsed.data.parts.some((p) => p > maxPart)) return Response.json({ error: 'Bad part number.' }, { status: 400 });
  return Response.json({ urls: await signParts(u.storageKey, u.s3UploadId, parsed.data.parts) });
}
