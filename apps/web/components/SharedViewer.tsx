"use client";

import { useEffect, useMemo, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { basePageRef, type PageEntry } from "@pdfinkly/shared";
import { openPdf } from "@/lib/client/pdf";
import { makeGeom } from "./editor/geometry";
import { DocsContext, PageCanvas, usePageInfo } from "./editor/PageView";

function SharedPage({ entry, width }: { entry: PageEntry; width: number }) {
  const info = usePageInfo(entry);
  const g = useMemo(() => {
    if (!info) return null;
    const sideways = info.rotate % 180 !== 0;
    const w = sideways ? info.view[3] - info.view[1] : info.view[2] - info.view[0];
    return makeGeom(info.view, info.rotate, width / w);
  }, [info, width]);
  const [visible, setVisible] = useState(false);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return (
    <div ref={setEl} className="bg-white shadow-[0_1px_4px_rgba(24,24,27,0.14)]" style={g ? { width: g.width, height: g.height } : { width, height: width * 1.29 }}>
      {info && g && <PageCanvas info={info} g={g} visible={visible} />}
    </div>
  );
}

export function SharedViewer({ url }: { url: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    let d: PDFDocumentProxy | null = null;
    openPdf(url).then((x) => { d = x; setDoc(x); }).catch(() => setError(true));
    const fit = () => setWidth(Math.min(860, window.innerWidth - 32));
    fit();
    window.addEventListener("resize", fit);
    return () => { window.removeEventListener("resize", fit); void d?.loadingTask.destroy(); };
  }, [url]);

  if (error) return <p role="alert" className="p-10 text-center">This PDF couldn&apos;t be displayed. Try downloading it instead.</p>;
  if (!doc) return <div className="flex flex-1 items-center justify-center p-10 text-zinc-600" aria-busy="true">Loading…</div>;

  const pages: PageEntry[] = Array.from({ length: doc.numPages }, (_, i) => ({ ref: basePageRef(i), source: { kind: "base", index: i }, rotation: 0 }));
  return (
    <DocsContext.Provider value={{ base: doc, ext: {} }}>
      <main aria-label="Document" className="flex flex-1 flex-col items-center gap-5 px-4 py-7">
        {pages.map((p) => <SharedPage key={p.ref} entry={p} width={width} />)}
      </main>
    </DocsContext.Provider>
  );
}
