import 'server-only';
import { and, eq, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
import { db, schema } from './db';

/**
 * Prints whose web copies are cropped although they shouldn't be: regular scans (JPEG/TIFF) with
 * no trim whose copy isn't the whole scan. Left over from the Nov 18 auto-fit, which cut the
 * border off some tight scans; new uploads never end up here.
 */
export async function staleCopies() {
  const d = await db();
  return d.select({ id: schema.prints.id, number: schema.prints.number, issue: schema.prints.issue })
    .from(schema.prints)
    .innerJoin(schema.originals, eq(schema.originals.id, schema.prints.originalId))
    .leftJoin(schema.cleanup, eq(schema.cleanup.printId, schema.prints.id))
    .where(and(
      notInArray(schema.prints.status, ['processing', 'failed']),
      inArray(schema.originals.mime, ['image/jpeg', 'image/tiff']),
      or(isNull(schema.cleanup.mode), eq(schema.cleanup.mode, 'off')),
      or(ne(schema.prints.widthPx, schema.originals.width), ne(schema.prints.heightPx, schema.originals.height)),
    ))
    .orderBy(schema.prints.number);
}
