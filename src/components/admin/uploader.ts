/**
 * Browser side of bulk upload. Every check happens before any bytes move:
 * type from the first bytes, size per type, pixel size from the header, SHA-256 checksum,
 * exact-duplicate lookup. Then the file goes straight to storage in 64 MiB parts
 * (3 files at a time), each part retried on its own. Survives a page reload: dropping the
 * same file again resumes from the parts storage already has.
 */
import { createSHA256 } from 'hash-wasm';
import { LIMITS, sniff, checkSize, checkDimensions, headerDimensions, fmtBytes, type Kind } from '@/lib/limits';

export type ItemState =
  | 'checking' | 'duplicate' | 'rejected' | 'queued' | 'uploading' | 'paused' | 'finishing' | 'processing' | 'failed' | 'cancelled' | 'skipped';

export type Item = {
  key: string; file: File; batchId: string; state: ItemState; error?: string;
  kind?: Kind; sha256?: string; width?: number; height?: number;
  sent: number; uploadId?: string; dupOf?: string; hashProgress?: number;
};

type Listener = (items: Item[]) => void;
const CONCURRENCY = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as T;
}

export class Uploader {
  items: Item[] = [];
  private listeners = new Set<Listener>();
  private active = 0;
  private xhrs = new Map<string, XMLHttpRequest>();
  paused = false;

  subscribe(fn: Listener) { this.listeners.add(fn); fn(this.items); return () => { this.listeners.delete(fn); }; }
  private emit() { const snap = [...this.items]; for (const l of this.listeners) l(snap); }
  private set(it: Item, patch: Partial<Item>) { Object.assign(it, patch); this.emit(); }

  /** Add files. Over 100 files or 3 GB, the rest simply wait as the next batch. */
  add(files: File[]) {
    let batchId = crypto.randomUUID(), count = 0, bytes = 0;
    const fresh: Item[] = [];
    for (const file of files) {
      if (count >= LIMITS.batchFiles || bytes + file.size > LIMITS.batchBytes) { batchId = crypto.randomUUID(); count = 0; bytes = 0; }
      count++; bytes += file.size;
      fresh.push({ key: crypto.randomUUID(), file, batchId, state: 'checking', sent: 0 });
    }
    this.items.push(...fresh);
    this.emit();
    void this.check(fresh);
  }

  private async check(items: Item[]) {
    for (const it of items) {
      const f = it.file;
      const head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
      const s = sniff(head, f.name);
      if (!s.ok) { this.set(it, { state: 'rejected', error: s.reason }); continue; }
      const sizeErr = checkSize(f.name, s.kind, f.size);
      if (sizeErr) { this.set(it, { state: 'rejected', error: sizeErr, kind: s.kind }); continue; }
      let dims: { width: number; height: number } | null = null;
      try { dims = await headerDimensions(s.kind, async (o, l) => new Uint8Array(await f.slice(o, o + l).arrayBuffer())); } catch { /* checked on the server */ }
      if (dims) {
        const e = checkDimensions(f.name, dims.width, dims.height);
        if (e) { this.set(it, { state: 'rejected', error: e, kind: s.kind, ...dims }); continue; }
      }
      // Checksum in 8 MB slices so the page stays responsive.
      const h = await createSHA256();
      h.init();
      const chunk = 8 * 1024 * 1024;
      for (let o = 0; o < f.size; o += chunk) {
        h.update(new Uint8Array(await f.slice(o, o + chunk).arrayBuffer()));
        if (f.size > 50 * chunk) this.set(it, { hashProgress: Math.min(1, (o + chunk) / f.size) });
        await sleep(0);
      }
      this.set(it, { kind: s.kind, sha256: h.digest('hex'), width: dims?.width, height: dims?.height });
    }
    const sums = items.filter((i) => i.sha256 && i.state === 'checking').map((i) => i.sha256!);
    if (sums.length) {
      try {
        const { matches } = await post<{ matches: { sha256: string; number: string | null; filename: string }[] }>('/api/admin/uploads/check', { sha256: sums });
        const by = new Map(matches.map((m) => [m.sha256, m]));
        for (const it of items) {
          if (it.state !== 'checking') continue;
          const m = it.sha256 ? by.get(it.sha256) : undefined;
          // Same file already uploaded in this session (dropped twice)?
          const twin = this.items.find((x) => x !== it && x.sha256 === it.sha256 && !['rejected', 'cancelled', 'skipped', 'duplicate'].includes(x.state));
          if (m) this.set(it, { state: 'duplicate', dupOf: m.number ?? m.filename });
          else if (twin && this.items.indexOf(twin) < this.items.indexOf(it)) this.set(it, { state: 'duplicate', dupOf: twin.file.name });
          else this.set(it, { state: 'queued' });
        }
      } catch (e) {
        for (const it of items) if (it.state === 'checking') this.set(it, { state: 'failed', error: (e as Error).message });
      }
    }
    this.pump();
  }

