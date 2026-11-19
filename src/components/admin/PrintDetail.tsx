'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { printDetail } from '@/lib/admin-data';
import type { CropRect } from '@/lib/db/schema';
import { fmtBytes } from '@/lib/limits';
import { setCleanup, setSize, putOnWall, takeOffWall, removePrint, retryPrint, replaceWithRescan } from '@/app/admin/actions';

type D = NonNullable<Awaited<ReturnType<typeof printDetail>>>;
const fmtType = (mime: string) => (mime.includes('tiff') ? 'TIFF' : mime.includes('png') ? 'PNG' : 'JPEG');

export default function PrintDetail({ d }: { d: D }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [view, setView] = useState<'original' | 'web'>(d.preview ? 'original' : 'web');
  const [rect, setRect] = useState<CropRect | null>(d.cleanup?.rect ?? null);
  const [dirty, setDirty] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const p = d.print, o = d.original;
  const mode = d.cleanup?.mode ?? 'off';
  const processing = p.status === 'processing';

  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [processing, router]);

  const act = (fn: () => Promise<unknown>) => start(async () => {
    const r = (await fn()) as { error?: string } | undefined;
    if (r?.error) setMsg(r.error); else { setMsg(null); router.refresh(); }
  });

  const statusBadge = {
    processing: <span className="badge draft">Making web copies</span>,
    ready: <span className="badge">● Ready</span>,
    needs_attention: <span className="badge bad">Needs a look</span>,
    duplicate: <span className="badge draft">Duplicate{d.dupOf ? ` of ${d.dupOf}` : ''}</span>,
    failed: <span className="badge bad">Failed</span>,
  }[p.status];

  return (
    <div className="detail">
      <div className="stagebox">
        {o.analysis?.bed && view === 'original' && (
          <span className="chip">{d.siblings.length > 1 ? `${d.siblings.length} prints found on this scan` : 'Print found on a scanner bed'} — drag the box or its edges to adjust</span>
        )}
        <div className="views seg">
          {d.preview && <button className={view === 'original' ? 'on' : ''} onClick={() => setView('original')}>Whole scan</button>}
          <button className={view === 'web' ? 'on' : ''} onClick={() => setView('web')} disabled={!d.webCopy}>Web copy</button>
        </div>
        {view === 'original' && d.preview ? (
          <TrimEditor preview={d.preview} W={o.width ?? d.preview.width} H={o.height ?? d.preview.height}
            rect={mode === 'trim' || o.analysis?.bed ? rect : null}
            others={(o.analysis?.boxes ?? []).filter((_, i) => i !== p.boxIndex)}
            onChange={(r) => { setRect(r); setDirty(true); }} />
        ) : d.webCopy ? (
          // eslint-disable-next-line @next/next/no-img-element
          <div className="scanwrap"><img src={d.webCopy} alt={`Print ${p.number}`} /></div>
        ) : <span className="muted">{processing ? 'Making web copies…' : 'No web copy yet.'}</span>}
        <span className="facts mono">Original · {fmtType(o.mime)} · {o.colorProfile ?? 'no profile'} · {o.bitDepth ?? 8}-bit</span>
      </div>

      <div className="panel">
        <h2>{o.filename}</h2>
        <div className="row">{statusBadge}{d.wall === 'published' ? <span className="badge">Published</span> : d.wall === 'unpublished' ? <span className="badge draft">Unpublished</span> : <span className="badge">Not on the wall</span>}</div>
        {p.issue && <p className="issue">{p.issue}</p>}
        {msg && <p className="issue">{msg}</p>}

        <section>
          <div className="lbl">Original · never modified</div>
          <dl className="kv">
            <dt>Format</dt><dd>{fmtType(o.mime)} · {o.bitDepth ?? 8}-bit</dd>
            <dt>Colour profile</dt><dd>{o.colorProfile ?? '—'}</dd>
            <dt>Pixels</dt><dd>{o.width && o.height ? `${o.width.toLocaleString()} × ${o.height.toLocaleString()} · ${((o.width * o.height) / 1e6).toFixed(1)} MP` : '—'}</dd>
            <dt>File size</dt><dd>{fmtBytes(o.bytes)}</dd>
            <dt>Resolution</dt><dd>{o.dpi ? `${Math.round(o.dpi)} DPI (from file)` : '—'}</dd>
            <dt>Checksum</dt><dd>sha256 {o.sha256.slice(0, 8)}…{o.sha256.slice(-4)}</dd>
            <dt>Uploaded</dt><dd>{new Date(o.uploadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</dd>
          </dl>
          <div className="row" style={{ marginTop: 12 }}>
            <a className="btn" href={`/api/admin/originals/${o.id}/download`}>Download original</a>
            {d.wall !== 'published' && (confirmRemove ? (
              <span className="row"><span className="sub">{d.siblings.length > 1 ? 'Remove this print?' : 'Delete this print and its original file?'}</span>
                <button className="btn danger" disabled={pending} onClick={() => act(() => removePrint(p.id))}>Yes, remove</button>
                <button className="link" onClick={() => setConfirmRemove(false)}>Keep</button></span>
            ) : <button className="link" style={{ color: 'var(--error)' }} onClick={() => setConfirmRemove(true)}>Remove</button>)}
          </div>
        </section>

        <section>
          <div className="lbl">Web copies</div>
          <dl className="kv">
            <dt>Sizes</dt><dd>{p.copySizes?.length ? p.copySizes.map((s) => s.toLocaleString()).join(' · ') + ' px' : '—'}</dd>
            <dt>Formats</dt><dd>AVIF · WebP{d.copies.some((c) => c.format === 'jpeg') ? ' · JPEG (sharing)' : ''}</dd>
            <dt>Print size</dt><dd>{p.widthPx && p.heightPx ? `${p.widthPx.toLocaleString()} × ${p.heightPx.toLocaleString()} px` : '—'}</dd>
            <dt>Colour</dt><dd>Converted to sRGB, 8-bit</dd>
            <dt>Metadata</dt><dd>Location and camera data removed</dd>
          </dl>
          {p.status === 'failed' && <button className="btn" style={{ marginTop: 10 }} disabled={pending} onClick={() => act(() => retryPrint(p.id))}>Try again</button>}
        </section>

        <section>
          <div className="lbl">Scanner background · optional</div>
          <div className="seg">
            <button className={mode === 'off' ? 'on' : ''} disabled={pending || processing} onClick={() => act(() => setCleanup(p.id, 'off'))}>Off</button>
            <button className={mode === 'trim' ? 'on' : ''} disabled={pending || processing || !rect} onClick={() => act(() => setCleanup(p.id, 'trim'))}>Trim</button>
          </div>
          <p className="note">Trim cuts the web copies to the print&apos;s edge and straightens it. The original scan stays untouched; switch back to Off any time.</p>
          {dirty && rect && (
            <div className="row"><button className="btn dark" disabled={pending} onClick={() => act(async () => { const r = await setCleanup(p.id, 'trim', rect); setDirty(false); return r; })}>Save trim</button>
              <button className="link" onClick={() => { setRect(d.cleanup?.rect ?? null); setDirty(false); }}>Undo</button></div>
          )}
          {d.siblings.length > 1 && (
            <p className="note">From the same scan: {d.siblings.filter((s) => s.id !== p.id).map((s) => <Link key={s.id} className="link" href={`/admin/prints/${s.id}`} style={{ marginRight: 8 }}>{s.number}</Link>)}</p>
          )}
        </section>

        <section>
          <div className="lbl">On the wall</div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="seg">
              <button className={d.size !== 'large' ? 'on' : ''} disabled={pending || d.wall === 'off'} onClick={() => act(() => setSize(p.id, 'standard'))}>Standard</button>
              <button className={d.size === 'large' ? 'on' : ''} disabled={pending || d.wall === 'off'} onClick={() => act(() => setSize(p.id, 'large'))}>Large</button>
            </div>
            {d.dupOf && (p.status === 'duplicate' || p.status === 'needs_attention') && (
              <button className="btn dark" disabled={pending || processing} title={`This scan takes ${d.dupOf}'s place on the wall: same spot, size and number.`}
                onClick={() => act(() => replaceWithRescan(p.id))}>Replace {d.dupOf} with this scan</button>
            )}
            {d.wall === 'off'
              ? <button className="btn" disabled={pending || processing} onClick={() => act(() => putOnWall(p.id))}>{p.status === 'duplicate' ? 'Put on wall anyway' : 'Place on wall'}</button>
              : <span className="row"><Link className="btn" href={`/admin/wall?print=${p.id}`}>Open in wall editor</Link>{d.wall === 'unpublished' && <button className="link" onClick={() => act(() => takeOffWall(p.id))}>Take off</button>}</span>}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Whole-scan preview with the print's trim box: drag inside to move, drag an edge handle to resize. */
function TrimEditor({ preview, W, H, rect, others, onChange }: {
  preview: { url: string; width: number; height: number }; W: number; H: number;
  rect: CropRect | null; others: CropRect[]; onChange: (r: CropRect) => void;
}) {
  const img = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / W));
    ro.observe(el);
    return () => ro.disconnect();
  }, [W]);
  const drag = useRef<{ kind: string; x0: number; y0: number; r0: CropRect } | null>(null);

  const startDrag = (kind: string) => (e: React.PointerEvent) => {
    if (!rect) return;
    e.preventDefault(); e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { kind, x0: e.clientX, y0: e.clientY, r0: rect };
  };
  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g || !scale) return;
    const dx = (e.clientX - g.x0) / scale, dy = (e.clientY - g.y0) / scale;
    const a = (g.r0.angle * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
    const du = dx * ux + dy * uy, dv = -dx * uy + dy * ux; // movement in the box's own axes
    const r = { ...g.r0 };
    if (g.kind === 'move') { r.cx += dx; r.cy += dy; }
    else {
      const sgn = g.kind === 'r' || g.kind === 'b' ? 1 : -1;
      const along = g.kind === 'l' || g.kind === 'r' ? du : dv;
      const grow = Math.max(-(g.kind === 'l' || g.kind === 'r' ? g.r0.w : g.r0.h) + 40, sgn * along);
      if (g.kind === 'l' || g.kind === 'r') { r.w = g.r0.w + grow; r.cx += ux * sgn * grow / 2; r.cy += uy * sgn * grow / 2; }
      else { r.h = g.r0.h + grow; r.cx += -uy * sgn * grow / 2; r.cy += ux * sgn * grow / 2; }
    }
    onChange(r);
  };
  const end = () => { drag.current = null; };
  const box = (r: CropRect, cls: string, key?: number) => (
    <div key={key} className={`trimbox ${cls}`} style={{ left: (r.cx - r.w / 2) * scale, top: (r.cy - r.h / 2) * scale, width: r.w * scale, height: r.h * scale, transform: `rotate(${r.angle}deg)` }}
      onPointerDown={cls === 'sel' ? startDrag('move') : undefined}>
      {cls === 'sel' && (['l', 'r', 't', 'b'] as const).map((k) => (
        <span key={k} className="h" onPointerDown={startDrag(k)} style={{
          left: k === 'l' ? -6 : k === 'r' ? 'calc(100% - 5px)' : 'calc(50% - 6px)', top: k === 't' ? -6 : k === 'b' ? 'calc(100% - 5px)' : 'calc(50% - 6px)',
          cursor: k === 'l' || k === 'r' ? 'ew-resize' : 'ns-resize',
        }} />
      ))}
    </div>
  );
  return (
    <div className="scanwrap" onPointerMove={onMove} onPointerUp={end} onPointerCancel={end}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={img} src={preview.url} alt="Whole scan" draggable={false} />
      {scale > 0 && others.map((r, i) => box(r, '', i))}
      {scale > 0 && rect && box(rect, 'sel')}
    </div>
  );
}
