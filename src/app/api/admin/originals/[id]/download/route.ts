import { eq } from 'drizzle-orm';
import { apiAdmin } from '@/lib/auth';
import { db, schema } from '@/lib/db';
import { signedOriginalDownload } from '@/lib/storage';

/** Download the untouched original through a 10-minute signed link, with its original filename. */
export async function GET(_req: Request, ctx: RouteContext<'/api/admin/originals/[id]/download'>) {
  const admin = await apiAdmin();
  if (admin instanceof Response) return admin;
  const { id } = await ctx.params;
  const d = await db();
  const [o] = await d.select().from(schema.originals).where(eq(schema.originals.id, id));
  if (!o) return Response.json({ error: 'Not found.' }, { status: 404 });
  return Response.redirect(await signedOriginalDownload(o.storageKey, o.filename), 302);
}
