/**
 * Scan processing. Runs inside the web app (small files) or on Trigger.dev (large TIFFs).
 *
 * analyzeOriginal: validate the uploaded file, find the print(s) on it, create print rows.
 * processPrint:    make the web copies for one print (trim → sRGB 8-bit → sizes/formats),
 *                  fingerprint it, check for near-duplicates and suggest a wall position.
 *
 * Originals are only ever read. Every output goes to the public web bucket.
 */
import sharp, { type Metadata as SharpMeta, type Sharp } from 'sharp';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { and, eq, ne, inArray, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { downloadOriginal, putCopy, copyKey, deleteCopies } from '../storage';
import { LIMITS } from '../limits';
import { detectAndPlan, filmFromRatio } from './detect';
import { autoFitRect } from './autofit';
import { goLive, suggestPlacement } from '../placement/service';
import { revalidateTag } from 'next/cache';

sharp.cache(false);
sharp.concurrency(Math.max(1, Math.min(4, os.cpus().length)));

const PIPELINE = 'v1';
export const COPY_SIZES = [400, 800, 1600, 3200];

const tmpFile = (key: string) => path.join(os.tmpdir(), 'pw-' + crypto.createHash('sha1').update(key).digest('hex'));

async function localOriginal(storageKey: string): Promise<string> {
  const p = tmpFile(storageKey);
  try { await fs.access(p); return p; } catch { /* not cached */ }
  const part = p + '.part';
  await downloadOriginal(storageKey, part);
  await fs.rename(part, p);
  return p;
}

async function sha256File(p: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest('hex');
}

const open = (p: string) => sharp(p, { limitInputPixels: LIMITS.maxPixels + 1, failOn: 'error', sequentialRead: true });

/** "Instax wide -100.jpg" → "100"; "scan_108.tif" → "108"; falls back to the name. */
export function numberFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const m = base.match(/(\d{1,6}[a-z]?)(?!.*\d)/i);
  return (m ? m[1] : base).toLowerCase().slice(0, 40);
}

