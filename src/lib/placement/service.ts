/**
 * Layout versions and placements.
 *
 * There is always one draft version: the working copy the placement editor edits.
 * Publishing snapshots the draft into a new published version (immutable) and archives the
 * previous one, so any publish can be rolled back. Visitors only ever see the published one.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { env } from '../env';
import { FILM_LONG_MM, PX_PER_MM } from '../processing/detect';
import { relax, suggest, type Placed } from './placer';
import type { Print } from '../db/schema';

export const LARGE = 1.5;
const FRAME_V1 = { x: 0, y: 0, w: 2160, h: 1290 };

/** The print's box on the wall at standard size: 232 px per 108 mm, scan's own aspect. */
export function boxFor(p: Pick<Print, 'film' | 'widthPx' | 'heightPx'>) {
  const long = FILM_LONG_MM[p.film] * PX_PER_MM;
  const w = p.widthPx ?? 4, h = p.heightPx ?? 3;
  return w >= h ? { w: long, h: Math.round((long * h / w) * 10) / 10 } : { w: Math.round((long * w / h) * 10) / 10, h: long };
}

export async function draftVersion(): Promise<number> {
  const d = await db();
  const [draft] = await d.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.status, 'draft')).limit(1);
  if (draft) return draft.id;
  const [pub] = await d.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.status, 'published')).limit(1);
  const [v] = await d.insert(schema.layoutVersions).values({ status: 'draft', frame: pub?.frame ?? FRAME_V1 }).returning();
  if (pub) {
    const rows = await d.select().from(schema.placements).where(eq(schema.placements.versionId, pub.id));
    if (rows.length) {
      await d.insert(schema.placements).values(rows.map(({ id: _omit, ...r }) => ({ ...r, versionId: v.id, locked: true })));
    }
  }
  return v.id;
}

async function placedWithBoxes(versionId: number): Promise<Placed[]> {
  const d = await db();
  const rows = await d.select({ pl: schema.placements, pr: schema.prints }).from(schema.placements)
    .innerJoin(schema.prints, eq(schema.prints.id, schema.placements.printId))
    .where(eq(schema.placements.versionId, versionId));
  return rows.map(({ pl, pr }) => {
    const b = boxFor(pr), k = pl.size === 'large' ? LARGE : 1;
    return { id: pr.id, x: pl.x, y: pl.y, w: b.w * k, h: b.h * k, rotation: pl.rotation, large: pl.size === 'large', layer: pl.layer };
  });
}

async function maxOverlap(): Promise<number> {
  const d = await db();
  const [row] = await d.select().from(schema.settings).where(eq(schema.settings.key, 'allowOverlap'));
  // Overlap is opt-in: by default every print keeps clear space around it.
  return row && row.value === true ? 0.12 : 0;
}

/** Add a ready print to the draft at its suggested spot (no-op if it's already there). */
export async function suggestPlacement(printId: string) {
  const d = await db();
  const vid = await draftVersion();
  const [exists] = await d.select({ id: schema.placements.id }).from(schema.placements)
    .where(and(eq(schema.placements.versionId, vid), eq(schema.placements.printId, printId)));
  if (exists) return;
  const [p] = await d.select().from(schema.prints).where(eq(schema.prints.id, printId));
  if (!p) return;
  const wall = await placedWithBoxes(vid);
  const s = suggest(p.id, boxFor(p), wall, { maxOverlap: await maxOverlap() });
  const size = s.large ? 'large' : 'standard';
  await d.insert(schema.placements).values({
    versionId: vid, printId, x: s.x, y: s.y, rotation: s.rotation, size, layer: s.layer,
    locked: false, source: 'suggested', suggested: { x: s.x, y: s.y, rotation: s.rotation, size },
  });
}

