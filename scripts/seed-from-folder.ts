/**
 * Import a folder of original scans straight into the archive (same pipeline as the dashboard),
 * then optionally lay them out exactly as the approved Figma wall and publish that as version 1.
 *
 *   npx tsx --env-file=.env.local scripts/seed-from-folder.ts <folder> [--figma-layout scripts/figma-layout.json] [--publish]
 *
 * Used for local testing. In production, upload through the dashboard instead.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../src/lib/db';
import { putOriginal, originalKey } from '../src/lib/storage';
import { analyzeOriginal, processPrint } from '../src/lib/processing/pipeline';
import { draftVersion, publish } from '../src/lib/placement/service';

const args = process.argv.slice(2);
const folder = args[0];
const layoutFile = args.includes('--figma-layout') ? args[args.indexOf('--figma-layout') + 1] : null;
const doPublish = args.includes('--publish');

(async () => {
  const d = await db();
  const files = (await fs.readdir(folder)).filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f)).sort();
  console.log(`Importing ${files.length} scans from ${folder}`);
  for (const f of files) {
    const buf = await fs.readFile(path.join(folder, f));
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const [dupe] = await d.select().from(schema.originals).where(eq(schema.originals.sha256, sha256));
    if (dupe) { console.log(`  ${f}: already imported`); continue; }
    const id = crypto.randomUUID();
    const key = originalKey(id, f);
    const mime = /png$/i.test(f) ? 'image/png' : /tiff?$/i.test(f) ? 'image/tiff' : 'image/jpeg';
    await putOriginal(key, buf, mime);
    const [o] = await d.insert(schema.originals).values({ storageKey: key, filename: f, bytes: buf.length, sha256, mime }).returning();
    const t0 = Date.now();
    const prints = await analyzeOriginal(o.id, { expectedSha256: sha256 });
    for (const p of prints) await processPrint(p);
    console.log(`  ${f}: ${prints.length} print(s), ${Date.now() - t0} ms`);
  }

  if (layoutFile) {
    // Figma export: [name, w, h, a, b, c, d, e, f] per print ("Print 096", "Large 100").
    const raw = JSON.parse(await fs.readFile(layoutFile, 'utf8')) as { prints: [string, number, number, number, number, number, number, number, number][] };
    const vid = await draftVersion();
    const all = await d.select().from(schema.prints);
    const byNumber = new Map(all.map((p) => [p.number, p]));
    const keep = new Set<string>();
    let layer = 0;
    for (const [name, w, h, a, b, c, dd, e, f] of raw.prints) {
      const [kind, num] = name.split(' ');
      const p = byNumber.get(num);
      if (!p) { console.warn(`  layout: no print ${num}`); continue; }
      keep.add(p.id);
      const x = a * w / 2 + c * h / 2 + e, y = b * w / 2 + dd * h / 2 + f;
      const rotation = Math.round((Math.atan2(b, a) * 180 / Math.PI) * 100) / 100;
      const size = kind === 'Large' ? 'large' as const : 'standard' as const;
      const values = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, rotation, size, layer: ++layer, locked: false, source: 'manual' as const };
      const [ex] = await d.select().from(schema.placements).where(and(eq(schema.placements.versionId, vid), eq(schema.placements.printId, p.id)));
      if (ex) await d.update(schema.placements).set(values).where(eq(schema.placements.id, ex.id));
      else await d.insert(schema.placements).values({ versionId: vid, printId: p.id, ...values });
      if (p.status === 'duplicate') console.warn(`  layout: ${num} was marked duplicate but is on the approved wall`);
    }
    for (const pl of await d.select().from(schema.placements).where(eq(schema.placements.versionId, vid))) {
      if (!keep.has(pl.printId)) await d.delete(schema.placements).where(eq(schema.placements.id, pl.id));
    }
    console.log(`Applied the approved layout: ${keep.size} prints.`);
  }
  if (doPublish) {
    const r = await publish('Approved Figma wall');
    console.log(`Published version ${r.versionId} with ${r.count} prints.`);
  }
  const summary = await d.select({ number: schema.prints.number, status: schema.prints.status, issue: schema.prints.issue }).from(schema.prints);
  for (const s of summary.filter((x) => x.status !== 'ready')) console.log(`  ${s.number}: ${s.status} — ${s.issue}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
