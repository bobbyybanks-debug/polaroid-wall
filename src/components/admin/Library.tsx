'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { LibraryData, LibraryRow } from '@/lib/admin-data';
import { fmtBytes, KIND_LABEL, LIMITS, type Kind } from '@/lib/limits';
import { setSize, dismissUpload, replaceWithRescan, replaceAllRescans } from '@/app/admin/actions';
import { Uploader, describe, type Item } from './uploader';

type Tab = 'all' | 'unpublished' | 'published' | 'attention';
const fmtType = (mime: string) => (mime.includes('tiff') ? 'TIFF' : mime.includes('png') ? 'PNG' : 'JPEG');
const px = (w: number | null, h: number | null) => (w && h ? `${w.toLocaleString()} × ${h.toLocaleString()}` : '—');

export default function Library({ data }: { data: LibraryData }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [over, setOver] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [, startTransition] = useTransition();
  const [setupMsg, setSetupMsg] = useState<string | null>(null);
  const [manualCors, setManualCors] = useState<{ bucket: string; json: string } | null>(null);
  const [up] = useState(() => new Uploader());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => up.subscribe(setItems), [up]);

  // Poll while anything is uploading or being processed.
  const busy = items.some((i) => ['checking', 'queued', 'uploading', 'finishing', 'processing'].includes(i.state))
    || data.rows.some((r) => r.status === 'processing') || data.uploads.some((u) => u.status === 'processing' || u.status === 'uploaded');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [busy, router]);

  // Drop anywhere on the page.
  useEffect(() => {
    const onOver = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setOver(true); } };
    const onLeave = (e: DragEvent) => { if (!e.relatedTarget) setOver(false); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault(); setOver(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) up.add(files);
    };
    window.addEventListener('dragover', onOver); window.addEventListener('dragleave', onLeave); window.addEventListener('drop', onDrop);
    return () => { window.removeEventListener('dragover', onOver); window.removeEventListener('dragleave', onLeave); window.removeEventListener('drop', onDrop); };
  }, [up]);

  const counts = useMemo(() => ({
    all: data.rows.length,
    unpublished: data.rows.filter((r) => r.wall !== 'published').length,
    published: data.rows.filter((r) => r.wall === 'published').length,
    attention: data.rows.filter((r) => r.status === 'needs_attention' || r.status === 'failed' || r.status === 'duplicate').length + data.uploads.filter((u) => u.status === 'failed').length,
  }), [data]);

  const rows = data.rows.filter((r) => {
    if (tab === 'unpublished' && r.wall === 'published') return false;
    if (tab === 'published' && r.wall !== 'published') return false;
    if (tab === 'attention' && !['needs_attention', 'failed', 'duplicate'].includes(r.status)) return false;
    if (q && !`${r.filename} ${r.number}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const failedUploads = data.uploads.filter((u) => u.status === 'failed');
  const live = items.filter((i) => !['processing', 'skipped', 'cancelled'].includes(i.state));

  async function setupStorage(manual = false) {
    setSetupMsg(manual ? 'Saving…' : 'Applying…');
    const r = await fetch('/api/admin/setup-storage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manual }),
    });
    const j = (await r.json().catch(() => ({}))) as { manual?: boolean; message?: string; bucket?: string; cors?: unknown };
    if (r.status === 409 && j.manual) {
      setManualCors({ bucket: j.bucket ?? 'polaroid-originals', json: JSON.stringify(j.cors, null, 2) });
      setSetupMsg(j.message ?? 'Add the CORS policy in Cloudflare.');
      return;
    }
    setSetupMsg(r.ok ? 'Done. Uploads are ready.' : `Couldn't apply the rules (${r.status}). Open /api/admin/check to see what's wrong.`);
    if (r.ok) { setManualCors(null); router.refresh(); }
  }

  return (
    <>
      <div className="head">
        <h1>Library</h1><span className="count">{data.rows.length} prints</span>
        <span className="sp" />
        <Link className="btn" href="/admin/wall">Open wall editor</Link>
        <button className="btn dark" onClick={() => input.current?.click()}>Upload scans</button>
        <input ref={input} type="file" multiple accept=".jpg,.jpeg,.png,.tif,.tiff,image/jpeg,image/png,image/tiff" hidden
          onChange={(e) => { const f = [...(e.target.files ?? [])]; if (f.length) up.add(f); e.target.value = ''; }} />
      </div>

      {data.rescans > 0 && <RescanBanner count={data.rescans} />}

      {!data.storageReady && (
        <div className="banner">
          <span>One-time setup: let this site upload to your storage bucket.</span>
          <button className="btn" onClick={() => setupStorage()}>Apply upload rules</button>
          {setupMsg && <span className="muted">{setupMsg}</span>}
          {manualCors && (
            <div style={{ flexBasis: '100%', display: 'grid', gap: 8, marginTop: 8 }}>
              <pre style={{ margin: 0, padding: 12, background: 'var(--paper, #fff)', border: '1px solid var(--line, #ddd)', borderRadius: 6, fontSize: 12, overflowX: 'auto' }}>{manualCors.json}</pre>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" onClick={() => navigator.clipboard?.writeText(manualCors.json)}>Copy policy</button>
                <a className="btn" href="https://dash.cloudflare.com/?to=/:account/r2/overview" target="_blank" rel="noreferrer">Open Cloudflare R2</a>
                <button className="btn dark" onClick={() => setupStorage(true)}>I’ve added it</button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="tabs" role="tablist">
          {(['all', 'unpublished', 'published', 'attention'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'all' ? 'All' : t === 'attention' ? 'Needs attention' : t[0].toUpperCase() + t.slice(1)}<span className="n">{counts[t]}</span>
            </button>
          ))}
        </div>
        <input className="search" placeholder="Search filenames" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className={`drop${over ? ' over' : ''}`} onClick={() => input.current?.click()} role="button" tabIndex={0}>
        <b style={{ fontWeight: 500 }}>Drop scans anywhere on this page</b>
        <span className="rules mono">
          <span>JPEG · PNG up to 100 MB</span><span>TIFF (incl. 16-bit) up to 500 MB</span>
          <span>{LIMITS.batchFiles} files or 3 GB per batch</span><span>scans with several prints are split automatically</span>
        </span>
      </div>

      <table className="table">
        <thead>
          <tr><th>Print</th><th>File</th><th>Format</th><th>Size</th><th>Pixels</th><th>Upload</th><th>Wall</th><th>Display</th></tr>
        </thead>
        <tbody>
          {live.map((it) => <UploadingRow key={it.key} it={it} up={up} />)}
          {failedUploads.map((u) => (
            <tr key={u.id}>
              <td><span className="thumb ph">!</span></td>
              <td className="file">{u.filename}</td>
              <td className="num">—</td><td className="num">{fmtBytes(u.bytes)}</td><td className="num">—</td>
              <td><span className="st bad">Couldn&apos;t use this file</span><div className="sub">{u.error}</div></td>
              <td>—</td>
              <td><button className="link" onClick={() => startTransition(() => dismissUpload(u.id))}>Dismiss</button></td>
            </tr>
          ))}
          {rows.map((r) => <PrintRow key={r.id} r={r} onSize={(s) => startTransition(async () => { await setSize(r.id, s); router.refresh(); })} />)}
          {!rows.length && !live.length && (
            <tr><td colSpan={8} className="empty">{data.rows.length ? 'Nothing here.' : 'No scans yet. Drop some anywhere on this page.'}</td></tr>
          )}
        </tbody>
      </table>

      {items.length > 0 && <BatchPanel items={items} up={up} />}
    </>
  );
}

function PrintRow({ r, onSize }: { r: LibraryRow; onSize: (s: 'standard' | 'large') => void }) {
  const router = useRouter();
  const status = (() => {
    switch (r.status) {
      case 'processing': return <span className="st busy">Making web copies</span>;
      case 'ready': return <span className="st">Ready</span>;
      case 'needs_attention': return <><span className="st bad">Needs a look</span><div className="sub">{r.issue}</div><Link className="link" href={`/admin/prints/${r.id}`} onClick={(e) => e.stopPropagation()}>Check scan</Link>{r.duplicateOf && <ReplaceLink r={r} />}</>;
      case 'duplicate': return <><span className="st draft">{r.sharper ? 'Sharper rescan' : 'Duplicate'}</span><div className="sub">{r.issue ?? `Same print as ${r.duplicateOf ?? 'another'}`}</div>{r.duplicateOf && <ReplaceLink r={r} />}</>;
      default: return <><span className="st bad">Failed</span><div className="sub">{r.issue}</div></>;
    }
  })();
  return (
    <tr className="clickable" onClick={() => router.push(`/admin/prints/${r.id}`)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <td>{r.thumb ? <img className="thumb" src={r.thumb} alt="" loading="lazy" /> : <span className="thumb ph">{fmtType(r.mime)}</span>}</td>
      <td><span className="file">{r.filename}</span>{r.number !== r.filename.replace(/\.[^.]+$/, '') && <div className="sub">Print {r.number}</div>}</td>
      <td className="num">{fmtType(r.mime)}</td>
      <td className="num">{fmtBytes(r.bytes)}</td>
      <td className="num">{px(r.width, r.height)}</td>
      <td>{status}</td>
      <td>{r.wall === 'published' ? <span className="st">Published</span> : r.wall === 'unpublished' ? <span className="st draft">Unpublished</span> : <span className="muted">—</span>}</td>
      <td onClick={(e) => e.stopPropagation()}>
        {r.wall !== 'off' ? (
          <div className="seg">
            <button className={r.size !== 'large' ? 'on' : ''} onClick={() => onSize('standard')}>Std</button>
            <button className={r.size === 'large' ? 'on' : ''} onClick={() => onSize('large')}>Large</button>
          </div>
        ) : <span className="muted">—</span>}
      </td>
    </tr>
  );
}

function UploadingRow({ it, up }: { it: Item; up: Uploader }) {
  const pct = it.file.size ? Math.round((it.sent / it.file.size) * 100) : 0;
  const bad = it.state === 'rejected' || it.state === 'failed';
  return (
    <tr>
      <td><span className="thumb ph">{it.kind ? KIND_LABEL[it.kind as Kind] : '…'}</span></td>
      <td className="file">{it.file.name}</td>
      <td className="num">{it.kind ? KIND_LABEL[it.kind as Kind] : '—'}</td>
      <td className="num">{fmtBytes(it.file.size)}</td>
      <td className="num">{px(it.width ?? null, it.height ?? null)}</td>
      <td>
        {it.state === 'uploading' || it.state === 'finishing' ? (
          <><span className="st busy">Uploading {pct}%</span><div className="bar busy"><i style={{ width: `${pct}%` }} /></div></>
        ) : it.state === 'duplicate' ? (
          <><span className="st draft">Duplicate</span><div className="sub">{describe(it)}</div>
            <span className="row" style={{ gap: 8 }}><button className="link" onClick={() => up.skip(it.key)}>Skip</button><button className="link" onClick={() => up.keepBoth(it.key)}>Keep both</button></span></>
        ) : bad ? (
          <><span className="st bad">{it.state === 'rejected' ? 'Not accepted' : 'Upload failed'}</span><div className="sub">{it.error}</div>
            {it.state === 'failed' && it.sha256 && <button className="link" onClick={() => up.retry(it.key)}>Retry</button>}</>
        ) : (
          <span className="st busy">{describe(it)}</span>
        )}
      </td>
      <td>—</td><td>—</td>
    </tr>
  );
}

function BatchPanel({ items, up }: { items: Item[]; up: Uploader }) {
  const relevant = items.filter((i) => !['skipped', 'cancelled'].includes(i.state));
  const total = relevant.reduce((s, i) => s + i.file.size, 0);
  const sent = relevant.reduce((s, i) => s + (['processing'].includes(i.state) ? i.file.size : i.sent), 0);
  const done = relevant.filter((i) => i.state === 'processing').length;
  const flagged = items.filter((i) => ['rejected', 'failed', 'duplicate'].includes(i.state)).length;
  const active = items.filter((i) => ['uploading', 'finishing', 'checking', 'paused'].includes(i.state));
  const finished = !items.some((i) => ['checking', 'queued', 'uploading', 'finishing', 'paused'].includes(i.state));
  return (
    <div className="batch" role="status">
      <div className="top"><b style={{ fontWeight: 500 }}>{finished ? 'Upload finished' : 'Uploading batch'}</b><span className="num muted">{done} of {relevant.length}</span></div>
      <div className="bar" style={{ width: '100%' }}><i style={{ width: `${total ? (sent / total) * 100 : 0}%` }} /></div>
      <div className="mono muted" style={{ marginTop: 8 }}>{fmtBytes(sent)} of {fmtBytes(total)}{flagged ? ` · ${flagged} need${flagged === 1 ? 's' : ''} a look` : ''}</div>
      {active.length > 0 && (
        <div className="files">
          {active.slice(0, 6).map((i) => (
            <div key={i.key} className="f"><span>{i.file.name}</span><span className="num muted">{describe(i)}</span>
              <div className="bar"><i style={{ width: `${i.file.size ? (i.sent / i.file.size) * 100 : 0}%` }} /></div></div>
          ))}
        </div>
      )}
      <div className="acts" style={{ marginTop: active.length ? 0 : 12 }}>
        {!finished && (up.paused ? <button className="link" onClick={() => up.resumeAll()}>Resume all</button> : <button className="link" onClick={() => up.pauseAll()}>Pause all</button>)}
        {!finished && <button className="link" onClick={() => up.cancelPending()}>Cancel pending</button>}
        {finished && <button className="link" onClick={() => up.clearFinished()}>Close</button>}
      </div>
    </div>
  );
}

/** "Replace 069": this rescan takes over that print's spot, size and number. */
function ReplaceLink({ r }: { r: LibraryRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button className="link" disabled={pending} style={{ marginLeft: 8 }}
      title={`This scan takes ${r.duplicateOf}'s place on the wall: same spot, size and number. The old scan is kept off the wall.`}
      onClick={(e) => { e.stopPropagation(); start(async () => { await replaceWithRescan(r.id); router.refresh(); }); }}>
      {pending ? 'Replacing…' : r.issue?.startsWith('Replaced by') ? 'Swap back' : `Replace ${r.duplicateOf}`}
    </button>
  );
}

function RescanBanner({ count }: { count: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<number | null>(null);
  return (
    <div className="banner">
      <span>{done !== null ? `Replaced ${done} print${done === 1 ? '' : 's'} with the sharper rescans.` : `${count} rescan${count === 1 ? ' is' : 's are'} sharper than the print${count === 1 ? '' : 's'} on the wall. Each one can take its print's place: same spot, size and number.`}</span>
      {done === null && (
        <button className="btn dark" disabled={pending} onClick={() => start(async () => { const r = await replaceAllRescans(); setDone(r.replaced); router.refresh(); })}>
          {pending ? 'Replacing…' : count === 1 ? 'Replace it' : `Replace all ${count}`}
        </button>
      )}
    </div>
  );
}
