import 'server-only';
import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import { db, schema } from './db';
import { env } from './env';
import { draftVersion } from './placement/service';

export type LibraryRow = {
  id: string; number: string; filename: string; originalId: string; mime: string; bytes: number;
  width: number | null; height: number | null; status: string; issue: string | null;
  thumb: string | null; wall: 'published' | 'unpublished' | 'off'; size: 'standard' | 'large' | null;
  duplicateOf: string | null; createdAt: string;
};
export type UploadRow = { id: string; filename: string; bytes: number; status: string; error: string | null; updatedAt: string };
export type LibraryData = {
  rows: LibraryRow[]; uploads: UploadRow[];
  stats: { prints: number; scans: number; originalBytes: number; lastPublished: string | null };
  storageReady: boolean;
};

const thumbUrl = (id: string, version: string | null, sizes: number[] | null) =>
  version && sizes?.length ? `${env().PUBLIC_IMAGE_BASE}/p/${id}/${version}/${sizes[0]}.webp` : null;

export async function libraryData(): Promise<LibraryData> {
  const d = await db();
  const vid = await draftVersion();
  const [pub] = await d.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.status, 'published')).limit(1);
  const live = new Set(pub ? (await d.select({ id: schema.placements.printId }).from(schema.placements).where(eq(schema.placements.versionId, pub.id))).map((r) => r.id) : []);
  const draft = new Map((await d.select({ id: schema.placements.printId, size: schema.placements.size }).from(schema.placements).where(eq(schema.placements.versionId, vid))).map((r) => [r.id, r.size]));
  const rows = await d.select({ p: schema.prints, o: schema.originals }).from(schema.prints)
    .innerJoin(schema.originals, eq(schema.originals.id, schema.prints.originalId))
    .orderBy(desc(schema.prints.createdAt), desc(schema.prints.number));
  const numbers = new Map(rows.map(({ p }) => [p.id, p.number]));
  const out: LibraryRow[] = rows.map(({ p, o }) => ({
    id: p.id, number: p.number, filename: o.filename, originalId: o.id, mime: o.mime, bytes: o.bytes,
    width: o.width, height: o.height, status: p.status, issue: p.issue,
    thumb: thumbUrl(p.id, p.copyVersion, p.copySizes),
    wall: live.has(p.id) ? 'published' : draft.has(p.id) ? 'unpublished' : 'off',
    size: draft.get(p.id) ?? null,
    duplicateOf: p.duplicateOfId ? numbers.get(p.duplicateOfId) ?? null : null,
    createdAt: p.createdAt.toISOString(),
  }));
  const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3);
  const uploads = (await d.select().from(schema.uploads)
    .where(and(gt(schema.uploads.updatedAt, since), ne(schema.uploads.status, 'done'), ne(schema.uploads.status, 'skipped')))
    .orderBy(desc(schema.uploads.updatedAt)).limit(200))
    .map((u) => ({ id: u.id, filename: u.filename, bytes: u.bytes, status: u.status, error: u.error, updatedAt: u.updatedAt.toISOString() }));
  const originals = await d.select({ bytes: schema.originals.bytes }).from(schema.originals);
  const [setup] = await d.select().from(schema.settings).where(eq(schema.settings.key, 'storageSetup'));
  return {
    rows: out, uploads,
    stats: {
      prints: out.length, scans: originals.length, originalBytes: originals.reduce((s, o) => s + o.bytes, 0),
      lastPublished: pub?.publishedAt?.toISOString() ?? null,
    },
    storageReady: !!setup,
  };
}

export async function printDetail(id: string) {
  const d = await db();
  const [row] = await d.select({ p: schema.prints, o: schema.originals, c: schema.cleanup }).from(schema.prints)
    .innerJoin(schema.originals, eq(schema.originals.id, schema.prints.originalId))
    .leftJoin(schema.cleanup, eq(schema.cleanup.printId, schema.prints.id))
    .where(eq(schema.prints.id, id));
  if (!row) return null;
  const siblings = await d.select({ id: schema.prints.id, number: schema.prints.number, boxIndex: schema.prints.boxIndex })
    .from(schema.prints).where(eq(schema.prints.originalId, row.o.id));
  const copies = await d.select().from(schema.copies).where(eq(schema.copies.printId, id));
  const vid = await draftVersion();
  const [pub] = await d.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.status, 'published')).limit(1);
  const [inDraft] = await d.select().from(schema.placements).where(and(eq(schema.placements.versionId, vid), eq(schema.placements.printId, id)));
  const [inLive] = pub ? await d.select({ id: schema.placements.id }).from(schema.placements).where(and(eq(schema.placements.versionId, pub.id), eq(schema.placements.printId, id))) : [];
  const all = await d.select({ id: schema.prints.id, number: schema.prints.number }).from(schema.prints);
  all.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  const i = all.findIndex((x) => x.id === id);
  const dupOf = row.p.duplicateOfId ? all.find((x) => x.id === row.p.duplicateOfId)?.number ?? null : null;
  const base = env().PUBLIC_IMAGE_BASE;
  return {
    print: row.p, original: row.o, cleanup: row.c, siblings, dupOf,
    copies: copies.map((c) => ({ size: c.size, format: c.format, width: c.width, height: c.height, bytes: c.bytes })),
    preview: row.o.analysis?.preview ? { url: `${base}/${row.o.analysis.preview.key}`, width: row.o.analysis.preview.width, height: row.o.analysis.preview.height } : null,
    webCopy: row.p.copyVersion && row.p.copySizes?.length ? `${base}/p/${id}/${row.p.copyVersion}/${row.p.copySizes[Math.min(row.p.copySizes.length - 1, 2)]}.webp` : null,
    wall: inLive ? 'published' as const : inDraft ? 'unpublished' as const : 'off' as const,
    size: inDraft?.size ?? 'standard',
    prev: i > 0 ? all[i - 1].id : null, next: i >= 0 && i < all.length - 1 ? all[i + 1].id : null,
  };
}

export async function draftPrintIds(ids: string[]) {
  const d = await db();
  const vid = await draftVersion();
  if (!ids.length) return new Set<string>();
  return new Set((await d.select({ id: schema.placements.printId }).from(schema.placements)
    .where(and(eq(schema.placements.versionId, vid), inArray(schema.placements.printId, ids)))).map((r) => r.id));
}
