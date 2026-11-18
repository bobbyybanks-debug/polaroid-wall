/**
 * Scanner-bed detection: finds the Polaroid(s) on a white flatbed capture.
 * Works on a small greyscale copy (about 1,000 px) with plain typed-array image ops,
 * so it runs anywhere sharp runs. Output boxes are in the full image's pixel space.
 */
import type { CropRect } from '../db/schema';

export type Box = CropRect & { cover: number; solid: number };
export type Detection = { bed: boolean; boxes: Box[]; bgMean: number };

/** Square max/min filter (radius r) done as two 1-D passes. */
function morph(src: Uint8Array, w: number, h: number, r: number, max: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const pick = max ? Math.max : Math.min;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = src[row + x];
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let i = a; i <= b; i++) v = pick(v, src[row + i]);
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let i = a; i <= b; i++) v = pick(v, tmp[i * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

function cross(o: number[], a: number[], b: number[]) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Convex hull (monotone chain). */
function hull(pts: number[][]): number[][] {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lo: number[][] = [], up: number[][] = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

/** Minimum-area enclosing rectangle of a convex polygon (rotating calipers over edge angles). */
function minAreaRect(poly: number[][]): CropRect {
  let best = { area: Infinity, cx: 0, cy: 0, w: 0, h: 0, angle: 0 };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const th = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(th), s = Math.sin(th);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of poly) {
      const u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c;
      if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) {
      const mu = (minU + maxU) / 2, mv = (minV + maxV) / 2;
      best = { area, cx: mu * c - mv * s, cy: mu * s + mv * c, w: maxU - minU, h: maxV - minV, angle: (th * 180) / Math.PI };
    }
  }
  // Normalise to an angle in (-45, 45], swapping sides as needed.
  let { w, h, angle } = best;
  while (angle > 45) { angle -= 90; [w, h] = [h, w]; }
  while (angle <= -45) { angle += 90; [w, h] = [h, w]; }
  return { cx: best.cx, cy: best.cy, w, h, angle };
}

/**
 * @param gray  blurred greyscale pixels of the downscaled image
 * @param scale downscaled size / full size
 */
export function detectPrints(gray: Uint8Array, w: number, h: number, scale: number, useDark = false): Detection {
  // Brightness of the outer ring: on a bed capture this is the bare scanner bed.
  const ring: number[] = [];
  const rw = Math.max(3, Math.round(Math.min(w, h) * 0.02));
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (x < rw || y < rw || x >= w - rw || y >= h - rw) ring.push(gray[y * w + x]);
  }
  ring.sort((a, b) => a - b);
  const ringMedian = ring[ring.length >> 1] ?? 0;
  // Local bed brightness: 90th percentile per block, spread to neighbouring blocks (so a print
  // never sets its own level), then bilinear-interpolated. The bed is often a little uneven.
  const B = 40, bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const p90 = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const hist = new Uint32Array(256); let n = 0;
    for (let y = by * B; y < Math.min(h, by * B + B); y++) for (let x = bx * B; x < Math.min(w, bx * B + B); x++) { hist[gray[y * w + x]]++; n++; }
    let acc = 0, v = 255;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.1) { v = i; break; } }
    p90[by * bw + bx] = v;
  }
  const level = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let v = 0;
    for (let j = Math.max(0, by - 2); j <= Math.min(bh - 1, by + 2); j++) for (let i = Math.max(0, bx - 2); i <= Math.min(bw - 1, bx + 2); i++) v = Math.max(v, p90[j * bw + i]);
    level[by * bw + bx] = v;
  }
  const levelAt = (x: number, y: number) => {
    const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5)), fy = Math.min(bh - 1, Math.max(0, y / B - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const a = level[y0 * bw + x0] * (1 - tx) + level[y0 * bw + x1] * tx;
    const b = level[y1 * bw + x0] * (1 - tx) + level[y1 * bw + x1] * tx;
    return a * (1 - ty) + b * ty;
  };
  // Edges (morphological gradient > 5), plus anything a little darker than the bright bed
  // around it: a Polaroid's white border is a few levels darker than the scanner bed.
  const grad = new Uint8Array(w * h);
  const dil = morph(gray, w, h, 1, true), ero = morph(gray, w, h, 1, false);
  const brightBed = useDark && ringMedian >= 238;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const dark = brightBed && gray[i] < levelAt(x, y) - 6;
    grad[i] = (dil[i] - ero[i] > 5 || dark) ? 255 : 0;
  }
  // Ignore scanner-edge artefacts.
  const m = 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < m || y < m || x >= w - m || y >= h - m) grad[y * w + x] = 0;
  }
  // Close gaps, fill holes, then open to drop specks.
  let mask = morph(morph(grad, w, h, 8, true), w, h, 8, false);
  const seen = new Uint8Array(w * h);
  const stack: number[] = [0];
  seen[0] = 1;
  while (stack.length) {
    const i = stack.pop()!; const x = i % w, y = (i - x) / w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && !seen[j] && !mask[j]) { seen[j] = 1; stack.push(j); }
  }
  for (let i = 0; i < mask.length; i++) if (!seen[i]) mask[i] = 255;
  mask = morph(morph(mask, w, h, 5, false), w, h, 5, true);

  // Background (bed) brightness: mean of pixels outside the mask.
  let bgSum = 0, bgN = 0;
  for (let i = 0; i < mask.length; i++) if (!mask[i]) { bgSum += gray[i]; bgN++; }
  const bgMean = bgN ? bgSum / bgN : 0;

  // Connected components → boxes.
  const label = new Int32Array(w * h);
  const boxes: Box[] = [];
  let next = 1;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    const q = [s]; label[s] = next; let area = 0; const edge: number[][] = [];
    while (q.length) {
      const i = q.pop()!; area++;
      const x = i % w, y = (i - x) / w;
      let border = false;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || !mask[j]) { border = true; continue; }
        if (!label[j]) { label[j] = next; q.push(j); }
      }
      if (border) edge.push([x + 0.5, y + 0.5]);
    }
    next++;
    if (area < 0.02 * w * h || edge.length < 3) continue;
    const r = minAreaRect(hull(edge));
    boxes.push({
      cx: r.cx / scale, cy: r.cy / scale, w: r.w / scale, h: r.h / scale, angle: Math.round(r.angle * 100) / 100,
      cover: area / (w * h), solid: area / Math.max(1, r.w * r.h),
    });
  }
  boxes.sort((a, b) => b.cover - a.cover);
  const total = boxes.reduce((t, b) => t + b.cover, 0);
  // A bed capture shows a lot of bright, flat scanner bed around the print(s). Scans already
  // cropped to the print only show its own white border, which is a much smaller share.
  const bed = boxes.length > 0 && total < 0.5 && ringMedian >= 236;
  return { bed, boxes, bgMean };
}

