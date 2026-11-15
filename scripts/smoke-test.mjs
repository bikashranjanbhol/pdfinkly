// End-to-end API smoke test against a running app (local storage driver).
// Usage: BASE_URL=http://localhost:3000 DATABASE_URL=... node scripts/smoke-test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

const require = createRequire(new URL("../packages/shared/package.json", import.meta.url));
const { PDFDocument, StandardFonts } = require("pdf-lib");
const requireDb = createRequire(new URL("../packages/db/package.json", import.meta.url));
const postgres = (await import(requireDb.resolve("postgres"))).default;

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
let cookie = "";

async function call(path, { method = "GET", json, raw, headers = {} } = {}) {
  const res = await fetch(path.startsWith("http") ? path : BASE + path, {
    method,
    headers: { ...(json ? { "Content-Type": "application/json" } : {}), ...(cookie && !path.startsWith("http") ? { Cookie: cookie } : {}), ...headers },
    body: json ? JSON.stringify(json) : raw,
    redirect: "manual",
  });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const [pair] = c.split(";");
    const [name] = pair.split("=");
    cookie = [...cookie.split("; ").filter((x) => x && !x.startsWith(name + "=")), pair].join("; ");
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

async function pdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 50, y: 740, size: 18, font });
  return doc.save();
}