async function uniqueNumber(base: string): Promise<string> {
  const d = await db();
  const taken = new Set((await d.select({ n: schema.prints.number }).from(schema.prints)).map((r) => r.n));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export class ScanError extends Error {}

/**
 * Validate an original and create its print rows. Returns the new print ids.
 * Throws ScanError with a plain-language reason when the file can't be used.
 */
export async function analyzeOriginal(originalId: string, opts: { expectedSha256?: string } = {}): Promise<string[]> {
  const d = await db();
  const [orig] = await d.select().from(schema.originals).where(eq(schema.originals.id, originalId));
  if (!orig) throw new Error(`Original ${originalId} not found`);
  const file = await localOriginal(orig.storageKey);

  if (opts.expectedSha256) {
    const sum = await sha256File(file);
    if (sum !== opts.expectedSha256) throw new ScanError(`${orig.filename} changed during upload (checksum mismatch). Upload it again.`);
  }

  let meta: SharpMeta;
  try { meta = await open(file).metadata(); } catch {
    throw new ScanError(`${orig.filename} couldn't be opened as an image. It may be damaged or only partly uploaded.`);
  }
  if (!['jpeg', 'png', 'tiff'].includes(meta.format ?? '')) {
    throw new ScanError(`${orig.filename} is a ${String(meta.format).toUpperCase()} file; export it as JPEG or TIFF.`);
  }
  // Oriented size (EXIF orientation 5–8 swaps sides).
  const swap = (meta.orientation ?? 1) >= 5;
  const W = swap ? meta.height! : meta.width!, H = swap ? meta.width! : meta.height!;
  if (W > LIMITS.maxSide || H > LIMITS.maxSide) throw new ScanError(`${orig.filename} is ${W} × ${H} px; each side can be up to 25,000 px.`);
  if (W * H > LIMITS.maxPixels) throw new ScanError(`${orig.filename} is ${Math.round((W * H) / 1e6)} MP; the limit is 250 MP.`);

  // Full decode on a small copy: truncated files fail here, not on the wall.
  const s = Math.min(1, 1000 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  let gray: Buffer;
  try {
    gray = await open(file).rotate().resize(w, h, { fit: 'fill' }).greyscale().blur(1.5).raw().toBuffer();
  } catch (e) {
    throw new ScanError(`${orig.filename} is damaged or incomplete (${(e as Error).message.split('\n')[0]}). Export it again.`);
  }
  const plan = detectAndPlan(new Uint8Array(gray), w, h, s, W, H);
  // Whole-scan preview for the dashboard (shows the bed and the detected trims). Not the original.
  const pv = await open(file).rotate().resize({ width: W >= H ? 1600 : undefined, height: H > W ? 1600 : undefined, withoutEnlargement: true })
    .toColourspace('srgb').webp({ quality: 78 }).toBuffer({ resolveWithObject: true });
  const previewKey = `o/${originalId}/${crypto.createHash('sha1').update(orig.sha256).digest('hex').slice(0, 10)}.webp`;
  await putCopy(previewKey, pv.data, 'webp');
  const bitDepth = meta.depth === 'ushort' ? 16 : meta.depth === 'float' ? 32 : 8;
  await d.update(schema.originals).set({
    width: W, height: H, bitDepth, colorProfile: meta.icc ? iccName(meta.icc) : (meta.space ?? null),
    dpi: meta.density ?? null, pages: meta.pages ?? 1,
    analysis: { bed: plan.bed, boxes: plan.boxes.map((b) => ({ ...b, cover: 0 })), preview: { key: previewKey, width: pv.info.width, height: pv.info.height } },
  }).where(eq(schema.originals.id, originalId));

  const base = numberFromFilename(orig.filename);
  const ids: string[] = [];
  const many = plan.boxes.length > 1;
  for (let i = 0; i < plan.boxes.length; i++) {
    const number = await uniqueNumber(many ? `${base}${String.fromCharCode(97 + i)}` : base);
    // "N prints found" is information, not a problem: the split prints are shown together on the detail page.
    const planIssue = plan.issue && !/prints found on this scan/.test(plan.issue) ? plan.issue : null;
    const issue = [
      planIssue,
      (meta.pages ?? 1) > 1 ? `Multi-page TIFF: page 1 of ${meta.pages} is used.` : null,
    ].filter(Boolean).join(' ') || null;
    const [p] = await d.insert(schema.prints).values({
      number, originalId, boxIndex: i, status: 'processing', issue,
    }).returning({ id: schema.prints.id });
    const box = plan.boxes[i];
    const trims = plan.bed;
    await d.insert(schema.cleanup).values({
      printId: p.id, mode: trims ? 'trim' : 'off', rect: trims ? box : null, auto: true, approved: false,
    });
    ids.push(p.id);
  }
  return ids;
}

function iccName(icc: Buffer): string | null {
  // ICC 'desc' tag text, enough to show "sRGB IEC61966-2.1" / "Adobe RGB (1998)".
  const s = icc.toString('latin1');
  const m = s.match(/(sRGB[^\0]{0,30}|Adobe RGB[^\0]{0,12}|Display P3|ProPhoto[^\0]{0,10}|Generic Gray[^\0]{0,20}|Gray Gamma [0-9.]+|Dot Gain [0-9%]+)/);
  return m ? m[1].replace(/[^\x20-\x7e]/g, '').trim() : 'Embedded profile';
}

/**
 * Make web copies, fingerprint, de-duplicate and place one print.
 * With { copiesOnly: true } it only rebuilds the web copies (status, duplicates and placement stay).
 */
export async function processPrint(printId: string, opts: { copiesOnly?: boolean } = {}): Promise<void> {
  const d = await db();
  const [print] = await d.select().from(schema.prints).where(eq(schema.prints.id, printId));
  if (!print) return;
  const [orig] = await d.select().from(schema.originals).where(eq(schema.originals.id, print.originalId));
  const [clean] = await d.select().from(schema.cleanup).where(eq(schema.cleanup.printId, printId));
  const file = await localOriginal(orig.storageKey);
  const W = orig.width!, H = orig.height!;
  const hasAlpha = !!(await open(file).metadata()).hasAlpha;
  // A trim set on the scanner bed (or by hand) wins. Otherwise auto-fit: straighten a crooked scan
  // and crop to the print's own edges, unless Bobby switched trimming off for this print.
  const userOff = clean?.approved && clean.mode === 'off';
  const rect = clean?.mode === 'trim' ? clean.rect : userOff ? null : await autoFitRect(file, W, H, hasAlpha);

  // Copies are content-hashed: same scan + same crop = same version.
  const version = crypto.createHash('sha1')
    .update(`${PIPELINE}|${orig.sha256}|${JSON.stringify(rect)}${hasAlpha ? '|alpha-white' : ''}`).digest('hex').slice(0, 10);
  if (opts.copiesOnly && version === print.copyVersion) return;

  // 1. Upright, trimmed, sRGB 8-bit working copy, at most 3200 px on the long edge.
  //    Transparent areas become white, never black.
  let work = open(file).rotate();
  if (hasAlpha) work = work.flatten({ background: '#ffffff' });
  let cw = W, ch = H;
  if (rect) {
    if (Math.abs(rect.angle) > 0.05) {
      // Materialise the rotation once so the crop maths stays exact.
      const rotated = await work.rotate(-rect.angle, { background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
      const { width: W2, height: H2, channels } = rotated.info;
      const a = (-rect.angle * Math.PI) / 180;
      const dx = rect.cx - W / 2, dy = rect.cy - H / 2;
      const nx = dx * Math.cos(a) - dy * Math.sin(a) + W2 / 2, ny = dx * Math.sin(a) + dy * Math.cos(a) + H2 / 2;
      cw = Math.min(Math.round(rect.w), W2); ch = Math.min(Math.round(rect.h), H2);
      const left = clamp(Math.round(nx - cw / 2), 0, W2 - cw), top = clamp(Math.round(ny - ch / 2), 0, H2 - ch);
      work = sharp(rotated.data, { raw: { width: W2, height: H2, channels }, limitInputPixels: false }).extract({ left, top, width: cw, height: ch });
    } else {
      cw = Math.min(Math.round(rect.w), W); ch = Math.min(Math.round(rect.h), H);
      const left = clamp(Math.round(rect.cx - cw / 2), 0, W - cw), top = clamp(Math.round(rect.cy - ch / 2), 0, H - ch);
      work = work.extract({ left, top, width: cw, height: ch });
    }
  }
  const longEdge = Math.max(cw, ch);
  const workEdge = Math.min(3200, longEdge);
  const base = await work
    .resize({ width: cw >= ch ? workEdge : undefined, height: ch > cw ? workEdge : undefined, withoutEnlargement: true, kernel: 'lanczos3' })
    .toColourspace('srgb').removeAlpha()
    .raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  const bw = base.info.width, bh = base.info.height;
  const fromBase = () => sharp(base.data, { raw: { width: bw, height: bh, channels: base.info.channels as 3 } });

  // 2. Fingerprints: 256-bit difference hash of the photo's centre (borders and signatures
  //    mostly excluded), and ink on the border (signature).
  const cx0 = Math.round(bw * .2), cy0 = Math.round(bh * .2);
  const tiny = await fromBase().extract({ left: cx0, top: cy0, width: Math.max(17, Math.round(bw * .6)), height: Math.max(16, Math.round(bh * .6)) })
    .greyscale().resize(17, 16, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) bits += tiny[y * 17 + x] > tiny[y * 17 + x + 1] ? '1' : '0';
  const dhash = BigInt('0b' + bits).toString(16).padStart(64, '0');
  const g = await fromBase().greyscale().resize(256, 256, { fit: 'fill' }).raw().toBuffer();
  let ink = 0, n = 0;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const band = x < 18 || x >= 238 || y < 18 || y >= 238;
    if (band) { n++; if (g[y * 256 + x] < 90) ink++; }
  }
  const borderInk = ink / n;

  // 3. Web copies, in the content-hashed folder for this version (cached forever).
  const sizes = COPY_SIZES.filter((s) => s < longEdge);
  if (!sizes.length || sizes[sizes.length - 1] < Math.min(longEdge, 3200)) sizes.push(Math.min(longEdge, 3200));
  const rows: (typeof schema.copies.$inferInsert)[] = [];
  for (const size of sizes) {
    const resized = fromBase().resize({ width: bw >= bh ? size : undefined, height: bh > bw ? size : undefined, withoutEnlargement: true, kernel: 'lanczos3' });
    const outs: [string, Sharp][] = [
      ['avif', resized.clone().avif({ quality: 58, effort: 4, chromaSubsampling: '4:4:4' })],
      ['webp', resized.clone().webp({ quality: 82, effort: 4 })],
    ];
    if (size === sizes[Math.min(sizes.length - 1, 2)]) outs.push(['jpeg', resized.clone().jpeg({ quality: 86, mozjpeg: true })]);
    for (const [format, pipe] of outs) {
      const { data, info } = await pipe.toBuffer({ resolveWithObject: true });
      const key = copyKey(printId, version, size, format === 'jpeg' ? 'jpg' : format);
      await putCopy(key, data, format);
      rows.push({ printId, size, format, storageKey: key, width: info.width, height: info.height, bytes: data.length });
    }
  }

  const old = await d.select({ key: schema.copies.storageKey }).from(schema.copies).where(eq(schema.copies.printId, printId));
  await d.delete(schema.copies).where(eq(schema.copies.printId, printId));
  await d.insert(schema.copies).values(rows);
  const keep = new Set(rows.map((r) => r.storageKey));
  await deleteCopies(old.map((o) => o.key).filter((k) => !keep.has(k)));

  if (opts.copiesOnly) {
    await d.update(schema.prints).set({ widthPx: cw, heightPx: ch, copyVersion: version, copySizes: sizes, updatedAt: new Date() })
      .where(eq(schema.prints.id, printId));
    return;
  }

  const film = filmFromRatio(cw, ch);
  let status: 'ready' | 'needs_attention' | 'duplicate' = print.issue ? 'needs_attention' : 'ready';
  let issue = print.issue;
  if (film === 'unknown' && !issue) { status = 'needs_attention'; issue = `Doesn't look like a whole Instax print (${cw} × ${ch} px).`; }

  // 4. Near-duplicates: the signed version (more ink on the border) goes on the wall.
  let duplicateOfId: string | null = null;
  const others = await d.select({ id: schema.prints.id, number: schema.prints.number, dhash: schema.prints.dhash, borderInk: schema.prints.borderInk, status: schema.prints.status })
    .from(schema.prints).where(and(ne(schema.prints.id, printId), isNotNull(schema.prints.dhash)));
  // Same photo scanned twice (signed / unsigned) differs by about 22–27 of 256 bits; different photos by 60+.
  const twin = others.find((o) => o.status !== 'duplicate' && o.status !== 'failed' && o.dhash!.length === dhash.length && hamming(o.dhash!, dhash) <= 40);
  if (twin) {
    const mineSigned = borderInk > (twin.borderInk ?? 0) + 0.004;
    if (mineSigned) {
      // This upload is the signed one: it replaces the twin unless the twin is already published.
      const published = await isPublished(twin.id);
      if (!published) {
        await d.update(schema.prints).set({ status: 'duplicate', duplicateOfId: printId, issue: `Near-duplicate of ${print.number}, which is signed. The signed version goes on the wall.`, updatedAt: new Date() }).where(eq(schema.prints.id, twin.id));
        await removeFromDraft(twin.id);
      } else if (!issue) {
        status = 'needs_attention';
        issue = `Signed version of ${twin.number}, which is already on the wall. Swap them in the placement editor if you want this one up.`;
      }
    } else {
      status = 'duplicate';
      duplicateOfId = twin.id;
      issue = `Near-duplicate of ${twin.number}${(twin.borderInk ?? 0) > borderInk + 0.004 ? ', which is signed' : ''}. Kept off the wall; use "Put on wall" to override.`;
    }
  }

  await d.update(schema.prints).set({
    status, issue, film, widthPx: cw, heightPx: ch, dhash, borderInk, duplicateOfId,
    copyVersion: version, copySizes: sizes, updatedAt: new Date(),
  }).where(eq(schema.prints.id, printId));

  if (status === 'ready' || status === 'needs_attention') await suggestPlacement(printId);
  // New uploads go live on their own. Prints that need a look stay in the draft for review.
  if (status === 'ready' && await goLive(printId)) {
    try { revalidateTag('layout', { expire: 0 }); } catch { /* outside a Next request (scripts) */ }
  }
}

async function isPublished(printId: string) {
  const d = await db();
  const r = await d.select({ id: schema.placements.id }).from(schema.placements)
    .innerJoin(schema.layoutVersions, eq(schema.layoutVersions.id, schema.placements.versionId))
    .where(and(eq(schema.placements.printId, printId), eq(schema.layoutVersions.status, 'published')));
  return r.length > 0;
}

async function removeFromDraft(printId: string) {
  const d = await db();
  const drafts = await d.select({ id: schema.layoutVersions.id }).from(schema.layoutVersions).where(eq(schema.layoutVersions.status, 'draft'));
  if (drafts.length) {
    await d.delete(schema.placements).where(and(eq(schema.placements.printId, printId), inArray(schema.placements.versionId, drafts.map((x) => x.id))));
  }
}

function hamming(a: string, b: string) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

