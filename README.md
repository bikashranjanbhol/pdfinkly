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

- **Rotated pages.** Text in any of the four directions is detected; text that reads upright on screen is
  editable (on a page shown rotated 90°, that's text running up the unrotated page). When a page's text runs
  sideways the editor offers **Turn page upright**. Every page also has rotate left/right buttons under it.

Limits: scanned pages need OCR first (below); text at other angles and text inside Form XObjects isn't removed (it's covered
and the user is warned); Hindi and other complex scripts aren't supported for redrawing yet; a paragraph
re-wraps inside its own box but doesn't push the content below it down.

## OCR (scanned PDFs)

**Recognise text** (editor header, or the hint shown when a PDF looks scanned) turns scanned pages into
searchable, copyable and editable text. It runs entirely in the browser, so the file never leaves the device
for OCR and there is no server cost.

- **Engine.** tesseract.js 7 (WebAssembly, LSTM) with the `best_int` English and Hindi models. Everything is
  self-hosted: `scripts/copy-pdf-worker.mjs` copies the worker, the core builds and the models into
  `public/tesseract` and `public/tessdata` at install time, so no CDN is involved. Models download once
  (about 3 MB English and 1.4 MB Hindi, gzipped) plus a ~4 MB engine, and are cached by the browser.
- **Scope and languages.** By default only scanned pages are recognised (no text layer, or only text from an
  earlier OCR run, which is replaced rather than duplicated); "All pages" is available. English, Hindi, or both;
  the choice is remembered.
- **Sideways and upside-down scans.** A page that reads poorly as shown (mean word confidence under 65%) is tried
  turned 90°, 270° and 180° on a quick ~120 dpi render; if one reads clearly better, the page is recognised that
  way and, unless the user unticks the option, turned upright in the saved version. Upright text scores ~90%,
  sideways text ~20–40%, so the check is reliable and costs nothing on pages that are already upright.
- **Accuracy.** Each page is rendered at the scan's own resolution (200–400 dpi) and despeckled. Low-confidence
  stray punctuation is dropped, and words on a slightly skewed line are snapped onto one baseline.
- **Output.** Saving writes a new version with an invisible text layer (render mode 3) under the scan, drawn
  with a glyphless Type0 font (`PDFInkly-OCR`, Identity-H, identity ToUnicode). Any script, Devanagari
  included, is therefore searchable and copyable in every viewer, and each word is stretched to the width of
  the word in the image so selections line up.
- **Editing recognised text.** Edit text works on OCR text: the old words are removed from the text layer,
  the scan underneath is covered in the sampled paper colour, and the new text is drawn in Helvetica (the real
  font of a scan is unknown).

Limits: about 2–3 s per page on a laptop; handwriting, tables and very low-quality scans recognise poorly;
recognised Hindi is searchable and copyable but can't be edited yet.

## Page stamps

**Stamps** (Edit toolbar) adds document-wide stamps, stored as one `stamp.set` operation per kind and drawn
on export in the page's visual frame, so they read upright on rotated pages
(`packages/shared/src/stamps.ts`, layout shared with the preview in `stampLayout.ts`).

- **Watermark:** text and/or a logo; size, colour, opacity, angle; once in the middle or repeated across the
  page; on top of the content or behind it (drawn into its own content stream placed first); all pages or a
  range like `1-3, 6`. Text uses Helvetica, so only Latin characters for now (others are dropped, with a warning).
- **Page numbers, headers and footers:** three slots at the top and three at the bottom, with `{page}`,
  `{pages}`, `{date}` (DD/MM/YYYY) and `{file}`; a page-number shortcut (position + format); font, size,
  colour, margin; a first number and a page range (e.g. `2-` to skip a cover page, numbering from 1).
- **Bates numbering:** prefix + zero-padded running number + suffix (e.g. `ACME-000041`) in any corner or edge
  centre, on chosen pages; the dialog shows the range used and where the next document should start.

## Redaction

The **Redact** tool deletes what's under a marked area from the file; it doesn't just cover it.

- **Marking.** Drag over anything, or use **Find and redact** in the side panel. It finds Aadhaar numbers
  (Verhoeff-checked), PAN, Indian phone numbers, email and UPI IDs, IFSC codes, bank account numbers (only on lines
  that mention an account), and any words you type. Matches across separate text runs and OCR words are joined
  per line, so a number split into pieces is still found. Marks stay reviewable until you save or download.
- **What's removed** (`packages/shared/src/redact.ts`, applied last in the export so nothing drawn later survives):
  text glyphs whose centre is under a mark (including invisible OCR text), vector drawings that lie entirely
  inside a mark, inline images touching it, text and drawings inside form XObjects, overlapping PDF annotations
  (links, comments), and form fields (the form is flattened first). A black box is then drawn over each mark.
- **Images.** The export worker finds every image under a mark and packs it into a one-image PDF; the browser
  renders it with PDF.js (so every PDF image format decodes), fills the marked pixels with black, and re-encodes
  it (JPEG if it was JPEG, otherwise lossless). The cleaned image replaces the original object. An image that
  can't be decoded is removed entirely, with a warning, rather than left readable.
- **Verification.** After every save or download the new file is read back with PDF.js; if any text is still
  under a mark (or a marked phrase is still findable there), the user is told before sharing.

Limits: older versions in History still contain the original (the save message says so); scanned pages need
Recognise text before Find can see them; images shared between pages are cleaned everywhere they appear.

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
python3 scripts/ui_ocr.py                                                                # OCR flow, English + Hindi (Playwright)
python3 scripts/ui_stamps.py                                                             # Page stamps: dialog, preview, saved file
python3 scripts/ui_redact.py                                                             # Redaction: find, mark, save, check file + pixels
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

- **Phase 2**: worker service (compress, Office ↔ PDF, server-side OCR for very large files) with a job queue, as described in the LLD.
- **Phase 3**: billing, team workspaces.