  /** Duplicate → upload anyway (both kept). */
  keepBoth(key: string) { const it = this.items.find((i) => i.key === key); if (it) { this.set(it, { state: 'queued' }); this.pump(); } }
  skip(key: string) { const it = this.items.find((i) => i.key === key); if (it) this.set(it, { state: 'skipped' }); }
  retry(key: string) { const it = this.items.find((i) => i.key === key); if (it && it.sha256) { this.set(it, { state: 'queued', error: undefined }); this.pump(); } }

  pauseAll() { this.paused = true; for (const x of this.xhrs.values()) x.abort(); this.emit(); }
  resumeAll() { this.paused = false; for (const it of this.items) if (it.state === 'paused') it.state = 'queued'; this.emit(); this.pump(); }
  async cancelPending() {
    for (const it of this.items) {
      if (['queued', 'paused', 'checking', 'uploading'].includes(it.state)) {
        const wasUploading = it.state === 'uploading' || it.state === 'paused';
        this.set(it, { state: 'cancelled' });
        this.xhrs.get(it.key)?.abort();
        if (wasUploading && it.uploadId) await post(`/api/admin/uploads/${it.uploadId}/abort`).catch(() => {});
      }
    }
  }
  clearFinished() { this.items = this.items.filter((i) => !['processing', 'skipped', 'cancelled', 'duplicate', 'rejected'].includes(i.state)); this.emit(); }

  private pump() {
    if (this.paused) return;
    while (this.active < CONCURRENCY) {
      const next = this.items.find((i) => i.state === 'queued');
      if (!next) return;
      this.active++;
      this.set(next, { state: 'uploading' });
      void this.upload(next).finally(() => { this.active--; this.pump(); });
    }
  }

  private async upload(it: Item) {
    try {
      const start = await post<{ id: string; partSize: number; done: { PartNumber: number; ETag: string; Size: number }[] }>('/api/admin/uploads', {
        batchId: it.batchId, filename: it.file.name, bytes: it.file.size, kind: it.kind, sha256: it.sha256, width: it.width, height: it.height,
      });
      it.uploadId = start.id;
      const total = Math.ceil(it.file.size / start.partSize);
      const done = new Set(start.done.map((p) => p.PartNumber));
      let sent = start.done.reduce((s, p) => s + p.Size, 0);
      this.set(it, { sent });
      const todo = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !done.has(n));
      for (let i = 0; i < todo.length; i += 4) {
        const batch = todo.slice(i, i + 4);
        const { urls } = await post<{ urls: { partNumber: number; url: string }[] }>(`/api/admin/uploads/${start.id}/sign`, { parts: batch });
        for (const { partNumber, url } of urls) {
          if (this.paused) { this.set(it, { state: 'paused' }); return; }
          if (it.state === 'cancelled') return;
          const from = (partNumber - 1) * start.partSize;
          const blob = it.file.slice(from, Math.min(it.file.size, from + start.partSize));
          await this.putPart(it, url, blob, (n) => this.set(it, { sent: sent + n }));
          sent += blob.size;
          this.set(it, { sent });
        }
      }
      this.set(it, { state: 'finishing' });
      await post(`/api/admin/uploads/${start.id}/complete`);
      this.set(it, { state: 'processing', sent: it.file.size });
    } catch (e) {
      if ((it.state as ItemState) === 'cancelled' || (it.state as ItemState) === 'paused') return;
      if (this.paused) { this.set(it, { state: 'paused' }); return; }
      this.set(it, { state: 'failed', error: `${it.file.name}: ${(e as Error).message}` });
    }
  }

  /** PUT one part with progress; retried up to 4 times with backoff. */
  private async putPart(it: Item, url: string, blob: Blob, progress: (n: number) => void) {
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const x = new XMLHttpRequest();
          this.xhrs.set(it.key, x);
          x.open('PUT', url);
          x.upload.onprogress = (e) => progress(e.loaded);
          x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`storage answered ${x.status}`)));
          x.onerror = () => reject(new Error('network error'));
          x.onabort = () => reject(new Error('aborted'));
          x.send(blob);
        });
        return;
      } catch (e) {
        if (this.paused || it.state === 'cancelled' || attempt >= 4) throw e;
        await sleep(1000 * 2 ** attempt);
      } finally { this.xhrs.delete(it.key); }
    }
  }
}

export function describe(it: Item) {
  switch (it.state) {
    case 'checking': return it.hashProgress ? `Checking ${Math.round(it.hashProgress * 100)}%` : 'Checking';
    case 'duplicate': return `Already in the library as ${it.dupOf}`;
    case 'rejected': return it.error ?? 'Not accepted';
    case 'queued': return 'Waiting';
    case 'uploading': return `${fmtBytes(it.sent)} / ${fmtBytes(it.file.size)}`;
    case 'paused': return 'Paused';
    case 'finishing': return 'Finishing';
    case 'processing': return 'Uploaded · making web copies';
    case 'failed': return it.error ?? 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'skipped': return 'Skipped';
  }
}
