import { revalidateTag } from 'next/cache';
import { eq, notInArray } from 'drizzle-orm';
import { apiAdmin } from '@/lib/auth';
import { db, schema } from '@/lib/db';
import { processPrint } from '@/lib/processing/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const DONE_KEY = 'copiesRefreshed:autofit-v1';

/**
 * One-off maintenance: rebuild every print's web copies with the current pipeline (transparent
 * edges white, crooked scans straightened and cropped to the print's own edges). Prints whose
 * copies wouldn't change are skipped quickly. Only the copies change: status, duplicates and
 * placement stay. Works through as many prints as fit in ~4 minutes; open it again if it says
 * some are left.
 */
export async function GET() {
  const admin = await apiAdmin();
  if (admin instanceof Response) return admin;
  const d = await db();

  const [row] = await d.select().from(schema.settings).where(eq(schema.settings.key, DONE_KEY));
  const done = new Set<string>(Array.isArray(row?.value) ? (row.value as string[]) : []);

  const candidates = await d.select({ id: schema.prints.id, number: schema.prints.number })
    .from(schema.prints)
    .where(notInArray(schema.prints.status, ['processing', 'failed']));
  const todo = candidates.filter((c) => !done.has(c.id));

  const started = Date.now();
  const refreshed: string[] = [], failed: { number: string; error: string }[] = [];
  for (const p of todo) {
    if (Date.now() - started > 240_000) break;
    try {
      await processPrint(p.id, { copiesOnly: true });
      refreshed.push(p.number);
    } catch (e) {
      failed.push({ number: p.number, error: (e as Error).message?.split('\n')[0].slice(0, 200) ?? String(e) });
    }
    done.add(p.id); // failures are reported once, not retried forever
    const value = [...done];
    await d.insert(schema.settings).values({ key: DONE_KEY, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
    revalidateTag('layout', { expire: 0 }); // old copies are deleted, so the wall must not serve them
  }

  const remaining = todo.length - refreshed.length - failed.length;
  return Response.json({
    message: remaining > 0 ? `Refreshed ${refreshed.length}. ${remaining} left: reload this page to continue.` : `Done. Refreshed ${refreshed.length} print${refreshed.length === 1 ? '' : 's'}.`,
    refreshed, failed, remaining,
  }, { headers: { 'cache-control': 'no-store' } });
}
