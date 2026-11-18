# Bobby Banks — Archive (The Infinite Polaroid Wall)

A dense, pannable wall of real Polaroid scans, plus a private dashboard for uploading scans and
arranging the wall. Designed in Figma first (file `KOly2UcaIXxUujM5LcNzQ5`), built to match it.

- **Public site** (`/`, `/p/<number>`): the published wall. Drag, scroll / pinch to zoom, click a print
  for the full-screen viewer (whole Polaroid, no caption), ← → / swipe to browse, shareable link per print.
- **Dashboard** (`/admin`): Library (bulk upload, checks, status), Print detail (file facts, trim,
  download original), Wall editor (suggested spots, drag/rotate/size/layer, Publish, history + rollback).

## How it fits together

| Piece | Service | What it holds |
| --- | --- | --- |
| Website + dashboard | **Vercel** (Next.js 16) | The app. Reads the published layout from the database, so Publish needs no redeploy. |
| Database + login | **Supabase** (Postgres, Auth) | Prints, originals, web copies, trims, layout versions, uploads. Row Level Security is on with no public policies: only the app server reads it. |
| Files | **Cloudflare R2** | `polaroid-originals` (private, untouched scans) and `polaroid-web` (public web copies). |
| Code | **GitHub** | Every push to `main` deploys to Vercel. |
| Large TIFFs (optional) | **Trigger.dev** | 8 GB worker for very large files. Without it, processing runs inside the app. |

**Originals are never modified.** The browser uploads them straight to the private bucket in 64 MiB
parts (bytes never pass through Vercel). The worker only ever reads them. Trims, colour conversion,
resizing and metadata stripping happen on separate web copies:
400 / 800 / 1,600 / 3,200 px (never upscaled) in AVIF + WebP, plus one JPEG for link previews.

### Upload rules (checked in the browser, again on the server, again after a full decode)

- JPEG / PNG up to 100 MB · TIFF (including 16-bit) up to 500 MB
- Up to 25,000 px per side and 250 megapixels
- 100 files or 3 GB per batch; more files simply queue
- File type from the first bytes, not the extension (a HEIC renamed `.jpg` is caught)
- SHA-256 checksum: exact duplicates are caught before uploading (Skip / Keep both)
- Near-duplicates (same photo scanned twice): the **signed** version goes on the wall
- Scanner-bed captures are detected; several prints on one scan are split automatically
- Interrupted uploads resume: drop the same file again

### The wall

- Published prints never move unless you move them in the Wall editor.
- New prints land in **draft** at a suggested spot: gaps first, then the wall's edges, same row
  rhythm, ≤ 12 % overlap, about 10 % Large, the approved rotation mix. Seeded by print id (repeatable).
- **Publish** snapshots the draft as a new version. Every version is kept; **History → Roll back**.

## Environment variables

Set these in Vercel → Project → Settings → Environment Variables (Production and Preview).

| Name | Secret? | Value |
| --- | --- | --- |
| `DATABASE_URL` | **yes** | Supabase → Connect → *Transaction pooler* URI (port 6543), with your database password |
| `S3_ENDPOINT` | no | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (shown when you create the R2 token) |
| `S3_ACCESS_KEY_ID` | **yes** | R2 API token (Object Read & Write, both buckets) |
| `S3_SECRET_ACCESS_KEY` | **yes** | R2 API token secret |
| `S3_BUCKET_ORIGINALS` | no | `polaroid-originals` |
| `S3_BUCKET_WEB` | no | `polaroid-web` |
| `PUBLIC_IMAGE_BASE` | no | The `polaroid-web` public URL (r2.dev, later a custom domain), no trailing slash |
| `NEXT_PUBLIC_SUPABASE_URL` | no | `https://<project>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no | Supabase publishable key |
| `ADMIN_EMAILS` | no | Comma-separated emails allowed into `/admin` |
| `SITE_URL` | no | The site's address, e.g. `https://archive.example.com` |
| `TRIGGER_SECRET_KEY` | yes (optional) | Only if using Trigger.dev for large TIFFs |

## First-time setup (production)

1. **Database:** apply `drizzle/0000_init.sql` (already applied to the `polaroid-wall` Supabase project).
2. **Supabase Auth → URL Configuration:** Site URL = `SITE_URL`; add `SITE_URL/auth/callback` to Redirect URLs.
3. **Vercel:** add the secrets above, redeploy.
4. Open `/admin/login`, request a sign-in link, then in the Library click **Apply upload rules** once
   (sets the bucket CORS rules and the 7-day cleanup of unfinished uploads).
5. Drop the scans onto the Library. When they're processed, open the Wall editor and **Publish**.

### Custom domain

Vercel → Project → Settings → Domains → add `archive.<your domain>`. Vercel shows one CNAME record
for `archive`; add it where the domain's DNS lives (if the domain was bought through Format, Format
support adds it). Then set `SITE_URL` to the new address, add it to Supabase Redirect URLs, and click
**Apply upload rules** again so uploads are allowed from the new address.

## Local development

```bash
npm install
cp .env.example .env.local      # or use the local setup below
npm run dev
```

Fully local, no accounts: leave `DATABASE_URL` empty (an in-process Postgres is created in `.data/`),
run an S3 stand-in (`pip install "moto[server]" && moto_server -p 5055`), create the two buckets,
and set `AUTH_DEV_BYPASS=1` (ignored in production). Import a folder of scans with
`npx tsx --env-file=.env.local scripts/seed-from-folder.ts <folder> [--figma-layout scripts/figma-layout.json] [--publish]`.

Database changes: edit `src/lib/db/schema.ts`, run `npm run db:generate`, apply with `npm run db:migrate`
(uses `DATABASE_URL_DIRECT`, the session/direct connection string).

## Code map

```
src/app/page.tsx, p/[n]/page.tsx     public wall (+ per-print share pages)
src/components/wall/                 wall renderer (engine.ts) and styles (from the approved design)
src/app/admin/                       dashboard pages, server actions
src/components/admin/                Library + uploader, Print detail + trim editor, Wall editor
src/app/api/admin/                   upload (multipart), duplicate check, download, storage setup
src/lib/processing/                  scan analysis (bed detection, split), web copies, fingerprints
src/lib/placement/                   suggestion engine, layout versions, publish / rollback
src/lib/db/                          schema (Drizzle) and connection
src/trigger/                         optional Trigger.dev tasks for very large files
```
