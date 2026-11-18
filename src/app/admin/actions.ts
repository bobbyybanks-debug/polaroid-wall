'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { requireAdmin, supabaseServer } from '@/lib/auth';
import { adminEmails, env } from '@/lib/env';
import { db, schema } from '@/lib/db';
import {
  publish, rollbackTo, updatePlacement, removeFromWall, restack, resuggest, suggestPlacement, draftVersion, spread, makeRoom,
  type PlacementPatch,
} from '@/lib/placement/service';
import { enqueue } from '@/lib/jobs';
import { deleteCopies, s3, buckets } from '@/lib/storage';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { CropRect } from '@/lib/db/schema';

/* ---------- Login ---------- */

export async function sendSignInLink(_: unknown, form: FormData): Promise<{ sent?: boolean; error?: string }> {
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return { error: 'Enter your email address.' };
  // Only allowed addresses get a link; everyone sees the same reply.
  if (adminEmails().includes(email)) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: `${env().SITE_URL}/auth/callback`, shouldCreateUser: true } });
    if (error) return { error: `Couldn't send the link: ${error.message}` };
  }
  return { sent: true };
}

export async function signOut() {
  const sb = await supabaseServer();
  await sb.auth.signOut();
  redirect('/admin/login');
}

/* ---------- Wall editor ---------- */

export async function movePrint(printId: string, patch: PlacementPatch) {
  await requireAdmin();
  await updatePlacement(printId, patch);
}

export async function setSize(printId: string, size: 'standard' | 'large') {
  await requireAdmin();
  const d = await db();
  const vid = await draftVersion();
  const [pl] = await d.select().from(schema.placements).where(and(eq(schema.placements.versionId, vid), eq(schema.placements.printId, printId)));
  if (!pl) { await suggestPlacement(printId); }
  await updatePlacement(printId, { size });
  revalidatePath('/admin');
}

export async function bringTo(printId: string, to: 'front' | 'back') {
  await requireAdmin();
  await restack(printId, to);
}

export async function resetToSuggestion(printId: string) {
  await requireAdmin();
  await resuggest(printId);
}

export async function resetAllDrafts(printIds: string[]) {
  await requireAdmin();
  for (const id of printIds) await resuggest(id);
}

export async function takeOffWall(printId: string) {
  await requireAdmin();
  await removeFromWall(printId);
  revalidatePath('/admin');
}

export async function putOnWall(printId: string) {
  await requireAdmin();
  const d = await db();
  const [p] = await d.select().from(schema.prints).where(eq(schema.prints.id, printId));
  if (p?.status === 'duplicate') {
    await d.update(schema.prints).set({ status: 'ready', issue: null, duplicateOfId: null, updatedAt: new Date() }).where(eq(schema.prints.id, printId));
  }
  await suggestPlacement(printId);
  revalidatePath('/admin');
}

/** Wall editor "Fix overlaps": nudge apart prints stacked on top of each other. Returns how many moved. */
export async function makeRoomOnWall() {
  await requireAdmin();
  return makeRoom();
}

/** Spacing control in the wall editor: push every print outward ('out') or pull them in. */
export async function spreadWall(direction: 'out' | 'in') {
  await requireAdmin();
  await spread(direction === 'out' ? 1.12 : 1 / 1.12);
}

export async function publishWall(note?: string) {
  await requireAdmin();
  const r = await publish(note);
  updateTag('layout');
  revalidatePath('/');
  return r;
}

export async function rollback(versionId: number) {
  await requireAdmin();
  await rollbackTo(versionId);
  updateTag('layout');
  revalidatePath('/');
}

export async function setOverlap(allow: boolean) {
  await requireAdmin();
  const d = await db();
  await d.insert(schema.settings).values({ key: 'allowOverlap', value: allow }).onConflictDoUpdate({ target: schema.settings.key, set: { value: allow } });
}

/* ---------- Print detail ---------- */

export async function setCleanup(printId: string, mode: 'off' | 'trim', rect?: CropRect) {
  await requireAdmin();
  const d = await db();
  const [c] = await d.select().from(schema.cleanup).where(eq(schema.cleanup.printId, printId));
  const nextRect = rect ?? c?.rect ?? null;
  if (mode === 'trim' && !nextRect) return { error: 'No trim found for this scan.' };
  await d.insert(schema.cleanup).values({ printId, mode, rect: nextRect, auto: !rect, approved: true })
    .onConflictDoUpdate({ target: schema.cleanup.printId, set: { mode, rect: nextRect, auto: rect ? false : (c?.auto ?? true), approved: true, updatedAt: new Date() } });
  await enqueue('reprocess-print', printId);
  revalidatePath(`/admin/prints/${printId}`);
  return { ok: true };
}

/**
 * Remove a print. If it was the original's last print, the original file is deleted too.
 * The page asks for confirmation first; published prints must be taken off the wall and published.
 */
export async function removePrint(printId: string) {
  await requireAdmin();
  const d = await db();
  const [p] = await d.select().from(schema.prints).where(eq(schema.prints.id, printId));
  if (!p) redirect('/admin');
  const [live] = await d.select({ id: schema.placements.id }).from(schema.placements)
    .innerJoin(schema.layoutVersions, eq(schema.layoutVersions.id, schema.placements.versionId))
    .where(and(eq(schema.placements.printId, printId), eq(schema.layoutVersions.status, 'published')));
  if (live) return { error: 'This print is on the live wall. Remove it in the wall editor and publish first.' };
  const copies = await d.select({ key: schema.copies.storageKey }).from(schema.copies).where(eq(schema.copies.printId, printId));
  // Old layout versions keep history, but a removed print can't be restored from them.
  await d.delete(schema.placements).where(eq(schema.placements.printId, printId));
  await d.delete(schema.prints).where(eq(schema.prints.id, printId));
  await deleteCopies(copies.map((c) => c.key));
  const rest = await d.select({ id: schema.prints.id }).from(schema.prints).where(eq(schema.prints.originalId, p.originalId));
  if (!rest.length) {
    const [o] = await d.select().from(schema.originals).where(eq(schema.originals.id, p.originalId));
    if (o) {
      await s3().send(new DeleteObjectCommand({ Bucket: buckets().originals, Key: o.storageKey }));
      if (o.analysis?.preview) await deleteCopies([o.analysis.preview.key]);
      await d.update(schema.uploads).set({ status: 'skipped' }).where(eq(schema.uploads.originalId, o.id));
      await d.delete(schema.originals).where(eq(schema.originals.id, o.id));
    }
  }
  revalidatePath('/admin');
  redirect('/admin');
}

export async function retryPrint(printId: string) {
  await requireAdmin();
  await enqueue('reprocess-print', printId);
  revalidatePath(`/admin/prints/${printId}`);
}

export async function dismissUpload(uploadId: string) {
  await requireAdmin();
  const d = await db();
  await d.update(schema.uploads).set({ status: 'skipped', updatedAt: new Date() }).where(eq(schema.uploads.id, uploadId));
  revalidatePath('/admin');
}