/** Re-run the suggestion for a draft print (Reset to suggestion / after a size change). */
export async function resuggest(printId: string, forceSize?: 'standard' | 'large') {
  const d = await db();
  const vid = await draftVersion();
  await d.delete(schema.placements).where(and(eq(schema.placements.versionId, vid), eq(schema.placements.printId, printId)));
  const [p] = await d.select().from(schema.prints).where(eq(schema.prints.id, printId));
  const wall = await placedWithBoxes(vid);
  const s = suggest(p.id, boxFor(p), wall, { maxOverlap: await maxOverlap() }, forceSize ? forceSize === 'large' : undefined);
  const size = s.large ? 'large' : 'standard';
  await d.insert(schema.placements).values({
    versionId: vid, printId, x: s.x, y: s.y, rotation: s.rotation, size, layer: s.layer,
    locked: false, source: forceSize ? 'manual' : 'suggested', suggested: { x: s.x, y: s.y, rotation: s.rotation, size },
  });
}

export type PlacementPatch = Partial<{ x: number; y: number; rotation: number; size: 'standard' | 'large'; layer: number; locked: boolean }>;

export async function updatePlacement(printId: string, patch: PlacementPatch) {
  const d = await db();
  const vid = await draftVersion();
  await d.update(schema.placements).set({ ...patch, source: 'manual', updatedAt: new Date() })
    .where(and(eq(schema.placements.versionId, vid), eq(schema.placements.printId, printId)));
}

export async function removeFromWall(printId: string) {
  const d = await db();
  const vid = await draftVersion();
  await d.delete(schema.placements).where(and(eq(schema.placements.versionId, vid), eq(schema.placements.printId, printId)));
}

/** Layer order: 'front' puts the print above everything, 'back' below. */
export async function restack(printId: string, to: 'front' | 'back') {
  const d = await db();
  const vid = await draftVersion();
  const rows = await d.select({ printId: schema.placements.printId, layer: schema.placements.layer }).from(schema.placements).where(eq(schema.placements.versionId, vid));
  const layers = rows.map((r) => r.layer);
  const layer = to === 'front' ? Math.max(...layers) + 1 : Math.min(...layers) - 1;
  await updatePlacement(printId, { layer });
}

/** Draft vs published: what Publish would change. */
export async function pendingChanges() {
  const d = await db();
  const vid = await draftVersion();
  const [pub] = await d.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.status, 'published')).limit(1);
  const draft = await d.select().from(schema.placements).where(eq(schema.placements.versionId, vid));
  const live = pub ? await d.select().from(schema.placements).where(eq(schema.placements.versionId, pub.id)) : [];
  const liveBy = new Map(live.map((p) => [p.printId, p]));
  const draftIds = new Set(draft.map((p) => p.printId));
  let added = 0, edited = 0;
  for (const p of draft) {
    const l = liveBy.get(p.printId);
    if (!l) added++;
    else if (l.x !== p.x || l.y !== p.y || l.rotation !== p.rotation || l.size !== p.size || l.layer !== p.layer) edited++;
  }
  const removed = live.filter((l) => !draftIds.has(l.printId)).length;
  return { added, edited, removed, total: added + edited + removed };
}

export async function publish(note?: string) {
  const d = await db();
  const vid = await draftVersion();
  const draft = await d.select({ pl: schema.placements, st: schema.prints.status }).from(schema.placements)
    .innerJoin(schema.prints, eq(schema.prints.id, schema.placements.printId))
    .where(eq(schema.placements.versionId, vid));
  // Only prints whose web copies are ready go live.
  const ready = draft.filter((r) => r.st === 'ready' || r.st === 'needs_attention').map((r) => r.pl);
  const [prev] = await d.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.status, 'published')).limit(1);
  const [draftRow] = await d.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.id, vid));
  // The opening view frames the whole published wall (plus a margin), so it grows with the wall
  // and only changes when the wall's outline does.
  const liveBoxes = (await placedWithBoxes(vid)).filter((b) => ready.some((r) => r.printId === b.id));
  const frame = liveBoxes.length ? frameAround(liveBoxes) : { ...(prev?.frame ?? draftRow.frame) };
  return d.transaction(async (tx) => {
    if (prev) await tx.update(schema.layoutVersions).set({ status: 'archived' }).where(eq(schema.layoutVersions.id, prev.id));
    const [v] = await tx.insert(schema.layoutVersions).values({ status: 'published', frame, note: note ?? null, publishedAt: new Date() }).returning();
    if (ready.length) {
      await tx.insert(schema.placements).values(ready.map(({ id: _omit, ...r }) => ({ ...r, versionId: v.id, locked: true })));
    }
    // Everything that just went live is locked in the draft too.
    await tx.update(schema.placements).set({ locked: true }).where(and(eq(schema.placements.versionId, vid), inArray(schema.placements.printId, ready.map((r) => r.printId).concat(['00000000-0000-0000-0000-000000000000']))));
    await tx.update(schema.layoutVersions).set({ frame }).where(eq(schema.layoutVersions.id, vid));
    return { versionId: v.id, count: ready.length };
  });
}

