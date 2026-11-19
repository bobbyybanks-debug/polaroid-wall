/**
 * Auto-fit: straighten a print that was scanned a little crooked and crop it to its own edges,
 * so no scanner bed, black backing or transparent corner shows around it.
 *
 * Works on a small copy: builds a mask of "print" pixels (from the alpha channel when the file
 * has one, otherwise by flooding the background in from the scan's corners), measures the tilt
 * from the print's straight edges, then finds the largest upright rectangle that is all print.
 * Only the web copies use the result; the original file is never touched.
 */
import sharp from 'sharp';
import type { CropRect } from '../db/schema';

const open = (file: string) => sharp(file, { limitInputPixels: false, failOn: 'error' });

export async function autoFitRect(file: string, W: number, H: number, hasAlpha: boolean): Promise<CropRect | null> {
  const s = Math.min(1, 1200 / Math.max(W, H));
  const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));

  let base = open(file).rotate();
  if (hasAlpha) base = base.flatten({ background: '#ffffff' });
  const gray = new Uint8Array(await base.resize(w, h, { fit: 'fill' }).greyscale().blur(1).raw().toBuffer());
  let mask: Uint8Array | null;
  if (hasAlpha) {
    const a = await open(file).rotate().resize(w, h, { fit: 'fill' }).extractChannel('alpha').raw().toBuffer();
    mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = a[i] >= 128 ? 1 : 0;
  } else {
    mask = printMaskFromCorners(gray, w, h);
  }

  const theta = mask ? tiltFromEdges(mask, w, h) : 0;
  const fit = uprightBox(mask, gray, w, h, theta);
  if (!fit) return null;
  const { box, cw, ch } = fit;

  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const kept = (bw * bh) / (w * h);
  // Nothing to fix: straight already and nothing (or almost nothing) to trim.
  if (theta === 0 && kept > 0.995) return null;
  // Guard against a wrong guess eating into the print.
  if (kept < (hasAlpha ? 0.3 : 0.75)) return null;

  // Centre of the box, back in the scan's own (upright, unrotated) coordinates.
  const t = (theta * Math.PI) / 180, c = Math.cos(t), sn = Math.sin(t);
  const ux = (box.x0 + box.x1 + 1) / 2 - cw / 2, uy = (box.y0 + box.y1 + 1) / 2 - ch / 2;
  const px = ux * c - uy * sn + w / 2, py = ux * sn + uy * c + h / 2;
  return { cx: px / s, cy: py / s, w: bw / s, h: bh / s, angle: Math.round(theta * 100) / 100 };
}

/** Background = what floods in from corners that clearly aren't the print's border. */
function printMaskFromCorners(g: Uint8Array, w: number, h: number): Uint8Array | null {
  const at = (x: number, y: number) => g[y * w + x];
  // The print's own border level: a thin band a few percent inside the scan's edge.
  const m = Math.min(w, h), i0 = Math.round(m * 0.035), i1 = Math.round(m * 0.06);
  const band: number[] = [];
  for (let y = i0; y < h - i0; y += 2) for (let x = i0; x < w - i0; x += 2) {
    const d = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (d < i1) band.push(at(x, y));
  }
  band.sort((a, b) => a - b);
  const border = band[band.length >> 1] ?? 0;

  const bg = new Uint8Array(w * h);
  let any = false;
  for (const [cx, cy] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
    let sum = 0, n = 0;
    for (let y = Math.max(0, cy - 3); y <= Math.min(h - 1, cy + 3); y++) for (let x = Math.max(0, cx - 3); x <= Math.min(w - 1, cx + 3); x++) { sum += at(x, y); n++; }
    const corner = sum / n, diff = Math.abs(corner - border);
    if (diff < 10 || bg[cy * w + cx]) continue; // this corner is print (or already flooded)
    const tol = Math.min(25, Math.max(6, diff * 0.5));
    const stack = [cy * w + cx];
    bg[cy * w + cx] = 1;
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !bg[j] && Math.abs(g[j] - corner) <= tol) { bg[j] = 1; stack.push(j); }
      }
    }
    any = true;
  }
  if (!any) return null;
  let bgCount = 0;
  for (let i = 0; i < bg.length; i++) bgCount += bg[i];
  if (bgCount < w * h * 0.0005) return null;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = bg[i] ? 0 : 1;
  return mask;
}

