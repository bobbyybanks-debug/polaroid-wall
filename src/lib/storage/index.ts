import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, ListPartsCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { env } from '../env';

const g = globalThis as unknown as { __s3?: S3Client };

export function s3(): S3Client {
  if (!g.__s3) {
    const e = env();
    g.__s3 = new S3Client({
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      forcePathStyle: e.S3_FORCE_PATH_STYLE === '1',
      credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY },
      // R2 does not support the newer default request checksums on presigned part uploads.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return g.__s3;
}

export const buckets = () => ({ originals: env().S3_BUCKET_ORIGINALS, web: env().S3_BUCKET_WEB });

/** originals/2026/11/<uuid>/<safe filename> */
export function originalKey(uploadId: string, filename: string, now = new Date()) {
  const safe = filename.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').slice(-120) || 'scan';
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `originals/${now.getUTCFullYear()}/${m}/${uploadId}/${safe}`;
}

export function copyKey(printId: string, version: string, size: number, format: string) {
  return `p/${printId}/${version}/${size}.${format}`;
}

export const publicUrl = (key: string) => `${env().PUBLIC_IMAGE_BASE}/${key}`;

/* ---------- Multipart upload of originals (browser → private bucket) ---------- */

export async function createMultipart(key: string, contentType: string, meta: Record<string, string>) {
  const r = await s3().send(new CreateMultipartUploadCommand({
    Bucket: buckets().originals, Key: key, ContentType: contentType, Metadata: meta,
  }));
  if (!r.UploadId) throw new Error('Storage did not return an upload id');
  return r.UploadId;
}

export async function signParts(key: string, uploadId: string, partNumbers: number[], expiresIn = 3600) {
  return Promise.all(partNumbers.map(async (n) => ({
    partNumber: n,
    url: await getSignedUrl(s3(), new UploadPartCommand({
      Bucket: buckets().originals, Key: key, UploadId: uploadId, PartNumber: n,
    }), { expiresIn }),
  })));
}

export async function listParts(key: string, uploadId: string) {
  const parts: { PartNumber: number; ETag: string; Size: number }[] = [];
  let marker: string | undefined;
  for (;;) {
    const r = await s3().send(new ListPartsCommand({
      Bucket: buckets().originals, Key: key, UploadId: uploadId, PartNumberMarker: marker,
    }));
    for (const p of r.Parts ?? []) parts.push({ PartNumber: p.PartNumber!, ETag: p.ETag!, Size: p.Size ?? 0 });
    if (!r.IsTruncated) break;
    marker = r.NextPartNumberMarker;
  }
  return parts;
}

export async function completeMultipart(key: string, uploadId: string, parts: { PartNumber: number; ETag: string }[]) {
  await s3().send(new CompleteMultipartUploadCommand({
    Bucket: buckets().originals, Key: key, UploadId: uploadId,
    MultipartUpload: { Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber) },
  }));
}

export async function abortMultipart(key: string, uploadId: string) {
  await s3().send(new AbortMultipartUploadCommand({ Bucket: buckets().originals, Key: key, UploadId: uploadId }));
}

export async function headOriginal(key: string) {
  return s3().send(new HeadObjectCommand({ Bucket: buckets().originals, Key: key }));
}

/** Short-lived download link that keeps the original filename. */
export async function signedOriginalDownload(key: string, filename: string, expiresIn = 600) {
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: buckets().originals, Key: key,
    ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
  }), { expiresIn });
}

/** Stream an original to a local temp file (processing never holds whole files in memory). */
export async function downloadOriginal(key: string, toPath: string) {
  const r = await s3().send(new GetObjectCommand({ Bucket: buckets().originals, Key: key }));
  await pipeline(r.Body as Readable, createWriteStream(toPath));
}

export async function putOriginal(key: string, body: Buffer, contentType: string) {
  await s3().send(new PutObjectCommand({ Bucket: buckets().originals, Key: key, Body: body, ContentType: contentType }));
}

/* ---------- Web copies (public bucket) ---------- */

const MIME: Record<string, string> = { avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png' };

export async function putCopy(key: string, body: Buffer, format: string) {
  await s3().send(new PutObjectCommand({
    Bucket: buckets().web, Key: key, Body: body, ContentType: MIME[format] ?? 'application/octet-stream',
    // Keys are content-hashed, so copies can be cached for a year.
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

export async function deleteCopies(keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    if (chunk.length) {
      await s3().send(new DeleteObjectsCommand({
        Bucket: buckets().web, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }));
    }
  }
}