const FRAME_MARGIN = 120;
function frameAround(boxes: Placed[]) {
  const b = boxes.reduce((r, p) => ({
    x0: Math.min(r.x0, p.x - p.w / 2), y0: Math.min(r.y0, p.y - p.h / 2), x1: Math.max(r.x1, p.x + p.w / 2), y1: Math.max(r.y1, p.y + p.h / 2),
  }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  const x = Math.round(b.x0 - FRAME_MARGIN), y = Math.round(b.y0 - FRAME_MARGIN);
  return { x, y, w: Math.round(b.x1 + FRAME_MARGIN) - x, h: Math.round(b.y1 + FRAME_MARGIN) - y };
}

/**
 * Give the whole draft wall more (factor > 1) or less (< 1) room: every print moves away from or
 * towards the wall's centre; sizes and rotations stay. Published prints move too, as edits that
 * only go live on Publish.
 */
export async function spread(factor: number) {
  const d = await db();
  const vid = await draftVersion();
  const rows = await d.select({ id: schema.placements.id, x: schema.placements.x, y: schema.placements.y })
    .from(schema.placements).where(eq(schema.placements.versionId, vid));
  if (rows.length < 2) return;
  const cx = rows.reduce((s, r) => s + r.x, 0) / rows.length, cy = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  await d.transaction(async (tx) => {
    for (const r of rows) {
      await tx.update(schema.placements)
        .set({ x: Math.round(cx + (r.x - cx) * factor), y: Math.round(cy + (r.y - cy) * factor), updatedAt: new Date() })
        .where(eq(schema.placements.id, r.id));
    }
  });
}

/** Nudge every draft print apart so none overlap and each has clear space (see relax()). */
export async function makeRoom() {
  const d = await db();
  const vid = await draftVersion();
  const wall = await placedWithBoxes(vid);
  if (wall.length < 2) return 0;
  const pos = relax(wall);
  const moved = wall.filter((p) => { const q = pos.get(p.id)!; return q.x !== Math.round(p.x) || q.y !== Math.round(p.y); });
  await d.transaction(async (tx) => {
    for (const p of moved) {
      const q = pos.get(p.id)!;
      await tx.update(schema.placements).set({ x: q.x, y: q.y, updatedAt: new Date() })
        .where(and(eq(schema.placements.versionId, vid), eq(schema.placements.printId, p.id)));
    }
  });
  return moved.length;
}

/** Make an older version live again (as a new version, so nothing is lost). */
export async function rollbackTo(versionId: number) {
  const d = await db();
  const [old] = await d.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.id, versionId));
  if (!old || old.status === 'draft') throw new Error('Can only roll back to a published version.');
  const rows = await d.select().from(schema.placements).where(eq(schema.placements.versionId, versionId));
  const vid = await draftVersion();
  return d.transaction(async (tx) => {
    await tx.update(schema.layoutVersions).set({ status: 'archived' }).where(eq(schema.layoutVersions.status, 'published'));
    const [v] = await tx.insert(schema.layoutVersions).values({ status: 'published', frame: old.frame, note: `Rolled back to version ${versionId}`, publishedAt: new Date() }).returning();
    if (rows.length) await tx.insert(schema.placements).values(rows.map(({ id: _omit, ...r }) => ({ ...r, versionId: v.id })));
    // The draft follows: published prints return to their old spots; unpublished drafts stay.
    const liveIds = rows.map((r) => r.printId);
    if (liveIds.length) await tx.delete(schema.placements).where(and(eq(schema.placements.versionId, vid), inArray(schema.placements.printId, liveIds)));
    if (rows.length) await tx.insert(schema.placements).values(rows.map(({ id: _omit, ...r }) => ({ ...r, versionId: vid, locked: true })));
    return v.id;
  });
}