/**
 * Tilt in degrees (clockwise positive, as in CropRect) from the print's edges that border
 * background. Each side gets a straight-line fit; the median of the sides wins.
 */
function tiltFromEdges(mask: Uint8Array, w: number, h: number): number {
  const L: number[][] = [], R: number[][] = [], T: number[][] = [], B: number[][] = [];
  // Off-image counts as print, so the scan's own frame never looks like an edge.
  const m = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 1 : mask[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m(x, y)) continue;
    if (m(x - 1, y) && m(x + 1, y) && m(x, y - 1) && m(x, y + 1)) continue; // not on an edge
    // Edge direction from a 5×5 Sobel-like sum, so a shallow staircase still reads as one line.
    let gx = 0, gy = 0;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const v = m(x + i, y + j); gx += i * v; gy += j * v; }
    // (gx, gy) points into the print; background lies the other way.
    if (Math.abs(gx) > 2 * Math.abs(gy)) (gx > 0 ? L : R).push([x, y]);
    else if (Math.abs(gy) > 2 * Math.abs(gx)) (gy > 0 ? T : B).push([x, y]);
  }
  const angles: number[] = [];
  // Vertical sides: x = a·y + b, tilt = −atan(a). Horizontal sides: y = a·x + b, tilt = atan(a).
  for (const pts of [L, R]) { const a = robustSlope(pts.map(([x, y]) => [y, x]), h); if (a !== null) angles.push(-Math.atan(a) * 180 / Math.PI); }
  for (const pts of [T, B]) { const a = robustSlope(pts, w); if (a !== null) angles.push(Math.atan(a) * 180 / Math.PI); }
  if (!angles.length) return 0;
  angles.sort((a, b) => a - b);
  const mid = angles.length >> 1;
  const theta = angles.length % 2 ? angles[mid] : (angles[mid - 1] + angles[mid]) / 2;
  if (Math.abs(theta) < 0.08 || Math.abs(theta) > 15) return 0;
  return theta;
}

/** Least-squares slope of v over u, refit without outliers. Needs a decent run of edge points. */
function robustSlope(pts: number[][], dim: number): number | null {
  if (pts.length < 12) return null;
  let use = pts;
  let a = 0, b = 0;
  for (let pass = 0; pass < 3; pass++) {
    const n = use.length;
    if (n < 12) return null;
    let su = 0, sv = 0, suu = 0, suv = 0;
    for (const [u, v] of use) { su += u; sv += v; suu += u * u; suv += u * v; }
    const den = n * suu - su * su;
    if (Math.abs(den) < 1e-9) return null;
    a = (n * suv - su * sv) / den; b = (sv - a * su) / n;
    const res = use.map(([u, v]) => Math.abs(v - (a * u + b)));
    const sorted = res.slice().sort((x, y) => x - y);
    const cut = Math.max(1.5, sorted[Math.floor(sorted.length * 0.6)] * 2.5);
    use = use.filter((_, k) => res[k] <= cut);
  }
  const us = use.map(([u]) => u);
  if (Math.max(...us) - Math.min(...us) < dim * 0.1) return null; // too short to trust
  return a;
}

/**
 * Turn the scan upright (rotate by −theta), shrink to the part that is all print, then trim edge
 * lines that don't look like the print's own border (a bright bed sliver or a dark shadow line),
 * at most 3% per side. Returns the box in the rotated canvas and that canvas's size.
 */