export type CropPlan = {
  bed: boolean;
  /** Print boxes in full-image pixels (one per print), in reading order. */
  boxes: CropRect[];
  issue: string | null;
  /** How many merged boxes were split by guesswork. */
  splits?: number;
};

const isFilm = (w: number, h: number) => filmFromRatio(w, h) !== 'unknown';
/** Whole Wide or Square print. Used when splitting merged boxes (a Mini is ambiguous there). */
const isWholePrint = (w: number, h: number) => ['instax_wide', 'instax_square'].includes(filmFromRatio(w, h));

/** Split a box along its long side into n equal prints. */
function splitBox(b: CropRect, n: number): CropRect[] {
  const alongW = b.w >= b.h;
  const rad = (b.angle * Math.PI) / 180, ux = Math.cos(rad), uy = Math.sin(rad);
  const vx = -Math.sin(rad), vy = Math.cos(rad);
  const len = alongW ? b.w : b.h;
  return Array.from({ length: n }, (_, i) => {
    const off = -len / 2 + (len / n) * (i + 0.5);
    return {
      cx: b.cx + (alongW ? ux : vx) * off, cy: b.cy + (alongW ? uy : vy) * off,
      w: alongW ? b.w / n : b.w, h: alongW ? b.h : b.h / n, angle: b.angle,
    };
  });
}

