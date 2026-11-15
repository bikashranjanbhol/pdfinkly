// Copies runtime assets from node_modules into public/:
//   - PDF.js's worker → /pdf.worker.min.mjs
//   - Carlito/Caladea WOFF files → /fonts/* (embedded into PDFs when edited text is saved)
//   - Tesseract worker, LSTM engine builds and eng/hin models → /tesseract/*, /tessdata/* (in-browser OCR)
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
// OCR: self-hosted so documents and models never touch a third-party CDN.
const tessDir = path.dirname(require.resolve("tesseract.js/package.json"));
const requireTess = createRequire(path.join(tessDir, "package.json"));
const coreDir = path.dirname(requireTess.resolve("tesseract.js-core/package.json"));
await mkdir(path.join(pub, "tesseract"), { recursive: true });
await copyFile(path.join(tessDir, "dist", "worker.min.js"), path.join(pub, "tesseract", "worker.min.js"));
for (const core of ["tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"]) {
  await copyFile(path.join(coreDir, core), path.join(pub, "tesseract", core));
}
await mkdir(path.join(pub, "tessdata"), { recursive: true });
for (const lang of ["eng", "hin"]) {
  const dir = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
  await copyFile(path.join(dir, "4.0.0_best_int", `${lang}.traineddata.gz`), path.join(pub, "tessdata", `${lang}.traineddata.gz`));
}
// qpdf (password protection/unlock), served as plain files and loaded as a script.
const qpdfDir = path.join(path.dirname(require.resolve("@neslinesli93/qpdf-wasm/package.json")), "dist");
await mkdir(path.join(pub, "qpdf"), { recursive: true });
for (const f of ["qpdf.js", "qpdf.wasm"]) await copyFile(path.join(qpdfDir, f), path.join(pub, "qpdf", f));
console.log(`pdf.worker.min.mjs, ${n} font files, Tesseract engine, eng/hin models and qpdf copied to public/`);