function uprightBox(mask: Uint8Array | null, gray: Uint8Array, w: number, h: number, theta: number) {
  const t = (theta * Math.PI) / 180, c = Math.cos(t), sn = Math.sin(t);
  const cw = Math.ceil(Math.abs(w * c) + Math.abs(h * sn)), ch = Math.ceil(Math.abs(w * sn) + Math.abs(h * c));
  const rm = new Uint8Array(cw * ch), rg = new Uint8Array(cw * ch);
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (let Y = 0; Y < ch; Y++) for (let X = 0; X < cw; X++) {
    const ux = X + 0.5 - cw / 2, uy = Y + 0.5 - ch / 2;
    const sx = Math.floor(ux * c - uy * sn + w / 2), sy = Math.floor(ux * sn + uy * c + h / 2);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    const i = sy * w + sx;
    rg[Y * cw + X] = gray[i];
    if (mask && !mask[i]) continue;
    rm[Y * cw + X] = 1;
    if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
  }
  if (x1 < 0) return null;
  const row = (y: number) => { let n = 0; for (let x = x0; x <= x1; x++) n += rm[y * cw + x]; return n / (x1 - x0 + 1); };
  const col = (x: number) => { let n = 0; for (let y = y0; y <= y1; y++) n += rm[y * cw + x]; return n / (y1 - y0 + 1); };
  for (let guard = 0; guard < cw + ch && x1 > x0 && y1 > y0; guard++) {
    const f = [row(y0), row(y1), col(x0), col(x1)];
    const worst = f.indexOf(Math.min(...f));
    if (f[worst] >= 0.995) break;
    if (worst === 0) y0++; else if (worst === 1) y1--; else if (worst === 2) x0++; else x1--;
  }
  // A hair more when anything was cut, so no anti-aliased background pixel survives at full size.
  if (theta !== 0 || x0 > 0 || y0 > 0 || x1 < cw - 1 || y1 < ch - 1) {
    const k = Math.max(1, Math.round(Math.min(x1 - x0, y1 - y0) * 0.004));
    x0 += k; y0 += k; x1 -= k; y1 -= k;
  }
  if (x1 <= x0 || y1 <= y0) return null;

  // Edge lines that jump in brightness against the lines just inside them: a bright bed sliver or
  // a dark shadow line along the print's edge. Medians over the middle 80% of each line.
  const med = (vals: number[]) => { vals.sort((a, b) => a - b); return vals[vals.length >> 1] ?? 0; };
  const hLine = (y: number) => { const v: number[] = []; const m = Math.round((x1 - x0) * 0.1); for (let x = x0 + m; x <= x1 - m; x++) v.push(rg[y * cw + x]); return med(v); };
  const vLine = (x: number) => { const v: number[] = []; const m = Math.round((y1 - y0) * 0.1); for (let y = y0 + m; y <= y1 - m; y++) v.push(rg[y * cw + x]); return med(v); };
  const maxH = Math.max(1, Math.round((y1 - y0) * 0.015)), maxW = Math.max(1, Math.round((x1 - x0) * 0.015));
  // A line counts as "not the print" if it jumps against the lines just inside it (a thin sliver)
  // or differs clearly from the border ~1–1.6% further in (a wider shadow band along the edge).
  const IN = 3, JUMP = 8, BAND = 14;
  const ref = (line: (p: number) => number, from: number, dir: number, len: number) => {
    const v: number[] = [];
    for (let d = Math.round(len * 0.01); d <= Math.max(Math.round(len * 0.01), Math.round(len * 0.016)); d++) v.push(line(from + dir * d));
    return med(v);
  };
  const H0 = y1 - y0, W0 = x1 - x0;
  const rT = ref(hLine, y0, 1, H0), rB = ref(hLine, y1, -1, H0), rL = ref(vLine, x0, 1, W0), rR = ref(vLine, x1, -1, W0);
  const off = (v: number, near: number, band: number) => Math.abs(v - near) > JUMP || Math.abs(v - band) > BAND;
  // Each side, then one line more if anything was trimmed (the last shadow line is often partial).
  let n = 0;
  for (n = 0; n < maxH && off(hLine(y0), hLine(y0 + IN), rT); n++) y0++;
  if (n) y0++;
  for (n = 0; n < maxH && off(hLine(y1), hLine(y1 - IN), rB); n++) y1--;
  if (n) y1--;
  for (n = 0; n < maxW && off(vLine(x0), vLine(x0 + IN), rL); n++) x0++;
  if (n) x0++;
  for (n = 0; n < maxW && off(vLine(x1), vLine(x1 - IN), rR); n++) x1--;
  if (n) x1--;
  if (x1 <= x0 || y1 <= y0) return null;
  return { box: { x0, y0, x1, y1 }, cw, ch };
}
