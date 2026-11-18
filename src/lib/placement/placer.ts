/**
 * Suggests where a new print goes on the wall. Pure function: no database, no randomness
 * other than a generator seeded by the print id, so asking twice gives the same answer.
 *
 * Rules (from the plan):
 * - Prints already on the wall are fixed obstacles; they never move.
 * - Fill open gaps in the wall first, then extend at the edges with the same row rhythm.
 * - A new print may cover the edge of an existing one by up to ~12% of that print's area.
 * - Suggest Large when large prints are under 10% of the wall and no large one sits within ~340 px.
 * - Rotation: 85% within ±3°, 10% up to ±6°, 5% accents at 7–12°.
 */

export type Placed = {
  id: string;
  x: number; y: number;      // centre, wall px
  w: number; h: number;      // box at its current size (already ×1.5 for large)
  rotation: number;          // degrees
  large: boolean;
  layer: number;
};

export type Suggestion = { x: number; y: number; rotation: number; large: boolean; layer: number };

export type PlacerOptions = {
  /** Max share of an existing print a new one may cover. 0 turns overlap off. */
  maxOverlap?: number;
  /** Allow suggesting Large at all (manual picks always win). */
  allowLarge?: boolean;
};

/** Mulberry32 seeded by a string. */
export function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRotation(r: () => number) {
  const u = r(), sign = r() < 0.5 ? -1 : 1;
  if (u < 0.85) return Math.round((r() * 6 - 3) * 100) / 100;
  if (u < 0.95) return Math.round(sign * (3 + r() * 3) * 100) / 100;
  return Math.round(sign * (7 + r() * 5) * 100) / 100;
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Axis-aligned bounds of a rotated box. */
function aabb(x: number, y: number, w: number, h: number, rotDeg: number): Rect {
  const a = (rotDeg * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const hw = (w * c + h * s) / 2, hh = (w * s + h * c) / 2;
  return { x0: x - hw, y0: y - hh, x1: x + hw, y1: y + hh };
}
const inter = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Coverage raster (8 px cells) with a summed-area table for fast "how empty is this box". */
class Coverage {
  readonly cell = 8;
  ox: number; oy: number; cols: number; rows: number; sat: Float64Array;
  constructor(prints: Placed[], pad: number) {
    const b = prints.reduce((r, p) => {
      const q = aabb(p.x, p.y, p.w, p.h, p.rotation);
      return { x0: Math.min(r.x0, q.x0), y0: Math.min(r.y0, q.y0), x1: Math.max(r.x1, q.x1), y1: Math.max(r.y1, q.y1) };
    }, { x0: 0, y0: 0, x1: 1, y1: 1 });
    this.ox = Math.floor(b.x0 - pad); this.oy = Math.floor(b.y0 - pad);
    this.cols = Math.ceil((b.x1 + pad - this.ox) / this.cell); this.rows = Math.ceil((b.y1 + pad - this.oy) / this.cell);
    const grid = new Uint8Array(this.cols * this.rows);
    for (const p of prints) {
      const a = (p.rotation * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
      const q = aabb(p.x, p.y, p.w, p.h, p.rotation);
      for (let cy = Math.max(0, Math.floor((q.y0 - this.oy) / this.cell)); cy <= Math.min(this.rows - 1, Math.floor((q.y1 - this.oy) / this.cell)); cy++) {
        for (let cx = Math.max(0, Math.floor((q.x0 - this.ox) / this.cell)); cx <= Math.min(this.cols - 1, Math.floor((q.x1 - this.ox) / this.cell)); cx++) {
          const wx = this.ox + (cx + 0.5) * this.cell - p.x, wy = this.oy + (cy + 0.5) * this.cell - p.y;
          const u = wx * ca + wy * sa, v = -wx * sa + wy * ca;
          if (Math.abs(u) <= p.w / 2 && Math.abs(v) <= p.h / 2) grid[cy * this.cols + cx] = 1;
        }
      }
    }
    this.sat = new Float64Array((this.cols + 1) * (this.rows + 1));
    for (let y = 0; y < this.rows; y++) {
      let row = 0;
      for (let x = 0; x < this.cols; x++) {
        row += grid[y * this.cols + x];
        this.sat[(y + 1) * (this.cols + 1) + x + 1] = this.sat[y * (this.cols + 1) + x + 1] + row;
      }
    }
  }
  /** Share of the rectangle already covered by prints (0–1). */
  covered(r: Rect) {
    const c0 = clampI(Math.floor((r.x0 - this.ox) / this.cell), 0, this.cols), c1 = clampI(Math.ceil((r.x1 - this.ox) / this.cell), 0, this.cols);
    const r0 = clampI(Math.floor((r.y0 - this.oy) / this.cell), 0, this.rows), r1 = clampI(Math.ceil((r.y1 - this.oy) / this.cell), 0, this.rows);
    const area = (c1 - c0) * (r1 - r0);
    if (area <= 0) return 0;
    const W = this.cols + 1;
    const sum = this.sat[r1 * W + c1] - this.sat[r0 * W + c1] - this.sat[r1 * W + c0] + this.sat[r0 * W + c0];
    return sum / area;
  }
}
const clampI = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Row centres of the existing wall (clusters of print centres by height). */
function rows(prints: Placed[]) {
  const out: { y: number; x0: number; x1: number; n: number }[] = [];
  for (const p of [...prints].sort((a, b) => a.y - b.y)) {
    const r = out[out.length - 1];
    if (r && Math.abs(p.y - r.y) < 95) {
      r.y = (r.y * r.n + p.y) / (r.n + 1); r.n++;
      r.x0 = Math.min(r.x0, p.x - p.w / 2); r.x1 = Math.max(r.x1, p.x + p.w / 2);
    } else out.push({ y: p.y, x0: p.x - p.w / 2, x1: p.x + p.w / 2, n: 1 });
  }
  return out;
}

export function suggest(
  id: string, box: { w: number; h: number }, wall: Placed[], opts: PlacerOptions = {}, forceLarge?: boolean,
): Suggestion {
  const maxOverlap = opts.maxOverlap ?? 0.12;
  const r = rng(id);
  const rotation = seededRotation(r);
  const largeCount = wall.filter((p) => p.large).length;
  const wantLarge = forceLarge ?? ((opts.allowLarge ?? true) && wall.length >= 9 && largeCount / (wall.length + 1) < 0.1);
  const layer = wall.reduce((m, p) => Math.max(m, p.layer), 0) + 1;

  if (!wall.length) return { x: 0, y: 0, rotation, large: !!forceLarge, layer };

  const attempt = (large: boolean): Suggestion | null => {
    const w = large ? box.w * 1.5 : box.w, h = large ? box.h * 1.5 : box.h;
    const cov = new Coverage(wall, Math.max(w, h) * 1.5);
    const cx = wall.reduce((s, p) => s + p.x, 0) / wall.length, cy = wall.reduce((s, p) => s + p.y, 0) / wall.length;
    const rws = rows(wall);
    const pitch = rws.length > 1 ? (rws[rws.length - 1].y - rws[0].y) / (rws.length - 1) : h + 10;
    const minY = Math.min(...wall.map((p) => p.y)), maxY = Math.max(...wall.map((p) => p.y));

    const st: { best: { s: number; x: number; y: number } | null } = { best: null };
    const consider = (x: number, y: number, kind: 'gap' | 'edge') => {
      const q = aabb(x, y, w, h, rotation);
      const area = (q.x1 - q.x0) * (q.y1 - q.y0);
      // Never cover more than maxOverlap of any print, nor let prints cover the new one by more than that.
      let coveredNew = 0;
      for (const p of wall) {
        const pq = aabb(p.x, p.y, p.w, p.h, p.rotation);
        const o = inter(q, pq);
        if (!o) continue;
        if (o / ((pq.x1 - pq.x0) * (pq.y1 - pq.y0)) > maxOverlap) return;
        if (large && p.large && Math.hypot(p.x - x, p.y - y) < 340) return;
        coveredNew += o;
      }
      if (coveredNew / area > maxOverlap * 1.5) return;
      if (large) for (const p of wall) if (p.large && Math.hypot(p.x - x, p.y - y) < 340 + Math.max(w, h) / 2) return;
      const empty = 1 - cov.covered(q);
      // Snugness: neighbours close on several sides read as part of the wall, not floating.
      const ring = { x0: q.x0 - 24, y0: q.y0 - 24, x1: q.x1 + 24, y1: q.y1 + 24 };
      const touch = cov.covered(ring) - cov.covered(q) * (area / ((ring.x1 - ring.x0) * (ring.y1 - ring.y0)));
      const dist = Math.hypot((x - cx) / 1.6, y - cy);
      let s = touch * 900 - dist * 0.6 + r() * 6;
      if (kind === 'gap') { if (empty < 0.82) return; s += 1200 + empty * 300; }
      if (!st.best || s > st.best.s) st.best = { s, x, y };
    };

    // 1. Gaps inside the wall.
    const q0 = { x0: Math.min(...wall.map((p) => p.x)), x1: Math.max(...wall.map((p) => p.x)) };
    for (let y = minY; y <= maxY; y += 12) for (let x = q0.x0; x <= q0.x1; x += 12) consider(x, y, 'gap');
    if (st.best) return { x: Math.round(st.best.x), y: Math.round(st.best.y), rotation, large, layer };

    // 2. Edges: continue each row left/right with a −14..+30 px gap, or start a row above/below.
    for (const row of rws) {
      const wave = (r() - 0.5) * 18;
      for (const gap of [-14, 0, 8, 16, 30]) {
        consider(row.x1 + gap + w / 2, row.y + wave, 'edge');
        consider(row.x0 - gap - w / 2, row.y + wave, 'edge');
      }
    }
    for (const y of [minY - pitch, maxY + pitch]) {
      for (let x = q0.x0; x <= q0.x1; x += 24) consider(x, y + (r() - 0.5) * 18, 'edge');
    }
    const b = st.best as { x: number; y: number } | null;
    return b ? { x: Math.round(b.x), y: Math.round(b.y), rotation, large, layer } : null;
  };

  return (wantLarge && attempt(true)) || attempt(false) || {
    // Fallback: below the wall.
    x: Math.round(wall.reduce((s, p) => s + p.x, 0) / wall.length),
    y: Math.round(Math.max(...wall.map((p) => p.y + p.h)) + box.h), rotation, large: false, layer,
  };
}
