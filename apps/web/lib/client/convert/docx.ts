"use client";

import type { PageLayout, Para } from "./layout";

const twip = (pt: number) => Math.max(0, Math.round(pt * 20));
const hex = (c: string) => c.replace("#", "").toUpperCase();

/**
 * Word document from page layouts: one section per page (same size), paragraphs
 * in reading order with their fonts, sizes, colours, indentation and spacing,
 * pictures inline where they sit. It reflows like a normal Word document, so it
 * can be edited, rather than pinning text boxes to positions.
 */
export async function layoutsToDocx(pages: PageLayout[], title: string): Promise<Uint8Array> {
  const { Document, Packer, Paragraph, TextRun, ImageRun, Tab, TabStopType, LineRuleType } = await import("docx");

  const sections = pages.map((page) => {
    type Item = { kind: "para"; p: Para } | { kind: "pic"; pic: PageLayout["pictures"][number] };
    const items: Item[] = [
      ...page.paras.map((p) => ({ kind: "para" as const, p })),
      ...page.pictures.map((pic) => ({ kind: "pic" as const, pic })),
    ].sort((a, b) => (a.kind === "para" ? a.p.top : a.pic.top) - (b.kind === "para" ? b.p.top : b.pic.top));

    const left = Math.max(18, Math.min(72, ...items.map((i) => (i.kind === "para" ? i.p.x : i.pic.x))));
    const marginTop = Math.max(18, Math.min(72, ...items.map((i) => (i.kind === "para" ? i.p.top : i.pic.top))));
    const right = 36;
    let cursor = marginTop;

    const children = items.map((item) => {
      const top = item.kind === "para" ? item.p.top : item.pic.top;
      const before = Math.min(200, Math.max(0, top - cursor));
      if (item.kind === "pic") {
        const { pic } = item;
        cursor = pic.top + pic.h;
        // docx sizes pictures in pixels at 96 dpi.
        return new Paragraph({
          spacing: { before: twip(before), after: 0 },
          indent: { left: twip(Math.max(0, pic.x - left)) },
          children: [new ImageRun({ type: pic.type, data: pic.data, transformation: { width: Math.round((pic.w * 96) / 72), height: Math.round((pic.h * 96) / 72) } })],
        });
      }
      const { p } = item;
      cursor = p.bottom;
      return new Paragraph({
        spacing: {
          before: twip(before), after: 0,
          ...(p.lines > 1 && p.lineGap > 0 ? { line: twip(p.lineGap), lineRule: LineRuleType.EXACT } : {}),
        },
        indent: { left: twip(Math.max(0, p.x - left)) },
        tabStops: p.tabs.map((t) => ({ type: TabStopType.LEFT, position: twip(p.x - left + t) })),
        children: p.runs.flatMap((r) =>
          r.text.split("\t").map((part, i) => new TextRun({
            children: i > 0 ? [new Tab(), part] : [part],
            font: r.family, size: Math.round(r.size * 2), bold: r.bold, italics: r.italic,
            ...(r.color.toUpperCase() !== "#000000" ? { color: hex(r.color) } : {}),
          })),
        ),
      });
    });

    return {
      properties: {
        page: {
          size: { width: twip(page.width), height: twip(page.height) },
          margin: { top: twip(marginTop), bottom: twip(36), left: twip(left), right: twip(right), header: 0, footer: 0 },
        },
      },
      children: children.length ? children : [new Paragraph({ children: [] })],
    };
  });

  const doc = new Document({ title, creator: "PDFInkly", sections });
  return new Uint8Array(await (await Packer.toBlob(doc)).arrayBuffer());
}
