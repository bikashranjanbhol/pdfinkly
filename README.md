# PDFInkly

Edit PDFs in the browser: annotate, fill and sign, organize and merge pages, keep version history and share links.
Built with Next.js on Vercel. Editing runs entirely in the browser, so the server only stores files and metadata.

> **Status: Phase 1 (MVP).** Landing, pricing, sign-in or guest mode, upload, dashboard, the browser editor
> (annotate, sign, organize, merge), autosaved drafts, versions with restore, share links and download.
> Not yet: compress / OCR / Office conversion (needs the worker service) and billing.

## How it works

```
Browser ──(edit ops, autosave)──▶ Next.js API on Vercel ──▶ Postgres (files, versions, drafts, shares)
   │                                    │
   │ PDF.js renders, pdf-lib exports    └─ presigned URLs ─▶ S3 / Cloudflare R2 (private bucket)
   └──────── PUT / GET PDF bytes directly to storage ◀──────┘
```

- **Edits are operations**, not rewritten files. The editor keeps a list of ops (add annotation, rotate page, …) and
  autosaves it as a draft with optimistic locking: a stale tab gets `409 DRAFT_CONFLICT` and can choose which copy to keep.
- **Saving a version** exports the PDF in a Web Worker with pdf-lib, uploads it with a presigned URL, and calls
  `/complete`, which checks the bytes and creates the next version row. Older versions are never overwritten,
  so restore just points the file at an earlier version.
- **Guests** are real user rows identified by a signed cookie. When they sign in, their files move into the account.
- **Share links** store only a SHA-256 hash of the token and can be revoked.
- **Expiry and cleanup**: expired files are hidden from every read the moment they expire. A daily Vercel Cron
  (03:00 IST) then deletes them and their storage objects. Vercel Hobby allows one cron run a day; on Pro you can
  make it hourly in `apps/web/vercel.json`.

## Editing the PDF's own text

The **Edit text** tool works on text that's already in the PDF, not just text you add.

- **Font detection.** Hover over any text to see its real font, size and whether the font is embedded
  (e.g. "Calibri Bold · 11 pt · embedded (partial)"). Names and flags come from PDF.js; text and background
  colours are sampled from the rendered page.
- **Paragraph editing.** Click a paragraph to edit it in place. Lines are grouped into paragraphs by font,
  size, left edge and steady line spacing; a bold label next to regular text stays a separate block, so
  editing one keeps the other's style.
- **True removal on save.** `packages/shared/src/contentstream.ts` reads the page's content stream, tracks
  the text state (fonts, Tm/Td/TJ, Tc/Tw/Tz, CTM) to place every glyph, and rewrites the text operators so the
  original glyphs are gone while everything else keeps its exact position. The new text is then drawn on the
  original baselines. Nothing is left hidden underneath (unlike a white box).
- **Font matching.** The embedded font usually holds only the characters the document used, so new text is
  drawn with the closest face: Carlito for Calibri and Caladea for Cambria (identical letter widths, OFL),
  Helvetica for Arial and other sans fonts, Times for serif fonts, Courier for monospace.
- **Tested producers:** Chrome, LibreOffice/Word-style TrueType, pdfLaTeX (Type 1, kerned), wkhtmltopdf.

Limits: scanned pages need OCR first; rotated text and text inside Form XObjects isn't removed (it's covered
and the user is warned); Hindi and other complex scripts aren't supported for redrawing yet; a paragraph
re-wraps inside its own box but doesn't push the content below it down.

## Repository layout

```
apps/web            Next.js 16 app (App Router): pages, API routes, editor
  app/api/…         REST API (files, versions, drafts, shares, auth, cron)
  components/editor The editor: page rendering, tools, organize, sign, history, share, export worker
  lib/server/…      Auth, storage drivers, rate limiting, DB helpers (server only)
packages/shared     Operation model + PDF export (pure TS, unit tested), API schemas (zod)
packages/db         SQL migrations (source of truth) and the Drizzle schema
scripts/            End-to-end checks: API smoke test and browser UI test
```