export async function versions() {
  const d = await db();
  return d.select().from(schema.layoutVersions).orderBy(desc(schema.layoutVersions.id)).limit(30);
}

/* ---------- Layout JSON for the wall renderer ---------- */

export type WallPrint = {
  id: string; n: string;
  x: number; y: number; w: number; h: number; r: number; L: boolean; z: number;
  /** Base URL of this print's copies: `${src}/${size}.avif|webp`. */
  src: string; sizes: number[];
  /** Pixel size of the largest copy (viewer 1:1 limit). */
  iw: number; ih: number;
  status?: string; locked?: boolean; source?: string; draft?: boolean;
};
export type WallLayout = { version: number; frame: { x: number; y: number; w: number; h: number }; prints: WallPrint[] };

async function layoutFor(versionId: number, withEditorFields: boolean, livePrintIds?: Set<string>): Promise<WallLayout> {
  const d = await db();
  const [v] = await d.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.id, versionId));
  const rows = await d.select({ pl: schema.placements, pr: schema.prints }).from(schema.placements)
    .innerJoin(schema.prints, eq(schema.prints.id, schema.placements.printId))
    .where(eq(schema.placements.versionId, versionId));
  const base = env().PUBLIC_IMAGE_BASE;
  const prints = rows
    .filter(({ pr }) => withEditorFields || pr.copyVersion)
    .sort((a, b) => a.pl.layer - b.pl.layer)
    .map(({ pl, pr }): WallPrint => {
      const b = boxFor(pr), k = pl.size === 'large' ? LARGE : 1;
      const sizes = pr.copySizes ?? [];
      const top = sizes[sizes.length - 1] ?? 0;
      const long = Math.max(pr.widthPx ?? 1, pr.heightPx ?? 1);
      const iw = Math.round(((pr.widthPx ?? 1) / long) * top), ih = Math.round(((pr.heightPx ?? 1) / long) * top);
      const wp: WallPrint = {
        id: pr.id, n: pr.number, x: pl.x, y: pl.y, w: Math.round(b.w * k * 10) / 10, h: Math.round(b.h * k * 10) / 10,
        r: pl.rotation, L: pl.size === 'large', z: pl.layer,
        src: pr.copyVersion ? `${base}/p/${pr.id}/${pr.copyVersion}` : '', sizes, iw, ih,
      };
      if (withEditorFields) Object.assign(wp, { status: pr.status, locked: pl.locked, source: pl.source, draft: livePrintIds ? !livePrintIds.has(pr.id) : false });
      return wp;
    });
  return { version: versionId, frame: v.frame, prints };
}

export async function publishedLayout(): Promise<WallLayout | null> {
  const d = await db();
  const [v] = await d.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.status, 'published')).limit(1);
  return v ? layoutFor(v.id, false) : null;
}

export async function draftLayout(): Promise<WallLayout> {
  const d = await db();
  const vid = await draftVersion();
  const [pub] = await d.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.status, 'published')).limit(1);
  const live = pub ? new Set((await d.select({ id: schema.placements.printId }).from(schema.placements).where(eq(schema.placements.versionId, pub.id))).map((r) => r.id)) : new Set<string>();
  return layoutFor(vid, true, live);
}
