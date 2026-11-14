// Copies PDF.js's worker next to the app so the browser can load it from /pdf.worker.min.mjs
import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
const here = path.dirname(fileURLToPath(import.meta.url));
await copyFile(path.join(pkgDir, "build", "pdf.worker.min.mjs"), path.join(here, "..", "public", "pdf.worker.min.mjs"));
console.log("pdf.worker.min.mjs copied to public/");
