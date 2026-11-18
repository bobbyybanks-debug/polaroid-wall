/**
 * Database schema (Supabase Postgres).
 *
 * Originals are the untouched scan files. A print is one photograph cut from an original
 * (most originals hold one print; a scanner-bed capture can hold several). Web copies,
 * cleanup (trim) settings and wall placements all hang off the print, never the original.
 *
 * Row Level Security is on for every table with no policies: nothing is readable through
 * Supabase's public API. Only the app server (direct Postgres connection) reads or writes.
 */
import {
  pgTable, pgEnum, uuid, text, integer, bigint, real, boolean, timestamp, jsonb, serial,
  uniqueIndex, index,
} from 'drizzle-orm/pg-core';

export const printStatus = pgEnum('print_status', ['processing', 'ready', 'needs_attention', 'duplicate', 'failed']);
export const filmFormat = pgEnum('film_format', ['instax_wide', 'instax_square', 'instax_mini', 'unknown']);
export const cleanupMode = pgEnum('cleanup_mode', ['off', 'trim', 'cutout']);
export const layoutStatus = pgEnum('layout_status', ['draft', 'published', 'archived']);
export const printSize = pgEnum('print_size', ['standard', 'large']);
export const placementSource = pgEnum('placement_source', ['suggested', 'manual']);
export const uploadStatus = pgEnum('upload_status', ['uploading', 'uploaded', 'processing', 'done', 'failed', 'skipped', 'aborted']);

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Every scan file ever uploaded. Never modified; kept on Replace until deleted on purpose. */
export const originals = pgTable('originals', {
  id: uuid('id').primaryKey().defaultRandom(),
  storageKey: text('storage_key').notNull().unique(),
  filename: text('filename').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  mime: text('mime').notNull(),
  width: integer('width'),
  height: integer('height'),
  bitDepth: integer('bit_depth'),
  colorProfile: text('color_profile'),
  dpi: real('dpi'),
  pages: integer('pages'),
  /** Scanner-bed analysis: detected print boxes in original pixels. */
  analysis: jsonb('analysis').$type<OriginalAnalysis>(),
  replacedById: uuid('replaced_by_id'),
  uploadedAt: created(),
}, (t) => [index('originals_sha256_idx').on(t.sha256)]).enableRLS();

/** One row per photograph on (or headed for) the wall. */
export const prints = pgTable('prints', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Human label, from the scan filename: "100", "108a". Unique. */
  number: text('number').notNull().unique(),
  originalId: uuid('original_id').notNull().references(() => originals.id),
  /** Which detected box of the original this print is (0 for single-print scans). */
  boxIndex: integer('box_index').notNull().default(0),
  status: printStatus('status').notNull().default('processing'),
  issue: text('issue'),
  film: filmFormat('film').notNull().default('unknown'),
  /** Pixel size of the print after cleanup (what the viewer shows at 1:1). */
  widthPx: integer('width_px'),
  heightPx: integer('height_px'),
  /** 256-bit difference hash (hex) of the photo's centre, for near-duplicate detection. */
  dhash: text('dhash'),
  /** Dark-pixel share on the border bands: higher = ink (signed). */
  borderInk: real('border_ink'),
  duplicateOfId: uuid('duplicate_of_id'),
  /** Content hash of the current web copies; part of every copy key. */
  copyVersion: text('copy_version'),
  /** Long-edge pixel sizes available for this print's web copies. */
  copySizes: jsonb('copy_sizes').$type<number[]>(),
  createdAt: created(),
  updatedAt: updated(),
}).enableRLS();

/** Web copies (public bucket). Content-hashed keys, so they can be cached forever. */
export const copies = pgTable('copies', {
  id: uuid('id').primaryKey().defaultRandom(),
  printId: uuid('print_id').notNull().references(() => prints.id, { onDelete: 'cascade' }),
  size: integer('size').notNull(),
  format: text('format').notNull(),
  storageKey: text('storage_key').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  bytes: integer('bytes').notNull(),
}, (t) => [uniqueIndex('copies_print_size_format').on(t.printId, t.size, t.format)]).enableRLS();

/** Background removal / trim. Applied to web copies only, never baked into the original. */
export const cleanup = pgTable('cleanup', {
  printId: uuid('print_id').primaryKey().references(() => prints.id, { onDelete: 'cascade' }),
  mode: cleanupMode('mode').notNull().default('off'),
  /** Rotated rectangle in original pixels: centre, size, angle (degrees, clockwise). */
  rect: jsonb('rect').$type<CropRect | null>(),
  /** True when the box came from automatic detection. */
  auto: boolean('auto').notNull().default(true),
  approved: boolean('approved').notNull().default(false),
  updatedAt: updated(),
}).enableRLS();

export const layoutVersions = pgTable('layout_versions', {
  id: serial('id').primaryKey(),
  status: layoutStatus('status').notNull(),
  /** Core area used for the opening view: x, y, w, h in wall px. */
  frame: jsonb('frame').$type<{ x: number; y: number; w: number; h: number }>().notNull(),
  note: text('note'),
  createdAt: created(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}).enableRLS();

/** Where each print sits in each layout version. Wall px at 100% zoom; x/y = centre. */
export const placements = pgTable('placements', {
  id: uuid('id').primaryKey().defaultRandom(),
  versionId: integer('version_id').notNull().references(() => layoutVersions.id, { onDelete: 'cascade' }),
  printId: uuid('print_id').notNull().references(() => prints.id, { onDelete: 'cascade' }),
  x: real('x').notNull(),
  y: real('y').notNull(),
  rotation: real('rotation').notNull(),
  size: printSize('size').notNull().default('standard'),
  layer: integer('layer').notNull(),
  locked: boolean('locked').notNull().default(false),
  source: placementSource('source').notNull().default('suggested'),
  /** The placer's original suggestion, so "Reset to suggestion" works after manual edits. */
  suggested: jsonb('suggested').$type<{ x: number; y: number; rotation: number; size: 'standard' | 'large' } | null>(),
  updatedAt: updated(),
}, (t) => [uniqueIndex('placements_version_print').on(t.versionId, t.printId)]).enableRLS();

/** Drives progress bars, retries and resume. */
export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull(),
  filename: text('filename').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  mime: text('mime').notNull(),
  sha256: text('sha256').notNull(),
  storageKey: text('storage_key').notNull().unique(),
  s3UploadId: text('s3_upload_id'),
  partSize: integer('part_size').notNull(),
  partsDone: integer('parts_done').notNull().default(0),
  status: uploadStatus('status').notNull().default('uploading'),
  error: text('error'),
  originalId: uuid('original_id'),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index('uploads_sha_idx').on(t.sha256)]).enableRLS();

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
}).enableRLS();

export type CropRect = { cx: number; cy: number; w: number; h: number; angle: number };
export type OriginalAnalysis = {
  bed: boolean;
  /** Whole-scan preview (web bucket) for the print detail page, with its pixel size. */
  preview?: { key: string; width: number; height: number };
  /** Detected print boxes, largest first. */
  boxes: (CropRect & { cover: number })[];
};

export type Print = typeof prints.$inferSelect;
export type Original = typeof originals.$inferSelect;
export type Placement = typeof placements.$inferSelect;
export type LayoutVersion = typeof layoutVersions.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
