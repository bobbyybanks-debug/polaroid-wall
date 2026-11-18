/**
 * Suggests where a new print goes on the wall. Pure function: no database, no randomness
 * other than a generator seeded by the print id, so asking twice gives the same answer.
 *
 * Rules:
 * - Prints already on the wall are fixed obstacles; they never move.
 * - Every new print keeps clear space around it (SPACING), so the wall never gets crowded:
 *   a hole is used only if the print fits with that margin, otherwise the wall grows outward.
 * - Growth stays balanced: spots nearest the wall's centre win, measured on a landscape
 *   ellipse (ASPECT), so the wall widens about 1.6× faster than it gets taller.
 * - A new spot must sit next to the wall (not floating), and lines up with existing rows when it can.
 * - Overlap is off unless the wall setting allows it (then up to ~12% of a print's area).
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

/** Clear space kept around every new print, in wall px (a standard print is ~232 px wide). */
export const SPACING = 36;
/** Width ÷ height the wall grows towards. */
export const ASPECT = 1.6;

export type PlacerOptions = {
  /** Max share of an existing print a new one may cover. 0 (default) turns overlap off. */
  maxOverlap?: number;
  /** Clear space around a new print when overlap is off. */
  spacing?: number;
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
  const maxOverlap = opts.maxOverlap ?? 0;
  const spacing = maxOverlap > 0 ? 0 : (opts.spacing ?? SPACING);
  const r = rng(id);
  const rotation = seededRotation(r);
  const largeCount = wall.filter((p) => p.large).length;
  const wantLarge = forceLarge ?? ((opts.allowLarge ?? true) && wall.length >= 9 && largeCount / (wall.length + 1) < 0.1);
  const layer = wall.reduce((m, p) => Math.max(m, p.layer), 0) + 1;

  if (!wall.length) return { x: 0, y: 0, rotation, large: !!forceLarge, layer };

  const boxes = wall.map((p) => ({ p, q: aabb(p.x, p.y, p.w, p.h, p.rotation) }));
  const ext = boxes.reduce((b, { q }) => ({ x0: Math.min(b.x0, q.x0), y0: Math.min(b.y0, q.y0), x1: Math.max(b.x1, q.x1), y1: Math.max(b.y1, q.y1) }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  const cx = (ext.x0 + ext.x1) / 2, cy = (ext.y0 + ext.y1) / 2;
  const rws = rows(wall);
  const REACH = 44; // a spot counts as "next to the wall" if a print is within spacing + REACH

  const attempt = (large: boolean): Suggestion | null => {
    const w = large ? box.w * 1.5 : box.w, h = large ? box.h * 1.5 : box.h;
    const q0 = aabb(0, 0, w, h, rotation), hw = (q0.x1 - q0.x0) / 2, hh = (q0.y1 - q0.y0) / 2;
    const margin = spacing + REACH + 16;
    const cov = new Coverage(wall, Math.max(hw, hh) * 2 + margin * 2);
    const larges = boxes.filter(({ p }) => p.large);
    const step = 16;
    let best: { s: number; x: number; y: number } | null = null;

    for (let y = ext.y0 - hh - spacing - REACH; y <= ext.y1 + hh + spacing + REACH; y += step) {
      for (let x = ext.x0 - hw - spacing - REACH; x <= ext.x1 + hw + spacing + REACH; x += step) {
        const q = { x0: x - hw, y0: y - hh, x1: x + hw, y1: y + hh };
        const area = (q.x1 - q.x0) * (q.y1 - q.y0);
        if (spacing > 0) {
          // Nothing may sit inside the clear margin around the new print.
          if (cov.covered({ x0: q.x0 - spacing, y0: q.y0 - spacing, x1: q.x1 + spacing, y1: q.y1 + spacing }) > 0) continue;
        } else {
          if (cov.covered(q) > maxOverlap * 1.5) continue;
          let coveredNew = 0, bad = false;
          for (const { q: pq } of boxes) {
            const o = inter(q, pq);
            if (!o) continue;
            if (o / ((pq.x1 - pq.x0) * (pq.y1 - pq.y0)) > maxOverlap) { bad = true; break; }
            coveredNew += o;
          }
          if (bad || coveredNew / area > maxOverlap * 1.5) continue;
        }
        if (large && larges.some(({ p }) => Math.hypot(p.x - x, p.y - y) < 340 + Math.max(w, h) / 2)) continue;
        // Must be next to the wall, not floating off on its own.
        const pad = spacing + REACH;
        const ring = { x0: q.x0 - pad, y0: q.y0 - pad, x1: q.x1 + pad, y1: q.y1 + pad };
        const ringArea = (ring.x1 - ring.x0) * (ring.y1 - ring.y0);
        const near = cov.covered(ring) * ringArea - cov.covered(q) * area;
        if (near <= 0) continue;
        // Balanced growth: closest to the wall's centre on a landscape ellipse; snug neighbours help.
        let s = -Math.hypot((x - cx) / ASPECT, y - cy) + (near / (ringArea - area)) * 260 + r() * 8;
        for (const row of rws) if (Math.abs(y - row.y) < 14) { s += 40; break; }
        if (!best || s > best.s) best = { s, x, y };
      }
    }
    return best ? { x: Math.round(best.x), y: Math.round(best.y), rotation, large, layer } : null;
  };

  return (wantLarge && attempt(true)) || attempt(false) || {
    // Fallback: just below the wall.
    x: Math.round(cx), y: Math.round(ext.y1 + spacing + box.h / 2), rotation, large: false, layer,
  };
}

/**
 * "Make room": nudge prints apart just enough that none overlap and each keeps `spacing` clear
 * around it. Each overlapping pair is pushed apart along the axis where they overlap least, so
 * the arrangement (who sits next to whom, rows, angles) stays as it was. Returns new centres.
 */
export function relax(prints: Placed[], spacing = SPACING, iterations = 300): Map<string, { x: number; y: number }> {
  const ps = prints.map((p) => {
    const q = aabb(0, 0, p.w, p.h, p.rotation);
    return { id: p.id, x: p.x, y: p.y, hw: (q.x1 - q.x0) / 2 + spacing / 2, hh: (q.y1 - q.y0) / 2 + spacing / 2 };
  });
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const ox = a.hw + b.hw - Math.abs(dx), oy = a.hh + b.hh - Math.abs(dy);
        if (ox <= 0.5 || oy <= 0.5) continue;
        moved = true;
        // Widening is preferred a little (the wall is landscape), and vertical pushes keep rows.
        if (ox < oy * ASPECT) { const k = (ox / 2 + 0.5) * (dx >= 0 ? 1 : -1); a.x -= k; b.x += k; }
        else { const k = (oy / 2 + 0.5) * (dy >= 0 ? 1 : -1); a.y -= k; b.y += k; }
      }
    }
    if (!moved) break;
  }
  return new Map(ps.map((p) => [p.id, { x: Math.round(p.x), y: Math.round(p.y) }]));
}
