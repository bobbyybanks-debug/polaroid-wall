import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { apiAdmin } from '@/lib/auth';
import { db, schema } from '@/lib/db';

/** Exact-duplicate check: which of these checksums are already in the library? */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof Response) return admin;
  const parsed = z.object({ sha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(1000) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad request.' }, { status: 400 });
  if (!parsed.data.sha256.length) return Response.json({ matches: [] });
  const d = await db();
  const rows = await d.select({
    sha256: schema.originals.sha256, filename: schema.originals.filename, number: schema.prints.number, printId: schema.prints.id,
  }).from(schema.originals)
    .leftJoin(schema.prints, eq(schema.prints.originalId, schema.originals.id))
    .where(inArray(schema.originals.sha256, parsed.data.sha256));
  return Response.json({ matches: rows });
}