async function upload(bytes, name = "test.pdf") {
  const c = await call("/api/files", { method: "POST", json: { name, sizeBytes: bytes.length } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const put = await fetch(c.body.upload.url, { method: "PUT", headers: c.body.upload.headers, body: bytes });
  assert.equal(put.status, 200, "PUT to signed URL");
  const done = await call(`/api/files/${c.body.fileId}/versions/${c.body.versionId}/complete`, { method: "POST", json: { pageCount: 2, source: "upload" } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return c.body;
}

const ok = (m) => console.log("  ✓", m);

console.log("PDFInkly smoke test →", BASE);

// 1. Unauthenticated
assert.equal((await call("/api/files/" + randomUUID())).status, 401);
ok("unknown visitor gets 401 on a file");

// 2. Guest upload flow
const bytes = await pdf(2);
const { fileId, versionId } = await upload(bytes, "Service agreement.pdf");
assert.match(cookie, /pdfinkly_guest=/);
ok("guest created on first upload, file uploaded and completed");

const again = await call(`/api/files/${fileId}/versions/${versionId}/complete`, { method: "POST", json: { pageCount: 2 } });
assert.equal(again.status, 200);
assert.equal(again.body.version.versionNo, 1);
ok("complete is idempotent");

const list = await call("/api/files");
assert.equal(list.body.items.length, 1);
assert.equal(list.body.items[0].name, "Service agreement.pdf");
ok("file listed in dashboard");

const info = await call(`/api/files/${fileId}`);
assert.equal(info.status, 200);
const dl = await fetch(info.body.viewUrl);
assert.equal(dl.status, 200);
assert.equal((await dl.arrayBuffer()).byteLength, bytes.length);
ok("signed view URL serves the exact bytes");

const tampered = info.body.viewUrl.replace(/sig=[^&]+/, "sig=bad");
assert.equal((await fetch(tampered)).status, 403);
ok("tampered signed URL is rejected");

// 3. Validation & limits
assert.equal((await call("/api/files", { method: "POST", json: { name: "x.pdf", sizeBytes: 999 * 1024 * 1024 } })).status, 413);
ok("file over plan limit gets 413 FILE_TOO_LARGE");
assert.equal((await call("/api/files", { method: "POST", json: { nope: 1 } })).status, 400);
ok("bad body gets 400 VALIDATION_FAILED");

const notPdf = await call("/api/files", { method: "POST", json: { name: "fake.pdf", sizeBytes: 11 } });
await fetch(notPdf.body.upload.url, { method: "PUT", headers: notPdf.body.upload.headers, body: "hello world" });
const rej = await call(`/api/files/${notPdf.body.fileId}/versions/${notPdf.body.versionId}/complete`, { method: "POST", json: { pageCount: 1 } });
assert.equal(rej.status, 422);
assert.equal(rej.body.error.code, "INVALID_PDF");
ok("non-PDF upload rejected with INVALID_PDF");

// 4. Drafts with optimistic locking
const op = { op: "annot.add", id: "a1", page: "p1", annot: { kind: "highlight", rect: { x: 1, y: 2, w: 30, h: 10 }, color: "#FACC15" } };
let d = await call(`/api/files/${fileId}/draft`, { method: "PUT", json: { baseVersionId: versionId, operations: [op], revision: 0 } });
assert.equal(d.status, 201);
assert.equal(d.body.revision, 1);
d = await call(`/api/files/${fileId}/draft`, { method: "PUT", json: { baseVersionId: versionId, operations: [op, op], revision: 1 } });
assert.equal(d.body.revision, 2);
const stale = await call(`/api/files/${fileId}/draft`, { method: "PUT", json: { baseVersionId: versionId, operations: [], revision: 1 } });
assert.equal(stale.status, 409);
assert.equal(stale.body.error.details.server.revision, 2);
ok("draft autosave bumps revision; stale tab gets 409 with server copy");
const badOp = await call(`/api/files/${fileId}/draft`, { method: "PUT", json: { baseVersionId: versionId, operations: [{ op: "evil" }], revision: 2 } });
assert.equal(badOp.status, 400);
ok("invalid operations rejected");

// 5. Save a new version (editor save) clears the draft
const v2 = await pdf(3);
const nv = await call(`/api/files/${fileId}/versions`, { method: "POST", json: { sizeBytes: v2.length, baseVersionId: versionId } });
assert.equal(nv.status, 201);
await fetch(nv.body.upload.url, { method: "PUT", headers: nv.body.upload.headers, body: v2 });
const c2 = await call(`/api/files/${fileId}/versions/${nv.body.versionId}/complete`, { method: "POST", json: { pageCount: 3, source: "edit" } });
assert.equal(c2.body.version.versionNo, 2);
assert.equal((await call(`/api/files/${fileId}/draft`)).status, 204);
ok("saving a version numbers it v2 and clears the draft");

// 6. Restore
const r = await call(`/api/files/${fileId}/restore`, { method: "POST", json: { versionId } });
assert.equal(r.body.file.currentVersionId, versionId);
assert.equal((await call(`/api/files/${fileId}`)).body.versions.length, 2);
ok("restore makes v1 current again, history keeps both");

// 7. Ownership: another guest can't see the file
const mine = cookie;
cookie = "";
await upload(await pdf(1), "other.pdf");
assert.equal((await call(`/api/files/${fileId}`)).status, 404);
assert.equal((await call(`/api/files/${fileId}/draft`, { method: "PUT", json: { baseVersionId: versionId, operations: [], revision: 0 } })).status, 404);
ok("another visitor gets 404 for someone else's file");
cookie = mine;

// 8. Shares need a signed-in user: create one with a DB session
const sql = postgres(process.env.DATABASE_URL);
const [u] = await sql`INSERT INTO users (email, name) VALUES (${`smoke+${Date.now()}@example.com`}, 'Smoke Test') RETURNING id`;
const token = randomBytes(24).toString("hex");
await sql`INSERT INTO sessions (session_token, user_id, expires_at) VALUES (${token}, ${u.id}, now() + interval '1 day')`;
const guestCookie = cookie;
cookie = `authjs.session-token=${token}`;
assert.equal((await call("/api/me")).body.user.isGuest, false);
ok("database session recognised");
const shared = await upload(await pdf(2), "Shared.pdf");
const s = await call(`/api/files/${shared.fileId}/shares`, { method: "POST", json: { expiresInDays: 7 } });
assert.equal(s.status, 201);
const page = await fetch(s.body.url);
assert.equal(page.status, 200);
assert.match(await page.text(), /Shared\.pdf/);
ok("share link created and public page shows the file");
const [stored] = await sql`SELECT token_hash FROM share_links WHERE id = ${s.body.shareId}`;
assert.ok(!s.body.url.includes(stored.token_hash));
ok("only the token hash is stored");
assert.equal((await call(`/api/shares/${s.body.shareId}`, { method: "DELETE" })).status, 204);
assert.match(await (await fetch(s.body.url)).text(), /no longer works/);
ok("revoked link stops working");

// guests can't share
cookie = guestCookie;
assert.equal((await call(`/api/files/${fileId}/shares`, { method: "POST", json: {} })).status, 401);
ok("guests are asked to sign in before sharing");

// 8b. Expired files disappear immediately, before the (daily) cleanup cron runs
{
  const exp = await upload(await pdf(1), "Expiring.pdf");
  await sql`UPDATE files SET expires_at = now() - interval '1 minute' WHERE id = ${exp.fileId}`;
  assert.equal((await call(`/api/files/${exp.fileId}`)).status, 404);
  const list = await call("/api/files");
  assert.ok(!list.body.items.some((f) => f.id === exp.fileId), "expired file still listed");
  ok("expired file is hidden from reads and the list before cleanup runs");
}

// 9. Soft delete + cron cleanup
assert.equal((await call(`/api/files/${fileId}`, { method: "DELETE" })).status, 204);
assert.equal((await call(`/api/files/${fileId}`)).status, 404);
await sql`UPDATE files SET deleted_at = now() - interval '2 days' WHERE id = ${fileId}`;
assert.equal((await fetch(BASE + "/api/cron/cleanup")).status, 401);
const cron = await fetch(BASE + "/api/cron/cleanup", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
const cj = await cron.json();
assert.ok(cj.removedFiles >= 1 && cj.removedObjects >= 2, JSON.stringify(cj));
ok(`cleanup cron removed ${cj.removedFiles} file(s), ${cj.removedObjects} object(s); unauthorised call refused`);

await sql.end();
console.log("All smoke tests passed.");