## Run it locally

Requirements: Node 22.13+, pnpm 10, and Postgres 16 (Docker is easiest).

```bash
pnpm install
docker compose up -d                       # Postgres on localhost:5432

cp .env.example apps/web/.env.local
# then set AUTH_SECRET and CRON_SECRET (openssl rand -base64 32)

DATABASE_URL=postgres://postgres:postgres@localhost:5432/pdfinkly pnpm db:migrate
pnpm dev                                   # http://localhost:3000
```

With `STORAGE_DRIVER=local`, PDFs are written to `apps/web/.dev-storage` and served through signed dev URLs,
so no bucket is needed. To try the S3 driver locally, run `docker compose --profile s3 up -d` (MinIO with a
`pdfinkly` bucket) and set:

```
STORAGE_DRIVER=s3
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=pdfinkly
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_FORCE_PATH_STYLE=true
```

Sign-in works without OAuth: anyone can start as a guest. To enable Google or GitHub, set the client ID and secret
from `.env.example`; each provider appears on the sign-in page only when both are set.

## Tests

```bash
pnpm test          # unit tests: operation model, PDF export, page geometry vs PDF.js
pnpm typecheck

# With the app running (pnpm build && pnpm start):
BASE_URL=http://localhost:3000 DATABASE_URL=… CRON_SECRET=… node scripts/smoke-test.mjs   # 20 API checks
python3 scripts/ui_test.py                                                               # browser flow (Playwright)
python3 scripts/ui_textedit.py                                                           # Edit text flow (Playwright)
```

The UI test uploads a PDF, adds a highlight, text, a drawing and a signature, checks autosave, undo/redo and
reload, rotates and deletes pages, saves a version, and then opens the saved PDF to confirm the edits are in it.

## Deploy to Vercel

1. **Database**: in the Vercel project, open **Storage → Create Database → Neon** and connect it to the project.
   This sets `DATABASE_URL` (pooled, used by the app) and `DATABASE_URL_UNPOOLED` (direct). Tables are created and
   updated automatically: every **production** build runs the migrations (`prebuild`), using the direct connection,
   inside one transaction with a lock. Preview builds skip this, so a feature branch can't change the production schema.
   Any other Postgres works too: set `DATABASE_URL` yourself.
2. **Storage** (pick one):
   - **Vercel Blob** (simplest): in the project, **Storage → Create Database → Blob**, access **Private**,
     connect it to the project, and set `STORAGE_DRIVER=blob`. Nothing else to configure: the app signs a
     short-lived URL per upload/download and authenticates with Vercel's OIDC token.
   - **Cloudflare R2 / S3**: create a private bucket and an API token with object read/write, set
     `STORAGE_DRIVER=s3` and the `S3_*` variables, and add a CORS rule so the browser can upload and download directly:
   ```json
   [{ "AllowedOrigins": ["https://your-domain.com"], "AllowedMethods": ["GET", "PUT"],
      "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
   ```
3. **Vercel project**: import the repo and set **Root Directory** to `apps/web` (Vercel detects the pnpm workspace).
   Add the variables from `.env.example` with `APP_URL` set to your domain.
4. **OAuth** (optional): set the callback URLs to `<APP_URL>/api/auth/callback/google` and `…/github`.
5. Deploy. `apps/web/vercel.json` registers the daily cleanup cron; Vercel sends `CRON_SECRET` with each call.

`STORAGE_DRIVER=local` does not work on Vercel (the filesystem is read-only and not shared between instances).

## Limits and plans

Plan limits live in the `plans` table, so they can change without a deploy. The seeded `free` plan allows
25 MB files and keeps guest files for 24 hours. Pro and Business are listed as "Coming soon" until billing ships.

## Next phases

- **Phase 2**: worker service (compress, OCR, Office ↔ PDF) with a job queue, as described in the LLD.
- **Phase 3**: billing, true redaction, team workspaces.
