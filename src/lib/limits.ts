/**
 * Upload rules, shared by the browser (checks before any bytes move) and the server
 * (checks again before signing, and again on the worker after a full decode).
 */
export const MB = 1024 * 1024;

export const LIMITS = {
  jpeg: 100 * MB,
  png: 100 * MB,
  tiff: 500 * MB,
  maxSide: 25_000,
  maxPixels: 250_000_000,
  batchFiles: 100,
  batchBytes: 3 * 1024 * MB,
  partSize: 64 * MB,
} as const;

export type Kind = 'jpeg' | 'png' | 'tiff';
export const MIME: Record<Kind, string> = { jpeg: 'image/jpeg', png: 'image/png', tiff: 'image/tiff' };

export type Sniffed =
  | { ok: true; kind: Kind }
  | { ok: false; reason: string };

/** Identify a file from its first bytes, never from its extension. */
export function sniff(head: Uint8Array, filename: string): Sniffed {
  const b = head;
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ok: true, kind: 'jpeg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ok: true, kind: 'png' };
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) {
    return { ok: true, kind: 'tiff' };
  }
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2b) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2b)) {
    return { ok: false, reason: `${filename} is a BigTIFF; save it as a standard TIFF (under 4 GB) instead.` };
  }
  const brand = String.fromCharCode(...b.slice(4, 12));
  if (brand.startsWith('ftyp')) {
    const sub = brand.slice(4);
    const what = /hei|hev|mif|msf/.test(sub) ? 'HEIC' : /avif/.test(sub) ? 'AVIF' : 'video/HEIF';
    const lie = ext === 'jpg' || ext === 'jpeg' ? ` with a .${ext} name` : '';
    return { ok: false, reason: `${filename} is a ${what} file${lie}; export it as JPEG or TIFF.` };
  }
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return { ok: false, reason: `${filename} is a WebP file; export it as JPEG or TIFF.` };
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return { ok: false, reason: `${filename} is a PDF; export the scan as JPEG or TIFF.` };
  return { ok: false, reason: `${filename} isn't a JPEG, PNG or TIFF file.` };
}

export const KIND_LABEL: Record<Kind, string> = { jpeg: 'JPEG', png: 'PNG', tiff: 'TIFF' };

export function fmtBytes(n: number) {
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(2)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(n >= 100 * MB ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Size check per type. Returns an error sentence naming the file, the rule and the fix. */
export function checkSize(filename: string, kind: Kind, bytes: number): string | null {
  const max = LIMITS[kind];
  if (bytes > max) {
    return `${filename} is ${fmtBytes(bytes)}; ${KIND_LABEL[kind]}s can be up to ${fmtBytes(max)}.` +
      (kind !== 'tiff' ? ' Save it as a TIFF (up to 500 MB) or export a smaller copy.' : ' Export it with LZW compression or at a lower resolution.');
  }
  if (bytes === 0) return `${filename} is empty.`;
  return null;
}

export function checkDimensions(filename: string, w: number, h: number): string | null {
  if (w > LIMITS.maxSide || h > LIMITS.maxSide) {
    return `${filename} is ${w.toLocaleString()} × ${h.toLocaleString()} px; each side can be up to 25,000 px.`;
  }
  if (w * h > LIMITS.maxPixels) {
    return `${filename} is ${Math.round((w * h) / 1e6)} megapixels; the limit is 250 MP.`;
  }
  return null;
}

/**
 * Read pixel dimensions from the file header (JPEG SOF, PNG IHDR, TIFF IFD0) without decoding.
 * `read(offset, length)` returns bytes from the file; used with File.slice in the browser.
 */
export async function headerDimensions(
  kind: Kind, read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<{ width: number; height: number } | null> {
  if (kind === 'png') {
    const b = await read(16, 8);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(0), height: dv.getUint32(4) };
  }
  if (kind === 'jpeg') {
    let off = 2;
    for (let guard = 0; guard < 2000; guard++) {
      const m = await read(off, 9);
      if (m.length < 4 || m[0] !== 0xff) return null;
      let marker = m[1];
      if (marker === 0xff) { off += 1; continue; }
      const len = (m[2] << 8) | m[3];
      // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (m[5] << 8) | m[6], width: (m[7] << 8) | m[8] };
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      off += 2 + len;
      marker = 0;
    }
    return null;
  }
  // TIFF
  const h = await read(0, 8);
  const le = h[0] === 0x49;
  const u16 = (b: Uint8Array, o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (b: Uint8Array, o: number) =>
    (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
  const ifd = u32(h, 4);
  const cnt = u16(await read(ifd, 2), 0);
  const entries = await read(ifd + 2, cnt * 12);
  let width = 0, height = 0;
  for (let i = 0; i < cnt; i++) {
    const e = i * 12, tag = u16(entries, e), type = u16(entries, e + 2);
    const val = type === 3 ? u16(entries, e + 8) : u32(entries, e + 8);
    if (tag === 256) width = val;
    if (tag === 257) height = val;
  }
  return width && height ? { width, height } : null;
}
