// Copies runtime assets from node_modules into public/:
//   - PDF.js's worker → /pdf.worker.min.mjs
//   - Carlito/Caladea WOFF files → /fonts/* (embedded into PDFs when edited text is saved)
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");

const pdfjsDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
await copyFile(path.join(pdfjsDir, "build", "pdf.worker.min.mjs"), path.join(pub, "pdf.worker.min.mjs"));

await mkdir(path.join(pub, "fonts"), { recursive: true });
let n = 0;
for (const face of ["carlito", "caladea"]) {
  const dir = path.join(path.dirname(require.resolve(`@fontsource/${face}/package.json`)), "files");
  for (const weight of [400, 700]) {
    for (const style of ["normal", "italic"]) {
      const file = `${face}-latin-${weight}-${style}.woff`;
      await copyFile(path.join(dir, file), path.join(pub, "fonts", file));
      n++;
    }
  }
}
console.log(`pdf.worker.min.mjs and ${n} font files copied to public/`);
