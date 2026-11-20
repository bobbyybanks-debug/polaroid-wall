import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { env } from '../env';

/** Long edge of the inline placeholder. */
export const PLACEHOLDER_PX = 20;

type Row = { id: string; copyVersion: string | null; copySizes: number[] | null; placeholder: string | null };

/**
 * Prints made before placeholders existed get one the first time the wall loads them: built from
 * their smallest web copy and saved. Stops after `budgetMs`; the rest follow on a later load.
 */
export async function fillPlaceholders(rows: Row[], budgetMs = 8000): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo = rows.filter((r) => !r.placeholder && r.copyVersion && r.copySizes?.length);
  if (!todo.length) return out;
  const started = Date.now(), base = env().PUBLIC_IMAGE_BASE, d = await db();
  const one = async (r: Row) => {
    const res = await fetch(`${base}/p/${r.id}/${r.copyVersion}/${r.copySizes![0]}.webp`);
    if (!res.ok) return;
    const img = sharp(Buffer.from(await res.arrayBuffer()));
    const { width = 1, height = 1 } = await img.metadata();
    const buf = await img.resize({ width: width >= height ? PLACEHOLDER_PX : undefined, height: height > width ? PLACEHOLDER_PX : undefined }).webp({ quality: 50 }).toBuffer();
    const ph = `data:image/webp;base64,${buf.toString('base64')}`;
    await d.update(schema.prints).set({ placeholder: ph }).where(eq(schema.prints.id, r.id));
    out.set(r.id, ph);
  };
  const queue = [...todo];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      if (Date.now() - started > budgetMs) return;
      try { await one(r); } catch { /* try again next time */ }
    }
  }));
  return out;
}
