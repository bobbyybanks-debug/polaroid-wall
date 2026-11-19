import { revalidateTag } from 'next/cache';
import { eq } from 'drizzle-orm';
import { apiAdmin } from '@/lib/auth';
import { db, schema } from '@/lib/db';
import { staleCopies } from '@/lib/maintenance';
import { processPrint } from '@/lib/processing/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Set by processPrint when the copy wasn't print-shaped; a full re-run checks it again. */
const SHAPE_ISSUE = "Doesn't look like a whole Instax print";

/**
 * Rebuild the web copies that were cropped by the old auto-fit, so they match the original scan
 * (Library: "Refresh copies"). Only the copies change, except for prints flagged "not a whole
 * print" because of that crop: those are checked again in full (shape, duplicates, placement).
 * Works through as many prints as fit in ~4 minutes and reports how many are left.
 */
async function run() {
  const admin = await apiAdmin();
  if (admin instanceof Response) return admin;
  const d = await db();
  const todo = await staleCopies();

  const started = Date.now();
  const refreshed: string[] = [], failed: { number: string; error: string }[] = [];
  for (const p of todo) {
    if (Date.now() - started > 240_000) break;
    try {
      if (p.issue?.startsWith(SHAPE_ISSUE)) {
        await d.update(schema.prints).set({ issue: null, updatedAt: new Date() }).where(eq(schema.prints.id, p.id));
        await processPrint(p.id);
      } else {
        await processPrint(p.id, { copiesOnly: true });
      }
      refreshed.push(p.number);
    } catch (e) {
      failed.push({ number: p.number, error: (e as Error).message?.split('\n')[0].slice(0, 200) ?? String(e) });
    }
    revalidateTag('layout', { expire: 0 }); // old copies are deleted, so the wall must not serve them
  }

  const remaining = todo.length - refreshed.length - failed.length;
  return Response.json({
    message: remaining > 0 ? `Refreshed ${refreshed.length}. ${remaining} left: reload this page to continue.` : `Done. Refreshed ${refreshed.length} print${refreshed.length === 1 ? '' : 's'}.`,
    refreshed, failed, remaining,
  }, { headers: { 'cache-control': 'no-store' } });
}

export const GET = run;
export const POST = run;
