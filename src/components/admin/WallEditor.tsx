'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { WallLayout, WallPrint } from '@/lib/placement/service';
import { movePrint, setSize, bringTo, resetToSuggestion, resetAllDrafts, takeOffWall, publishWall, rollback, spreadWall, makeRoomOnWall } from '@/app/admin/actions';

type Hist = { id: number; status: string; publishedAt: string | null; note: string | null };
type Changes = { added: number; edited: number; removed: number; total: number };

/**
 * Placement editor. Published prints are locked (unlock one to move it); new prints show a
 * dashed gold outline at their suggested spot. Nothing goes live until Publish.
 */
export default function WallEditor({ layout, changes, history, focus }: { layout: WallLayout; changes: Changes; history: Hist[]; focus: string | null }) {
  const router = useRouter();
  const [prints, setPrints] = useState<WallPrint[]>(layout.prints);
  const [base, setBase] = useState(layout);
  if (base !== layout) { setBase(layout); setPrints(layout.prints); }
  const [sel, setSel] = useState<string | null>(focus);
  const [camState, setCam] = useState<{ z: number; tx: number; ty: number } | null>(null);
  const cam = camState ?? { z: .6, tx: 0, ty: 0 };
  const [preview, setPreview] = useState(false);
  const [showHist, setShowHist] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const stage = useRef<HTMLDivElement>(null);

  const drafts = prints.filter((p) => p.draft);
  const selected = prints.find((p) => p.id === sel) ?? null;
  const bounds = useMemo(() => {
    if (!prints.length) return { x0: 0, y0: 0, x1: layout.frame.w, y1: layout.frame.h };
    return prints.reduce((b, p) => ({ x0: Math.min(b.x0, p.x - p.w / 2), y0: Math.min(b.y0, p.y - p.h / 2), x1: Math.max(b.x1, p.x + p.w / 2), y1: Math.max(b.y1, p.y + p.h / 2) }),
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  }, [prints, layout.frame]);

  const fit = useCallback(() => {
    const vw = innerWidth, vh = innerHeight, w = bounds.x1 - bounds.x0, h = bounds.y1 - bounds.y0;
    const z = Math.min(1, (vw - 120) / w, (vh - 140) / h);
    return { z, tx: vw / 2 - (bounds.x0 + w / 2) * z, ty: vh / 2 + 20 - (bounds.y0 + h / 2) * z };
  }, [bounds]);
  // First frame on the client: fit the wall, or centre the print we were sent to.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const f = fit();
      const p = focus ? layout.prints.find((q) => q.id === focus) : undefined;
      setCam((c) => c ?? (p ? { z: f.z, tx: innerWidth / 2 - p.x * f.z, ty: innerHeight / 2 - p.y * f.z } : f));
    });
    return () => cancelAnimationFrame(raf);
  }, [fit, focus, layout.prints]);

  const zoomBy = (k: number) => {
    const z = Math.max(.15, Math.min(2, cam.z * k)), cx = innerWidth / 2, cy = innerHeight / 2;
    setCam({ z, tx: cx - ((cx - cam.tx) / cam.z) * z, ty: cy - ((cy - cam.ty) / cam.z) * z });
  };
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); };
  const patchLocal = (id: string, patch: Partial<WallPrint>) => setPrints((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const save = (fn: () => Promise<unknown>) => start(async () => { await fn(); router.refresh(); });

  /* ----- pointer: pan background, drag print, rotate handle ----- */
  const g = useRef<{ kind: 'pan' | 'move' | 'rot'; id?: string; x0: number; y0: number; tx0: number; ty0: number; px0?: number; py0?: number; moved: boolean } | null>(null);
  const toWorld = (sx: number, sy: number) => ({ x: (sx - cam.tx) / cam.z, y: (sy - cam.ty) / cam.z });

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    const pr = t.closest('[data-id]') as HTMLElement | null;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (t.classList.contains('rot') && selected) {
      g.current = { kind: 'rot', id: selected.id, x0: e.clientX, y0: e.clientY, tx0: 0, ty0: 0, moved: false };
    } else if (pr && !preview) {
      const id = pr.dataset.id!;
      const p = prints.find((q) => q.id === id)!;
      setSel(id);
      g.current = { kind: p.locked ? 'pan' : 'move', id, x0: e.clientX, y0: e.clientY, tx0: cam.tx, ty0: cam.ty, px0: p.x, py0: p.y, moved: false };
    } else {
      g.current = { kind: 'pan', x0: e.clientX, y0: e.clientY, tx0: cam.tx, ty0: cam.ty, moved: false };
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s) return;
    const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    if (!s.moved && Math.hypot(dx, dy) < 3) return;
    s.moved = true;
    if (s.kind === 'pan') setCam({ ...cam, tx: s.tx0 + dx, ty: s.ty0 + dy });
    else if (s.kind === 'move' && s.id) patchLocal(s.id, { x: Math.round(s.px0! + dx / cam.z), y: Math.round(s.py0! + dy / cam.z) });
    else if (s.kind === 'rot' && s.id) {
      const p = prints.find((q) => q.id === s.id)!;
      const w = toWorld(e.clientX, e.clientY);
      let deg = (Math.atan2(w.y - p.y, w.x - p.x) * 180) / Math.PI + 90;
      if (deg > 180) deg -= 360;
      if (!e.shiftKey) deg = Math.round(deg * 2) / 2;
      patchLocal(s.id, { r: Math.round(deg * 10) / 10 });
    }
  };
  const onUp = () => {
    const s = g.current; g.current = null;
    if (!s) return;
    if (!s.moved && s.kind === 'pan' && !s.id) setSel(null);
    if (s.moved && s.id && (s.kind === 'move' || s.kind === 'rot')) {
      const p = prints.find((q) => q.id === s.id)!;
      save(() => movePrint(p.id, { x: p.x, y: p.y, rotation: p.r }));
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const k = Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * (e.ctrlKey ? .01 : .002));
    setCam((prev) => {
      const c = prev ?? cam;
      const z = Math.max(.15, Math.min(2, c.z * k));
      const wx = (e.clientX - c.tx) / c.z, wy = (e.clientY - c.ty) / c.z;
      return { z, tx: e.clientX - wx * z, ty: e.clientY - wy * z };
    });
  };
  useEffect(() => {
    const el = stage.current;
    const stop = (e: WheelEvent) => e.preventDefault();
    el?.addEventListener('wheel', stop, { passive: false });
    return () => el?.removeEventListener('wheel', stop);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || !selected || selected.locked) return;
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) {
        e.preventDefault();
        const x = selected.x + d[0], y = selected.y + d[1];
        patchLocal(selected.id, { x, y });
        save(() => movePrint(selected.id, { x, y }));
      }
      if (e.key === 'Escape') setSel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const doPublish = () => start(async () => {
    const r = await publishWall();
    flash(`Published. ${r.count} prints are live.`);
    router.refresh();
  });

  const sorted = [...prints].sort((a, b) => a.z - b.z);
  const src = (p: WallPrint, need: number) => {
    if (!p.src || !p.sizes.length) return '';
    const s = p.sizes.find((x) => x >= need) ?? p.sizes[p.sizes.length - 1];
    return `${p.src}/${s}.webp`;
  };
  const need = Math.max(232 * cam.z * 2, 1);

  return (
    <div className="ed" ref={stage} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}>
      <div className="world" style={{ transform: `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.z})`, visibility: camState ? 'visible' : 'hidden' }}>
        {sorted.map((p) => (
          <div key={p.id} data-id={p.id}
            className={`pr${p.draft && !preview ? ' draft' : ''}${p.id === sel && !preview ? ' sel' : ''}`}
            style={{ width: p.w, height: p.h, transform: `translate(${p.x - p.w / 2}px, ${p.y - p.h / 2}px) rotate(${p.r}deg)`, cursor: preview ? 'default' : p.locked ? 'pointer' : 'move' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {p.src ? <img src={src(p, need * (p.L ? 1.5 : 1))} alt="" draggable={false} /> : null}
            {p.id === sel && !preview && !p.locked && <><span className="rot" title="Drag to rotate" /><span className="deg">{p.r.toFixed(1)}°</span></>}
          </div>
        ))}
      </div>

      {toast && <div className="toast">{toast}</div>}

      <div className="pills" style={{ left: 12, top: 12 }} onPointerDown={(e) => e.stopPropagation()}>
        <Link className="pill" href="/admin">← Library</Link>
        <span className="pill">Wall editor</span>
        {changes.total > 0 && <span className="pill" style={{ color: 'var(--draft)' }}>● Draft</span>}
      </div>

      <div className="pills" style={{ right: 12, top: 12 }} onPointerDown={(e) => e.stopPropagation()}>
        {changes.total > 0 && <span className="pill muted">{[changes.added && `${changes.added} new`, changes.edited && `${changes.edited} edited`, changes.removed && `${changes.removed} removed`].filter(Boolean).join(' · ')}</span>}
        <button className="pill" onClick={() => setShowHist((v) => !v)}>History</button>
        <button className="pill" onClick={() => { setPreview((v) => !v); setSel(null); }}>{preview ? 'Exit preview' : 'Preview'}</button>
        <button className="pill dark" disabled={pending || changes.total === 0} onClick={doPublish}>
          {changes.total ? `Publish ${changes.total} change${changes.total === 1 ? '' : 's'}` : 'Published'}
        </button>
      </div>

      {!preview && drafts.length > 0 && (
        <div className="fl new" onPointerDown={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: 'space-between' }}><b style={{ fontWeight: 500 }}>New prints</b><span className="num muted">{drafts.length}</span></div>
          <p className="note">Placed with room around them; the wall grows outward as you add more. Gold outlines aren&apos;t live until you publish.</p>
          <div className="grid">
            {drafts.map((p) => (
              <button key={p.id} className={p.id === sel ? 'on' : ''} title={p.n}
                onClick={() => { setSel(p.id); setCam({ ...cam, tx: innerWidth / 2 - p.x * cam.z, ty: innerHeight / 2 - p.y * cam.z }); }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {p.src ? <img src={`${p.src}/${p.sizes[0]}.webp`} alt={p.n} /> : <span className="mono">{p.n}</span>}
              </button>
            ))}
          </div>
          <button className="link" disabled={pending} onClick={() => save(() => resetAllDrafts(drafts.map((p) => p.id)))}>Reset all to suggestions</button>
        </div>
      )}

      {!preview && selected && !showHist && (
        <div className="fl insp" onPointerDown={(e) => e.stopPropagation()}>
          <h3>Print {selected.n}</h3>
          <span className={`badge${selected.draft ? ' draft' : ''}`}>{selected.draft ? `Draft · ${selected.source === 'manual' ? 'moved by you' : 'suggested spot'}` : selected.locked ? 'Published · locked' : 'Published · unlocked'}</span>
          <div className="two">
            <div><label>X</label><input type="number" value={selected.x} disabled={selected.locked}
              onChange={(e) => patchLocal(selected.id, { x: +e.target.value })} onBlur={() => save(() => movePrint(selected.id, { x: selected.x }))} /></div>
            <div><label>Y</label><input type="number" value={selected.y} disabled={selected.locked}
              onChange={(e) => patchLocal(selected.id, { y: +e.target.value })} onBlur={() => save(() => movePrint(selected.id, { y: selected.y }))} /></div>
          </div>
          <label>Rotation</label>
          <input type="number" step="0.1" value={selected.r} disabled={selected.locked}
            onChange={(e) => patchLocal(selected.id, { r: +e.target.value })} onBlur={() => save(() => movePrint(selected.id, { rotation: selected.r }))} />
          <label>Size</label>
          <div className="seg">
            <button className={!selected.L ? 'on' : ''} disabled={selected.locked} onClick={() => save(() => setSize(selected.id, 'standard'))}>Standard</button>
            <button className={selected.L ? 'on' : ''} disabled={selected.locked} onClick={() => save(() => setSize(selected.id, 'large'))}>Large</button>
          </div>
          <label>Layer</label>
          <div className="row">
            <button className="btn" disabled={selected.locked} onClick={() => save(() => bringTo(selected.id, 'front'))}>Bring forward</button>
            <button className="btn" disabled={selected.locked} onClick={() => save(() => bringTo(selected.id, 'back'))}>Send back</button>
          </div>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
            {selected.locked
              ? <button className="link" onClick={() => save(() => movePrint(selected.id, { locked: false }))}>Unlock to move</button>
              : !selected.draft && <button className="link" onClick={() => save(() => movePrint(selected.id, { locked: true }))}>Lock again</button>}
            {selected.draft && <button className="link" onClick={() => save(() => resetToSuggestion(selected.id))}>Reset to suggestion</button>}
            <Link className="link" href={`/admin/prints/${selected.id}`}>Open print details</Link>
            <button className="link" style={{ color: 'var(--error)' }} onClick={() => { const id = selected.id; setSel(null); save(() => takeOffWall(id)); }}>Remove from wall</button>
          </div>
        </div>
      )}

      {showHist && (
        <div className="fl hist" onPointerDown={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: 'space-between' }}><b style={{ fontWeight: 500 }}>Published versions</b><button className="link" onClick={() => setShowHist(false)}>Close</button></div>
          <ul>
            {history.map((v) => (
              <li key={v.id}>
                <span>v{v.id} · {v.publishedAt ? new Date(v.publishedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}{v.note ? <span className="muted"> · {v.note}</span> : null}</span>
                {v.status === 'published' ? <span className="muted">Live</span> : <button className="link" disabled={pending} onClick={() => start(async () => { await rollback(v.id); flash(`Version ${v.id} is live again.`); router.refresh(); })}>Roll back</button>}
              </li>
            ))}
            {!history.length && <li className="muted">Nothing published yet.</li>}
          </ul>
        </div>
      )}

      <div className="pills" style={{ left: 12, bottom: 12 }} onPointerDown={(e) => e.stopPropagation()}>
        <span className="pill">
          <button className="link" onClick={() => zoomBy(1 / 1.25)}>−</button>
          <span className="num">{Math.round(cam.z * 100)}%</span>
          <button className="link" onClick={() => zoomBy(1.25)}>+</button>
          <button className="link" onClick={() => setCam(fit())}>Fit wall</button>
        </span>
        {!preview && prints.length > 1 && (
          <span className="pill" title="Moves every print away from (or towards) the centre. Sizes and angles stay. Nothing goes live until you publish.">
            <span className="muted">Spacing</span>
            <button className="link" disabled={pending} title="Nudges prints apart just enough that none overlap and each has clear space. The arrangement stays."
              onClick={() => start(async () => { const n = await makeRoomOnWall(); flash(n ? `Made room: ${n} print${n === 1 ? '' : 's'} nudged apart.` : 'Every print already has room.'); router.refresh(); })}>Make room</button>
            <button className="link" disabled={pending} onClick={() => save(() => spreadWall('in'))}>Pull in</button>
            <button className="link" disabled={pending} onClick={() => save(() => spreadWall('out'))}>Spread out</button>
          </span>
        )}
      </div>
      <div className="pills" style={{ left: '50%', bottom: 12, transform: 'translateX(-50%)' }} onPointerDown={(e) => e.stopPropagation()}>
        <span className="pill"><span style={{ width: 12, height: 9, border: '1.5px dashed var(--draft)' }} /> New — not live yet</span>
        <span className="pill"><span style={{ width: 12, height: 9, border: '1.5px solid var(--ink-muted)' }} /> Published — locked, never moved automatically</span>
      </div>
    </div>
  );
}
