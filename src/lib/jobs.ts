/**
 * Background work after an upload: validate → find prints → web copies → suggested spot.
 * Runs on Trigger.dev when TRIGGER_SECRET_KEY is set (needed for very large TIFFs), otherwise
 * inside the web app right after the upload request finishes (fine for JPEG scans).
 */
import { eq } from 'drizzle-orm';
import { db, schema } from './db';
import { analyzeOriginal, processPrint, ScanError } from './processing/pipeline';

export async function ingestUpload(uploadId: string) {
  const d = await db();
  const [u] = await d.select().from(schema.uploads).where(eq(schema.uploads.id, uploadId));
  if (!u?.originalId) return;
  try {
    const ids = await analyzeOriginal(u.originalId, { expectedSha256: u.sha256 });
    for (const id of ids) {
      try { await processPrint(id); } catch (e) {
        await d.update(schema.prints).set({ status: 'failed', issue: friendly(e), updatedAt: new Date() }).where(eq(schema.prints.id, id));
      }
    }
    await d.update(schema.uploads).set({ status: 'done', updatedAt: new Date() }).where(eq(schema.uploads.id, uploadId));
  } catch (e) {
    await d.update(schema.uploads).set({ status: 'failed', error: friendly(e), updatedAt: new Date() }).where(eq(schema.uploads.id, uploadId));
  }
}

/** Re-make one print's web copies (after a trim change). */
export async function reprocessPrint(printId: string) {
  const d = await db();
  await d.update(schema.prints).set({ status: 'processing', updatedAt: new Date() }).where(eq(schema.prints.id, printId));
  try { await processPrint(printId); } catch (e) {
    await d.update(schema.prints).set({ status: 'failed', issue: friendly(e), updatedAt: new Date() }).where(eq(schema.prints.id, printId));
  }
}

function friendly(e: unknown) {
  if (e instanceof ScanError) return e.message;
  const m = (e as Error)?.message ?? String(e);
  if (/memory|heap/i.test(m)) return 'This file is too big to process here. Turn on the large-file worker (see README) and retry.';
  return `Processing failed: ${m.split('\n')[0].slice(0, 200)}`;
}

/** Queue a job: Trigger.dev if configured, else run after the response is sent. */
export async function enqueue(job: 'ingest-upload' | 'reprocess-print', id: string) {
  if (process.env.TRIGGER_SECRET_KEY) {
    const { tasks } = await import('@trigger.dev/sdk');
    await tasks.trigger(job, job === 'ingest-upload' ? { uploadId: id } : { printId: id });
    return;
  }
  const { after } = await import('next/server');
  after(() => (job === 'ingest-upload' ? ingestUpload(id) : reprocessPrint(id)));
}