/** Turn raw detection into one crop box per print, plus anything worth a look. */
export function planCrops(d: Detection, W: number, H: number): CropPlan {
  if (!d.bed) {
    const issue = isFilm(W, H) ? null : `Doesn't look like a whole print (${W} × ${H} px). Check the scan is complete.`;
    return { bed: false, boxes: [{ cx: W / 2, cy: H / 2, w: W, h: H, angle: 0 }], issue };
  }
  const out: CropRect[] = [];
  let odd = false, splits = 0;
  for (const b of d.boxes) {
    if (b.cover < 0.03) continue;
    if (isWholePrint(b.w, b.h) && b.solid > 0.9) { out.push({ cx: b.cx, cy: b.cy, w: b.w, h: b.h, angle: b.angle }); continue; }
    // Prints touching on the bed merge into one box: try splitting into 2–4.
    // When several splits fit, take the one closest to an exact film ratio (Wide wins near-ties).
    let split: CropRect[] | null = null, bestErr = Infinity;
    for (const n of [2, 3, 4]) {
      const parts = splitBox(b, n);
      if (!parts.every((p) => isWholePrint(p.w, p.h))) continue;
      const r = Math.max(parts[0].w, parts[0].h) / Math.min(parts[0].w, parts[0].h);
      const err = Math.min(Math.abs(r - 108 / 86) - 0.003, Math.abs(r - 86 / 72));
      if (err < bestErr) { bestErr = err; split = parts; }
    }
    if (split) { out.push(...split); splits++; }
    else { out.push({ cx: b.cx, cy: b.cy, w: b.w, h: b.h, angle: b.angle }); odd = true; }
  }
  if (!out.length) return { bed: false, boxes: [{ cx: W / 2, cy: H / 2, w: W, h: H, angle: 0 }], issue: 'No print found on this scan.' };
  // Reading order: rows top to bottom, then left to right.
  const rowH = Math.min(...out.map((b) => Math.min(b.w, b.h))) * 0.6;
  out.sort((a, b) => Math.round(a.cy / rowH) - Math.round(b.cy / rowH) || a.cx - b.cx);
  const issue = odd ? 'The trim around this print looks off. Check it before publishing.'
    : out.length > 1 ? `${out.length} prints found on this scan.` : null;
  return { bed: true, boxes: out, issue, splits };
}

/**
 * Runs detection two ways (edges only; edges plus "slightly darker than the bed") and keeps
 * the plan that explains the scan best: most whole prints, fewest guessed splits.
 */
export function detectAndPlan(gray: Uint8Array, w: number, h: number, scale: number, W: number, H: number): CropPlan & { detection: Detection } {
  const score = (p: CropPlan) => (p.bed && !p.issue?.startsWith('The trim') ? p.boxes.length - 1.5 * (p.splits ?? 0) : 0);
  const a = detectPrints(gray, w, h, scale, false), pa = planCrops(a, W, H);
  const b = detectPrints(gray, w, h, scale, true), pb = planCrops(b, W, H);
  return score(pb) > score(pa) ? { ...pb, detection: b } : { ...pa, detection: a };
}

/** Instax film by long/short ratio of the whole print. */
export function filmFromRatio(w: number, h: number): 'instax_wide' | 'instax_square' | 'instax_mini' | 'unknown' {
  const r = Math.max(w, h) / Math.min(w, h);
  if (r >= 1.225 && r < 1.42) return 'instax_wide';
  if (r >= 1.12 && r < 1.225) return 'instax_square';
  if (r >= 1.5 && r < 1.7) return 'instax_mini';
  return 'unknown';
}

/** Long edge in mm for each film (sizes the print on the wall: 232 px per 108 mm). */
export const FILM_LONG_MM = { instax_wide: 108, instax_square: 86, instax_mini: 86, unknown: 108 } as const;
export const PX_PER_MM = 232 / 108;
