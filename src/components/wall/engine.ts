/* The Infinite Polaroid Wall — renderer and interaction.
   Framework-free so it stays fast: React renders the static shell, this drives everything inside.
   Layout comes from the published layout version (see lib/placement/service.ts). */
import type { WallLayout, WallPrint } from '@/lib/placement/service';

type El = HTMLElement;
type P = WallPrint & {
  i: number; el: HTMLButtonElement; img: HTMLImageElement; cx: number; cy: number; angle: number;
  m: number[]; minX: number; maxX: number; minY: number; maxY: number; tier: number; vis: boolean; loading: number | null;
};

export type WallOptions = {
  /** Print number to open on load (from /p/<number>). */
  openNumber?: string | null;
  /** Path for a print's own page. */
  printPath?: (n: string) => string;
  homePath?: string;
};

export function mountWall(root: El, layout: WallLayout, opts: WallOptions = {}) {
  const $ = <T extends El = El>(sel: string) => root.querySelector(sel) as T;
  const stage = $('#stage'), world = $('#world'), body = root;
  const viewer = $('#viewer'), veil = $('#veil'), vstage = $('#vstage'), vimg = $<HTMLImageElement>('#vimg');
  const vclose = $('#vclose'), vprev = $('#vprev'), vnext = $('#vnext');
  const printPath = opts.printPath ?? ((n: string) => `/p/${encodeURIComponent(n)}`);
  const homePath = opts.homePath ?? '/';

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)');
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const isNarrow = () => innerWidth < 700;
  const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
  const easeInOut = (k: number) => (k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const MAX_Z = 2, OPEN_Z = .62;
  const frame = layout.frame;
  const cleanups: (() => void)[] = [];
  const on = <K extends keyof WindowEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void, o?: AddEventListenerOptions) => {
    t.addEventListener(type, fn as EventListener, o);
    cleanups.push(() => t.removeEventListener(type, fn as EventListener, o));
  };

  let avif = false;
  { const i = new Image(); i.onload = () => { avif = i.width > 0; }; i.src = 'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A='; }

  const srcFor = (p: WallPrint, size: number, fmt: 'webp' | 'avif' = 'webp') => `${p.src}/${size}.${fmt}`;

  function setModes() {
    body.classList.toggle('is-touch', coarse.matches);
    body.classList.toggle('is-narrow', isNarrow());
  }

  function tween(dur: number, fn: (k: number) => void, done?: () => void, ease = easeOut) {
    if (reduceMotion.matches || dur <= 0) { fn(1); done?.(); return { cancel() {} }; }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      fn(ease(k));
      if (k < 1) raf = requestAnimationFrame(step); else { raf = 0; done?.(); }
    };
    raf = requestAnimationFrame(step);
    return { cancel() { if (raf) cancelAnimationFrame(raf); raf = 0; } };
  }

  /* ---------------- Prints ---------------- */
  const frag = document.createDocumentFragment();
  const prints: P[] = layout.prints.map((wp, i) => {
    const t = (wp.r * Math.PI) / 180, a = Math.cos(t), b = Math.sin(t), c = -b, d = a;
    const e = wp.x - (a * wp.w / 2 + c * wp.h / 2), f = wp.y - (b * wp.w / 2 + d * wp.h / 2);
    const xs = [e, a * wp.w + e, c * wp.h + e, a * wp.w + c * wp.h + e];
    const ys = [f, b * wp.w + f, d * wp.h + f, b * wp.w + d * wp.h + f];
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'print' + (wp.L ? ' large' : '');
    el.style.width = wp.w + 'px';
    el.style.height = wp.h + 'px';
    el.style.transform = `matrix(${a},${b},${c},${d},${e},${f})`;
    el.setAttribute('aria-label', 'Print ' + wp.n);
    el.dataset.i = String(i);
    const face = document.createElement('span');
    // Until the copy loads: its tiny blurred preview (or a plain skeleton) with a sheen.
    face.className = 'face loading' + (wp.ph ? '' : ' skeleton');
    if (wp.ph) face.style.setProperty('--ph', `url("${wp.ph}")`);
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    const loaded = () => {
      if (!face.classList.contains('loading')) return;
      face.classList.remove('loading', 'skeleton');
      face.classList.add('fading');
      setTimeout(() => face.classList.remove('fading'), 450);
    };
    img.addEventListener('load', loaded);
    img.src = srcFor(wp, wp.sizes[0]);
    if (img.complete && img.naturalWidth) loaded();
    face.appendChild(img);
    el.appendChild(face);
    frag.appendChild(el);
    return {
      ...wp, i, el, img, cx: wp.x, cy: wp.y, angle: t, m: [a, b, c, d, e, f], tier: 0, vis: true, loading: null,
      minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
    };
  });
  world.replaceChildren(frag);
  const byNumber = new Map(prints.map((p) => [p.n, p]));

  const bounds = prints.length ? prints.reduce((r, p) => ({
    minX: Math.min(r.minX, p.minX), maxX: Math.max(r.maxX, p.maxX), minY: Math.min(r.minY, p.minY), maxY: Math.max(r.maxY, p.maxY),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }) : { minX: frame.x, maxX: frame.x + frame.w, minY: frame.y, maxY: frame.y + frame.h };
  // Trimmed to the pile, then given back 20% each way (Bobby, Nov 19: the tight canvas was too tight).
  const CANVAS_GROW = 1.2;
  const canvas = (() => {
    const c = canvasAround(prints, bounds), w = c.w * CANVAS_GROW, h = c.h * CANVAS_GROW;
    return { x: c.x - (w - c.w) / 2, y: c.y - (h - c.h) / 2, w, h };
  })();

  // Opening: prints settle in from the middle outwards (once; culling would replay it).
  {
    const mx = canvas.x + canvas.w / 2, my = canvas.y + canvas.h / 2, far = Math.hypot(canvas.w, canvas.h) / 2;
    for (const p of prints) (p.el.firstChild as HTMLElement).style.setProperty('--d', Math.round(Math.min(1, Math.hypot(p.cx - mx, p.cy - my) / far) * 520) + 'ms');
    if (!coarse.matches && !isNarrow()) {
      world.classList.add('entering');
      setTimeout(() => world.classList.remove('entering'), 1300);
    }
  }

  // Reading order for ← →: rows by height on the wall, then left to right.
  const seq = (() => {
    const rows: { items: P[]; sum: number }[] = [];
    for (const p of prints.slice().sort((x, y) => x.cy - y.cy)) {
      const r = rows[rows.length - 1];
      if (r && Math.abs(p.cy - r.sum / r.items.length) < 95) { r.items.push(p); r.sum += p.cy; } else rows.push({ items: [p], sum: p.cy });
    }
    return rows.flatMap((r) => r.items.sort((x, y) => x.cx - y.cx));
  })();
  const seqIndex = new Map(seq.map((p, i) => [p, i]));

  /* ---------------- Camera ---------------- */
  let z = .7, tx = 0, ty = 0, minZ = .35;
  let camAnim: { cancel(): void } | null = null, inertiaRaf = 0;
  let movingTimer: ReturnType<typeof setTimeout> | undefined, tierTimer: ReturnType<typeof setTimeout> | undefined;

  // The canvas is the pile itself (sparse edges trimmed, see canvasAround): the view never shows
  // past it, so the screen is always full of prints.
  /** Smallest zoom at which the canvas still fills the window. */
  function coverZ() {
    return Math.max(innerWidth / canvas.w, innerHeight / canvas.h);
  }
  function initialZ() {
    // Desktop opens close in (about 62%, the view Bobby picked on Nov 18). Phones open as far out
    // as the canvas allows.
    return Math.min(1.2, isNarrow() ? coverZ() : Math.max(OPEN_Z, coverZ()));
  }
  function initialView() {
    const iz = initialZ();
    return { z: iz, tx: innerWidth / 2 - (canvas.x + canvas.w / 2) * iz, ty: innerHeight / 2 - (canvas.y + canvas.h / 2) * iz };
  }
  function computeLimits() {
    minZ = Math.min(MAX_Z, coverZ());
  }
  function clampPan() {
    const fit = (t: number, lo: number, size: number, view: number) =>
      size * z <= view ? (view - size * z) / 2 - lo * z : clamp(t, view - (lo + size) * z, -lo * z);
    tx = fit(tx, canvas.x, canvas.w, innerWidth);
    ty = fit(ty, canvas.y, canvas.h, innerHeight);
  }
  function apply() {
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    cull();
  }
  function markMoving() {
    world.classList.add('moving');
    clearTimeout(movingTimer);
    movingTimer = setTimeout(() => world.classList.remove('moving'), 160);
    clearTimeout(tierTimer);
    tierTimer = setTimeout(upgradeTiers, 140);
  }
  function stopMotion() {
    if (camAnim) { camAnim.cancel(); camAnim = null; }
    if (inertiaRaf) { cancelAnimationFrame(inertiaRaf); inertiaRaf = 0; }
  }
  function zoomAt(nz: number, sx: number, sy: number) {
    nz = clamp(nz, minZ, MAX_Z);
    const wx = (sx - tx) / z, wy = (sy - ty) / z;
    z = nz; tx = sx - wx * z; ty = sy - wy * z;
    clampPan(); apply(); markMoving();
  }
  function animateZoomAt(nz: number, sx: number, sy: number, dur = 240) {
    stopMotion();
    nz = clamp(nz, minZ, MAX_Z);
    const z0 = z, wx = (sx - tx) / z, wy = (sy - ty) / z;
    camAnim = tween(dur, (k) => {
      z = z0 * Math.pow(nz / z0, k); tx = sx - wx * z; ty = sy - wy * z;
      clampPan(); apply(); markMoving();
    }, () => { camAnim = null; });
  }
  function animateTo(v: { z: number; tx: number; ty: number }, dur = 360, ease = easeInOut) {
    stopMotion();
    const s = { z, tx, ty };
    camAnim = tween(dur, (k) => {
      z = s.z * Math.pow(v.z / s.z, k); tx = s.tx + (v.tx - s.tx) * k; ty = s.ty + (v.ty - s.ty) * k;
      apply(); markMoving();
    }, () => { camAnim = null; clampPan(); apply(); }, ease);
  }
  /** Smallest camera move that brings a print into the middle 60% of the screen. */
  function bringIntoView(p: P) {
    const vw = innerWidth, vh = innerHeight;
    const sx = p.cx * z + tx, sy = p.cy * z + ty, ix = vw * .2, iy = vh * .2;
    const dx = sx < ix ? ix - sx : sx > vw - ix ? (vw - ix) - sx : 0;
    const dy = sy < iy ? iy - sy : sy > vh - iy ? (vh - iy) - sy : 0;
    const keep = { tx, ty };
    tx += dx; ty += dy; clampPan();
    const v = { z, tx, ty };
    tx = keep.tx; ty = keep.ty;
    return v;
  }

  function cull() {
    const m = 300;
    const x0 = (-m - tx) / z, x1 = (innerWidth + m - tx) / z, y0 = (-m - ty) / z, y1 = (innerHeight + m - ty) / z;
    for (const p of prints) {
      const vis = p.maxX >= x0 && p.minX <= x1 && p.maxY >= y0 && p.minY <= y1;
      if (vis !== p.vis) { p.vis = vis; p.el.style.display = vis ? '' : 'none'; }
    }
  }
  /** Load sharper copies for visible prints when the zoom needs them. */
  function upgradeTiers() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const p of prints) {
      if (!p.vis || !p.sizes.length) continue;
      const need = Math.max(p.w, p.h) * z * dpr;
      let want = p.sizes.findIndex((s) => s >= need * 0.95);
      if (want < 0) want = p.sizes.length - 1;
      if (want <= p.tier || p.loading === want) continue;
      p.loading = want;
      const im = new Image();
      im.src = srcFor(p, p.sizes[want]);
      const w = want;
      im.decode().then(() => {
        if (w > p.tier) { p.img.src = im.src; p.tier = w; }
        if (p.loading === w) p.loading = null;
      }, () => { if (p.loading === w) p.loading = null; });
    }
  }

  /* ---------------- Wall input ---------------- */
  const pointers = new Map<number, { x: number; y: number }>();
  type Drag = { x0: number; y0: number; lx: number; ly: number; moved: boolean; print: HTMLElement | null; samples: number[][] };
  let drag: Drag | null = null, pinch: { cx: number; cy: number; d: number; z0: number; wx: number; wy: number } | null = null;
  let lastTap: { t: number; x: number; y: number } | null = null;

  const clearPressed = () => { for (const el of world.querySelectorAll('.pressed')) el.classList.remove('pressed'); };
  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }

  on(stage, 'pointerdown', (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stopMotion();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (pointers.size === 1) {
      const pe = (e.target as El).closest?.('.print') as El | null;
      drag = { x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, print: pe, samples: [[performance.now(), e.clientX, e.clientY]] };
      pe?.classList.add('pressed');
    } else if (pointers.size === 2) {
      const s = pinchState();
      pinch = { ...s, z0: z, wx: (s.cx - tx) / z, wy: (s.cy - ty) / z };
      if (drag) drag.moved = true;
      clearPressed();
    }
  });

  on(stage, 'pointermove', (e: PointerEvent) => {
    const pt = pointers.get(e.pointerId);
    if (!pt) return;
    pt.x = e.clientX; pt.y = e.clientY;
    if (pinch && pointers.size >= 2) {
      const s = pinchState();
      z = clamp(pinch.z0 * s.d / pinch.d, minZ, MAX_Z);
      tx = s.cx - pinch.wx * z; ty = s.cy - pinch.wy * z;
      clampPan(); apply(); markMoving();
      return;
    }
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > (e.pointerType === 'mouse' ? 4 : 8)) {
      drag.moved = true; drag.lx = drag.x0; drag.ly = drag.y0;
      stage.classList.add('dragging');
      clearPressed();
    }
    if (drag.moved) { tx += e.clientX - drag.lx; ty += e.clientY - drag.ly; clampPan(); apply(); markMoving(); }
    drag.lx = e.clientX; drag.ly = e.clientY;
    drag.samples.push([performance.now(), e.clientX, e.clientY]);
    if (drag.samples.length > 8) drag.samples.shift();
  });

  function startInertia(samples: number[][]) {
    if (reduceMotion.matches) return;
    const now = performance.now();
    const recent = samples.filter((q) => now - q[0] < 100);
    if (recent.length < 2) return;
    const a = recent[0], b = recent[recent.length - 1], dt = b[0] - a[0];
    if (dt <= 0) return;
    let vx = (b[1] - a[1]) / dt, vy = (b[2] - a[2]) / dt;
    if (Math.hypot(vx, vy) < .15) return;
    let last = now;
    const step = (t: number) => {
      const d = Math.min(32, t - last); last = t;
      const bx = tx + vx * d, by = ty + vy * d;
      tx = bx; ty = by; clampPan();
      if (tx !== bx) vx = 0;
      if (ty !== by) vy = 0;
      apply(); markMoving();
      const f = Math.pow(.995, d); vx *= f; vy *= f;
      inertiaRaf = Math.hypot(vx, vy) > .02 ? requestAnimationFrame(step) : 0;
    };
    inertiaRaf = requestAnimationFrame(step);
  }

  function onUp(e: { pointerId: number; type: string; clientX?: number; clientY?: number }) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) {
        const [p] = pointers.values();
        drag = { x0: p.x, y0: p.y, lx: p.x, ly: p.y, moved: true, print: null, samples: [[performance.now(), p.x, p.y]] };
      } else drag = null;
      return;
    }
    if (!drag) return;
    const d = drag; drag = null;
    clearPressed();
    stage.classList.remove('dragging');
    if (e.type !== 'pointerup') return;
    if (d.moved) { startInertia(d.samples); return; }
    if (d.print) { openViewer(prints[+d.print.dataset.i!]); lastTap = null; return; }
    const now = performance.now(), x = e.clientX!, y = e.clientY!;
    if (lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) { animateZoomAt(z * 1.6, x, y); lastTap = null; }
    else lastTap = { t: now, x, y };
  }
  on(stage, 'pointerup', onUp);
  on(stage, 'pointercancel', onUp);
  on(stage, 'lostpointercapture', (e: PointerEvent) => { if (pointers.has(e.pointerId)) onUp({ pointerId: e.pointerId, type: 'pointercancel' }); });

  // Keyboard activation of a print (Enter / Space). Pointer clicks are handled above.
  on(stage, 'click', (e: MouseEvent) => {
    const pe = (e.target as El).closest?.('.print') as El | null;
    if (pe && e.detail === 0) openViewer(prints[+pe.dataset.i!]);
  });

  on(stage, 'wheel', (e: WheelEvent) => {
    e.preventDefault();
    if (V.open) return;
    stopMotion();
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= innerWidth; dy *= innerHeight; }
    // Trackpad pinch (and Ctrl + wheel) zooms; plain two-finger scrolling moves the wall any direction.
    if (e.ctrlKey) {
      if (gesture) return; // Safari reports the same pinch as gesture events
      zoomAt(z * Math.exp(-clamp(dy, -120, 120) * .01), e.clientX, e.clientY);
      return;
    }
    tx -= dx; ty -= dy; clampPan(); apply(); markMoving();
  }, { passive: false });

  // Safari sends trackpad pinches as gesture events (scale relative to the start of the pinch).
  type GestureLike = Event & { scale: number; clientX: number; clientY: number };
  let gesture: { z0: number; s0: number } | null = null;
  on(document, 'gesturestart', (e: GestureLike) => {
    e.preventDefault();
    gesture = { z0: z, s0: V.s };
    stopMotion();
  });
  on(document, 'gesturechange', (e: GestureLike) => {
    e.preventDefault();
    if (!gesture) return;
    const x = e.clientX || innerWidth / 2, y = e.clientY || innerHeight / 2;
    if (V.open) { if (!V.anim) zoomViewerAt(gesture.s0 * e.scale, x, y); }
    else zoomAt(gesture.z0 * e.scale, x, y);
  });
  on(document, 'gestureend', (e: GestureLike) => { e.preventDefault(); gesture = null; });

  /* ---------------- Viewer ---------------- */
  const V = {
    open: false, p: null as P | null, fit: { x: 0, y: 0, w: 1, h: 1 },
    cx: 0, cy: 0, s: 1, angle: 0, anim: null as { cancel(): void } | null, pushed: false, lastFocus: null as El | null,
  };

  function fitRect(p: P) {
    const vw = innerWidth, vh = innerHeight;
    const maxW = isNarrow() ? vw - 32 : vw - 280;
    const maxH = isNarrow() ? vh - 240 : vh * .74;
    const iw = p.iw || p.w * 4, ih = p.ih || p.h * 4;
    const k = Math.min(maxW / iw, maxH / ih, 1); // never enlarged past the scan's real pixels
    const w = iw * k, h = ih * k;
    return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
  }
  const maxScale = () => Math.max(1, (V.p!.iw || 1) / V.fit.w);
  function drawImg() {
    const f = V.fit;
    vimg.style.transform = `translate(${V.cx - f.w / 2}px, ${V.cy - f.h / 2}px) rotate(${V.angle}rad) scale(${V.s})`;
    vstage.classList.toggle('zoomed', V.s > 1.01);
    vimg.style.cursor = V.s > 1.01 ? '' : (maxScale() > 1.01 ? 'zoom-in' : 'default');
  }
  function setFit(p: P) {
    V.fit = fitRect(p);
    vimg.style.width = V.fit.w + 'px';
    vimg.style.height = V.fit.h + 'px';
  }
  const restPose = () => ({ cx: V.fit.x + V.fit.w / 2, cy: V.fit.y + V.fit.h / 2, s: 1, angle: 0 });
  const wallPose = (p: P) => ({ cx: p.cx * z + tx, cy: p.cy * z + ty, s: (p.w * z) / V.fit.w, angle: p.angle });
  function animatePose(to: { cx: number; cy: number; s: number; angle: number }, dur: number, ease: (k: number) => number, done?: () => void) {
    V.anim?.cancel();
    const from = { cx: V.cx, cy: V.cy, s: V.s, angle: V.angle };
    V.anim = tween(dur, (k) => {
      V.cx = from.cx + (to.cx - from.cx) * k; V.cy = from.cy + (to.cy - from.cy) * k;
      V.s = from.s * Math.pow(to.s / from.s, k); V.angle = from.angle + (to.angle - from.angle) * k;
      drawImg();
    }, () => { V.anim = null; done?.(); }, ease);
  }
  function loadFull(p: P) {
    const top = p.sizes[p.sizes.length - 1];
    if (!top) return;
    const im = new Image();
    im.src = srcFor(p, top, avif ? 'avif' : 'webp');
    im.decode().then(() => { if (V.p === p && V.open) vimg.src = im.src; }, () => {});
  }
  function setUrl(p: P | null) {
    try {
      if (p) {
        const url = printPath(p.n);
        if (!V.pushed) { history.pushState({ print: p.n }, '', url); V.pushed = true; } else history.replaceState({ print: p.n }, '', url);
        document.title = `${p.n} — Bobby Banks Polaroids`;
      } else {
        history.replaceState(null, '', homePath);
        document.title = 'Bobby Banks — Polaroids';
      }
    } catch { /* ignore */ }
  }

  function openViewer(p: P | undefined, o: { instant?: boolean; fromUrl?: boolean } = {}) {
    if (!p) return;
    if (V.open) { if (p !== V.p) switchTo(p, 1); return; }
    stopMotion();
    V.open = true; V.p = p; V.lastFocus = p.el;
    body.classList.add('viewing');
    viewer.hidden = false;
    vimg.style.backgroundImage = p.ph ? `url("${p.ph}")` : '';
    vimg.src = p.img.src;
    vimg.alt = 'Print ' + p.n;
    setFit(p);
    Object.assign(V, wallPose(p));
    drawImg();
    p.el.classList.add('away');
    requestAnimationFrame(() => viewer.classList.add('open'));
    animatePose(restPose(), o.instant ? 0 : 320, easeOut);
    loadFull(p);
    if (!o.fromUrl) setUrl(p);
    viewer.focus({ preventScroll: true });
  }

  function closeViewer(fromHistory = false) {
    if (!V.open || !V.p) return;
    const p = V.p;
    V.open = false;
    viewer.classList.remove('open');
    animatePose(wallPose(p), 300, easeInOut, () => {
      p.el.classList.remove('away');
      viewer.hidden = true;
      body.classList.remove('viewing');
      vimg.removeAttribute('src');
      V.p = null;
      V.lastFocus?.focus({ preventScroll: true });
    });
    if (!fromHistory) {
      if (V.pushed) { V.pushed = false; try { history.back(); } catch { setUrl(null); } }
      else setUrl(null);
    } else V.pushed = false;
    document.title = 'Bobby Banks — Polaroids';
  }

  function switchTo(q: P | undefined, dir: number, axis: 'x' | 'y' = 'x') {
    const p = V.p;
    if (!q || !p || q === p) return;
    V.anim?.cancel();
    const ghost = vimg.cloneNode() as HTMLImageElement;
    ghost.removeAttribute('id');
    ghost.className = 'ghost';
    vstage.appendChild(ghost);
    const g0 = { cx: V.cx, s: V.s, w: V.fit.w, h: V.fit.h, cy: V.cy };
    tween(240, (k) => {
      const dx = axis === 'x' ? dir * 70 * k : 0, dy = axis === 'y' ? dir * 70 * k : 0;
      ghost.style.transform = `translate(${g0.cx - g0.w / 2 - dx}px, ${g0.cy - g0.h / 2 - dy}px) scale(${g0.s})`;
      ghost.style.opacity = String(1 - k);
    }, () => ghost.remove());
    p.el.classList.remove('away');
    q.el.classList.add('away');
    V.p = q; V.lastFocus = q.el;
    vimg.style.backgroundImage = q.ph ? `url("${q.ph}")` : '';
    vimg.src = q.img.src;
    vimg.alt = 'Print ' + q.n;
    setFit(q);
    const rest = restPose();
    Object.assign(V, rest, axis === 'x' ? { cx: rest.cx + dir * 70 } : { cy: rest.cy + dir * 70 });
    vimg.style.opacity = '0';
    drawImg();
    tween(280, (k) => { vimg.style.opacity = String(k); });
    animatePose(rest, 280, easeOut);
    loadFull(q);
    setUrl(q);
    animateTo(bringIntoView(q), 420); // the wall follows behind the veil
  }
  function go(dir: number) {
    if (!V.open || !V.p) return;
    const i = seqIndex.get(V.p)!;
    switchTo(seq[(i + dir + seq.length) % seq.length], dir);
  }
  /** ↑ / ↓: the print just above or below on the wall; past the top or bottom, wraps round. */
  function goVertical(dir: number) {
    if (!V.open || !V.p) return;
    const p = V.p;
    let best: P | undefined, score = Infinity;
    // Nearest print in a cone above/below; failing that, anything further up/down in that column.
    for (const q of prints) {
      const dy = (q.cy - p.cy) * dir, dx = Math.abs(q.cx - p.cx);
      if (q === p || dy < 40) continue;
      const s = dx <= dy * 1.2 ? dy + dx : 1e6 + dy + dx * 2.5;
      if (s < score) { score = s; best = q; }
    }
    if (!best) {
      // Wrap: the print nearest this column at the far edge.
      for (const q of prints) {
        if (q === p) continue;
        const s = (q.cy - p.cy) * dir + Math.abs(q.cx - p.cx) * 0.5;
        if (s < score) { score = s; best = q; }
      }
    }
    switchTo(best, dir, 'y');
  }

  function clampViewerPan(cx: number, cy: number, s: number) {
    const W = V.fit.w * s, H = V.fit.h * s, vw = innerWidth, vh = innerHeight, r = restPose();
    return { cx: W <= vw ? r.cx : clamp(cx, vw - W / 2, W / 2), cy: H <= vh ? r.cy : clamp(cy, vh - H / 2, H / 2) };
  }
  function zoomViewerAt(ns: number, sx: number, sy: number, dur = 0) {
    ns = clamp(ns, 1, maxScale());
    const r = restPose();
    let cx = sx + (V.cx - sx) * (ns / V.s), cy = sy + (V.cy - sy) * (ns / V.s);
    if (ns <= 1.001) { cx = r.cx; cy = r.cy; }
    const c = clampViewerPan(cx, cy, ns);
    if (dur) animatePose({ cx: c.cx, cy: c.cy, s: ns, angle: 0 }, dur, easeOut);
    else { V.s = ns; V.cx = c.cx; V.cy = c.cy; drawImg(); }
  }

  on(vclose, 'click', () => closeViewer());
  on(vprev, 'click', () => go(-1));
  on(vnext, 'click', () => go(1));
  on(vstage, 'wheel', (e: WheelEvent) => {
    e.preventDefault();
    if (!V.open || V.anim) return;
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= innerWidth; dy *= innerHeight; }
    if (e.ctrlKey) {
      if (gesture) return;
      zoomViewerAt(V.s * Math.exp(-clamp(dy, -120, 120) * .01), e.clientX, e.clientY);
      return;
    }
    if (V.s > 1.001) { const c = clampViewerPan(V.cx - dx, V.cy - dy, V.s); V.cx = c.cx; V.cy = c.cy; drawImg(); }
  }, { passive: false });

  const vp = new Map<number, { x: number; y: number }>();
  type VG = { x0: number; y0: number; lx: number; ly: number; mode: string | null; onImg: boolean; type: string; samples: number[][] };
  let vg: VG | null = null, vpinch: { d: number; s0: number; cx: number; cy: number; pcx: number; pcy: number } | null = null;
  let vLastTap: { t: number; x: number; y: number } | null = null;
  on(vstage, 'pointerdown', (e: PointerEvent) => {
    if (!V.open || (e.pointerType === 'mouse' && e.button !== 0)) return;
    vp.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { vstage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (vp.size === 1) {
      vg = { x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, mode: null, onImg: e.target === vimg, type: e.pointerType, samples: [[performance.now(), e.clientX, e.clientY]] };
    } else if (vp.size === 2) {
      const [a, b] = [...vp.values()];
      vpinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), s0: V.s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, pcx: V.cx, pcy: V.cy };
      if (vg) vg.mode = 'pinch';
    }
  });
  on(vstage, 'pointermove', (e: PointerEvent) => {
    const pt = vp.get(e.pointerId);
    if (!pt || !V.open) return;
    pt.x = e.clientX; pt.y = e.clientY;
    if (vpinch && vp.size >= 2) {
      const [a, b] = [...vp.values()];
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ns = clamp(vpinch.s0 * d / vpinch.d, 1, maxScale());
      const c = clampViewerPan(mx + (vpinch.pcx - vpinch.cx) * (ns / vpinch.s0), my + (vpinch.pcy - vpinch.cy) * (ns / vpinch.s0), ns);
      V.s = ns; V.cx = c.cx; V.cy = c.cy; drawImg();
      return;
    }
    if (!vg || V.anim) return;
    const dx = e.clientX - vg.x0, dy = e.clientY - vg.y0;
    if (!vg.mode && Math.hypot(dx, dy) > 8) {
      vg.mode = V.s > 1.01 ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'swipe-x' : (dy > 0 ? 'swipe-down' : 'none');
      if (vg.mode === 'pan') vstage.classList.add('panning');
    }
    const r = restPose();
    if (vg.mode === 'pan') { const c = clampViewerPan(V.cx + e.clientX - vg.lx, V.cy + e.clientY - vg.ly, V.s); V.cx = c.cx; V.cy = c.cy; drawImg(); }
    else if (vg.mode === 'swipe-x') { V.cx = r.cx + dx; drawImg(); }
    else if (vg.mode === 'swipe-down') {
      V.cy = r.cy + Math.max(0, dy); V.s = 1 - Math.min(.25, Math.max(0, dy) / 1600);
      veil.style.opacity = String(1 - Math.min(.6, Math.max(0, dy) / 500));
      drawImg();
    }
    vg.lx = e.clientX; vg.ly = e.clientY;
    vg.samples.push([performance.now(), e.clientX, e.clientY]);
    if (vg.samples.length > 8) vg.samples.shift();
  });
  function vUp(e: PointerEvent) {
    if (!vp.has(e.pointerId)) return;
    vp.delete(e.pointerId);
    if (vpinch) { if (vp.size < 2) vpinch = null; vg = null; return; }
    const g = vg; vg = null;
    vstage.classList.remove('panning');
    if (!g || !V.open || e.type !== 'pointerup') { if (V.open && g?.mode && g.mode !== 'pan') animatePose(restPose(), 220, easeOut); veil.style.opacity = ''; return; }
    const now = performance.now();
    const recent = g.samples.filter((q) => now - q[0] < 100);
    const span = recent.length > 1 ? Math.max(1, recent[recent.length - 1][0] - recent[0][0]) : 1;
    const v = recent.length > 1 ? (recent[recent.length - 1][1] - recent[0][1]) / span : 0;
    const vy = recent.length > 1 ? (recent[recent.length - 1][2] - recent[0][2]) / span : 0;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (g.mode === 'swipe-x') {
      if (dx < -60 || v < -.45) go(1); else if (dx > 60 || v > .45) go(-1); else animatePose(restPose(), 220, easeOut);
      return;
    }
    if (g.mode === 'swipe-down') {
      veil.style.opacity = '';
      if (dy > 110 || vy > .6) closeViewer(); else animatePose(restPose(), 220, easeOut);
      return;
    }
    if (g.mode) return;
    if (g.onImg && g.type === 'mouse') { zoomViewerAt(V.s > 1.01 ? 1 : maxScale(), e.clientX, e.clientY, 260); return; }
    if (vLastTap && now - vLastTap.t < 320 && Math.hypot(e.clientX - vLastTap.x, e.clientY - vLastTap.y) < 30) {
      vLastTap = null;
      zoomViewerAt(V.s > 1.01 ? 1 : maxScale(), e.clientX, e.clientY, 260);
      return;
    }
    if (!g.onImg) { closeViewer(); return; }
    vLastTap = { t: now, x: e.clientX, y: e.clientY };
  }
  on(vstage, 'pointerup', vUp);
  on(vstage, 'pointercancel', vUp);

  /* ---------------- Keyboard ---------------- */
  on(document, 'keydown', (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (V.open) {
      if (e.key === 'Escape') { e.preventDefault(); closeViewer(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); goVertical(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); goVertical(-1); }
      else if (e.key === '+' || e.key === '=') zoomViewerAt(V.s * 1.25, innerWidth / 2, innerHeight / 2, 200);
      else if (e.key === '-') zoomViewerAt(V.s / 1.25, innerWidth / 2, innerHeight / 2, 200);
      else if (e.key === 'Tab') {
        const f = [vclose, vprev, vnext];
        const i = f.indexOf(document.activeElement as El);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
      return;
    }
    const step = 90;
    switch (e.key) {
      case '+': case '=': animateZoomAt(z * 1.25, innerWidth / 2, innerHeight / 2); break;
      case '-': case '_': animateZoomAt(z / 1.25, innerWidth / 2, innerHeight / 2); break;
      case '0': animateTo(initialView(), 420); break;
      case 'ArrowLeft': tx += step; break;
      case 'ArrowRight': tx -= step; break;
      case 'ArrowUp': ty += step; break;
      case 'ArrowDown': ty -= step; break;
      default: return;
    }
    if (e.key.startsWith('Arrow')) { e.preventDefault(); stopMotion(); clampPan(); apply(); markMoving(); }
  });

  /* ---------------- URLs (/p/100) ---------------- */
  const numberFromPath = () => {
    const m = location.pathname.match(/\/p\/([^/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  on(window, 'popstate', () => {
    const n = numberFromPath(), p = n ? byNumber.get(n) : undefined;
    if (p) {
      if (!V.open) { V.pushed = false; const c = bringIntoView(p); ({ z, tx, ty } = c); apply(); openViewer(p, { fromUrl: true }); }
      else if (p !== V.p) switchTo(p, 1);
    } else if (V.open) closeViewer(true);
  });

  /* ---------------- Resize ---------------- */
  let rz = 0;
  on(window, 'resize', () => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(() => {
      setModes(); computeLimits();
      z = clamp(z, minZ, MAX_Z);
      clampPan(); apply(); upgradeTiers();
      if (V.open && !V.anim && V.p) { setFit(V.p); Object.assign(V, restPose()); drawImg(); }
    });
  });
  on(coarse, 'change', setModes);

  /* ---------------- Start ---------------- */
  setModes();
  computeLimits();
  ({ z, tx, ty } = initialView());
  clampPan(); apply();
  requestAnimationFrame(upgradeTiers);
  (window as unknown as { __wall: unknown }).__wall = { get z() { return z; }, get minZ() { return minZ; }, prints };
  const start = opts.openNumber ? byNumber.get(opts.openNumber) : undefined;
  if (start) {
    const c = bringIntoView(start); ({ z, tx, ty } = c); apply();
    setTimeout(() => openViewer(start, { fromUrl: true }), 250);
  }

  return () => {
    stopMotion();
    for (const c of cleanups) c();
    clearTimeout(movingTimer); clearTimeout(tierTimer);
  };
}

/**
 * The wall's canvas: the prints' bounding box with its sparse fringe trimmed, so panning never
 * shows empty background beyond the pile. A side moves in only while its edge is partly empty and
 * every print keeps at least 80% of its width and 55% of its height on the canvas (the height is
 * trimmed harder: the wall reads wide and full).
 */
function canvasAround(boxes: { minX: number; maxX: number; minY: number; maxY: number }[], b: { minX: number; maxX: number; minY: number; maxY: number }) {
  let r = { x0: b.minX, x1: b.maxX, y0: b.minY, y1: b.maxY };
  if (boxes.length > 1) {
    const KEEP_X = .8, KEEP_Y = .55, STEP = 12, N = 40;
    const ok = (q: typeof r) => boxes.every((p) =>
      (Math.min(p.maxX, q.x1) - Math.max(p.minX, q.x0)) / (p.maxX - p.minX) >= KEEP_X &&
      (Math.min(p.maxY, q.y1) - Math.max(p.minY, q.y0)) / (p.maxY - p.minY) >= KEEP_Y);
    const covered = (x: number, y: number) => boxes.some((p) => x >= p.minX && x <= p.maxX && y >= p.minY && y <= p.maxY);
    /** Share of an edge with no print on it. */
    const empty = (q: typeof r, side: number) => {
      let e = 0;
      for (let k = 0; k < N; k++) {
        const t = (k + .5) / N, x = q.x0 + t * (q.x1 - q.x0), y = q.y0 + t * (q.y1 - q.y0);
        if (!(side === 0 ? covered(x, q.y0 + 4) : side === 1 ? covered(x, q.y1 - 4) : side === 2 ? covered(q.x0 + 4, y) : covered(q.x1 - 4, y))) e++;
      }
      return e / N;
    };
    for (let guard = 0; guard < 4000; guard++) {
      let pick: typeof r | null = null, most = 0;
      for (let side = 0; side < 4; side++) {
        const e = empty(r, side);
        if (e <= most) continue;
        const q = { ...r };
        if (side === 0) q.y0 += STEP; else if (side === 1) q.y1 -= STEP; else if (side === 2) q.x0 += STEP; else q.x1 -= STEP;
        if (ok(q)) { pick = q; most = e; }
      }
      if (!pick) break;
      r = pick;
    }
  }
  return { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 };
}
