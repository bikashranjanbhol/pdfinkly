"""Browser test of the main flow: upload -> editor -> annotate -> autosave -> save version -> organize -> sign.
Usage: python3 scripts/ui_test.py  (app running on http://localhost:3000)"""
import os, sys, time, io
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = os.environ.get("SHOTS", "/tmp/shots")
os.makedirs(OUT, exist_ok=True)

def make_pdf(path, pages=3):
    # Minimal multi-page PDF built by hand (no extra deps).
    objs = []
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(pages))
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>")
    for i in range(pages):
        content = f"BT /F1 28 Tf 72 700 Td (Page {i+1} - PDFInkly test) Tj ET".encode()
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + i * 2} 0 R /Resources << /Font << /F1 {3 + pages * 2} 0 R >> >> >>")
        objs.append(content)
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for n, o in enumerate(objs, start=1):
        offsets.append(out.tell())
        if isinstance(o, bytes):
            out.write(f"{n} 0 obj\n<< /Length {len(o)} >>\nstream\n".encode() + o + b"\nendstream\nendobj\n")
        else:
            out.write(f"{n} 0 obj\n{o}\nendobj\n".encode())
    xref = out.tell()
    out.write(f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n".encode())
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    open(path, "wb").write(out.getvalue())

def main():
    pdf = "/tmp/ui-test.pdf"
    make_pdf(pdf, 3)
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))

        page.goto(BASE + "/")
        expect(page.get_by_role("heading", name="Edit any PDF without installing anything.")).to_be_visible()
        page.screenshot(path=f"{OUT}/01-landing.png", full_page=False)
        print("  ✓ landing renders")

        page.goto(BASE + "/upload")
        page.set_input_files("#file-input", pdf)
        page.wait_for_url("**/edit/**", timeout=20000)
        expect(page.get_by_role("group", name="Page 1")).to_be_visible(timeout=20000)
        page.wait_for_timeout(1200)
        page.screenshot(path=f"{OUT}/02-editor.png")
        print("  ✓ upload redirects to editor and page 1 renders")

        canvas_ok = page.evaluate("""() => { const c = document.querySelector('[aria-label="Page 1"] canvas');
          const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let dark=0;
          for (let i=0;i<d.length;i+=4) if (d[i]<100) dark++; return dark; }""")
        assert canvas_ok > 100, f"page canvas looks blank ({canvas_ok})"
        print("  ✓ PDF text is drawn on the canvas")

        tools = page.get_by_role("toolbar", name="Editing tools")
        p1 = page.get_by_role("group", name="Page 1")
        box = p1.bounding_box()
        # Highlight
        tools.get_by_role("button", name="Highlight").click()
        page.mouse.move(box["x"] + 90, box["y"] + 80); page.mouse.down()
        page.mouse.move(box["x"] + 400, box["y"] + 110, steps=5); page.mouse.up()
        # Text
        tools.get_by_role("button", name="Add text", exact=True).click()
        page.mouse.click(box["x"] + 120, box["y"] + 300)
        page.keyboard.type("Payment due within 15 days")
        page.mouse.click(box["x"] + 500, box["y"] + 700)  # clicking outside an open text box commits it
        # Draw
        tools.get_by_role("button", name="Draw").click()
        page.mouse.move(box["x"] + 100, box["y"] + 500); page.mouse.down()
        for i in range(12):
            page.mouse.move(box["x"] + 100 + i * 15, box["y"] + 500 + (i % 2) * 20)
        page.mouse.up()
        expect(page.get_by_text("Your edits ·")).to_be_visible()
        n = page.get_by_text("Payment due within 15 days").count()
        assert n >= 1, "text annotation not shown"
        print("  ✓ highlight, text and drawing added")

        # Autosave
        expect(page.get_by_text("Draft saved")).to_be_visible(timeout=8000)
        print("  ✓ draft autosaved")
        page.screenshot(path=f"{OUT}/03-annotated.png")

        # Undo / redo
        before = page.get_by_text("Your edits ·").inner_text()
        page.get_by_role("button", name="Undo").click()
        after = page.get_by_text("Your edits ·").inner_text()
        assert before != after, (before, after)
        page.get_by_role("button", name="Redo").click()
        print("  ✓ undo and redo")

        # Reload keeps the draft
        page.reload()
        expect(page.get_by_text("Payment due within 15 days").first).to_be_visible(timeout=20000)
        print("  ✓ draft restored after reload")

        # Organize: rotate page 2, delete page 3
        page.get_by_role("button", name="Organize pages").click()
        page.get_by_role("button", name="Page 2", exact=True).click()
        page.get_by_role("button", name="Rotate right").click()
        page.get_by_role("button", name="Page 3", exact=True).click()
        page.get_by_role("button", name="Delete").click()
        expect(page.get_by_text("2 pages · drag to reorder")).to_be_visible()
        page.wait_for_timeout(800)
        page.screenshot(path=f"{OUT}/04-organize.png")
        print("  ✓ organize: rotate and delete")

        # Fill and sign: create a typed signature and place it
        page.get_by_role("button", name="Fill and sign").click()
        page.get_by_role("button", name="Add signature").click()
        page.get_by_role("tab", name="Type").click()
        page.get_by_label("Your name").fill("Aditi Sharma")
        page.get_by_role("button", name="Use signature").click()
        expect(page.get_by_role("button", name="Place this signature")).to_have_count(1)
        expect(page.get_by_role("button", name="New signature")).to_be_visible()
        p1 = page.get_by_role("group", name="Page 1")
        p1.scroll_into_view_if_needed()
        box = p1.bounding_box()
        imgs = p1.locator("img").count()
        page.mouse.click(box["x"] + 300, min(box["y"] + 640, 860))
        expect(p1.locator("img")).to_have_count(imgs + 1)
        page.wait_for_timeout(500)
        page.screenshot(path=f"{OUT}/05-signed.png")
        print("  ✓ signature created, listed as saved, and placed")
        # Re-place the saved signature from the panel
        page.get_by_role("button", name="Place this signature").click()
        page.mouse.click(box["x"] + 600, min(box["y"] + 640, 860))
        expect(p1.locator("img")).to_have_count(imgs + 2)
        print("  ✓ saved signature placed again")

        # Save version
        page.get_by_role("button", name="Save version").click()
        expect(page.get_by_text("Saved as a new version.")).to_be_visible(timeout=30000)
        expect(page.get_by_text("All changes saved")).to_be_visible()
        page.get_by_role("button", name="History").click()
        expect(page.get_by_text("Version 2")).to_be_visible()
        page.screenshot(path=f"{OUT}/06-history.png")
        page.keyboard.press("Escape")
        print("  ✓ saved as version 2; history shows it")

        # Saved PDF has 2 pages now
        expect(page.get_by_text("2 pages", exact=True)).to_be_visible()
        print("  ✓ saved file has the organized page count")

        # The saved PDF itself carries the edits
        file_id = page.url.split("/edit/")[1].split("?")[0]
        pdf_b64 = page.evaluate("""async (id) => {
          const f = await (await fetch(`/api/files/${id}`)).json();
          const b = new Uint8Array(await (await fetch(f.downloadUrl)).arrayBuffer());
          let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s);
        }""", file_id)
        import base64, pypdf
        saved = pypdf.PdfReader(io.BytesIO(base64.b64decode(pdf_b64)))
        assert len(saved.pages) == 2, len(saved.pages)
        assert (saved.pages[1].rotation or 0) % 360 == 90, saved.pages[1].rotation
        t1 = saved.pages[0].extract_text()
        assert "Payment due within 15 days" in t1, t1
        res = saved.pages[0]["/Resources"]
        xobjs = res.get("/XObject", {}) if res else {}
        assert len(xobjs) >= 2, f"expected 2 signature images, got {len(xobjs)}"
        print("  ✓ saved PDF: 2 pages, page 2 rotated 90°, text and 2 signatures on page 1")

        # Dashboard
        page.goto(BASE + "/files")
        expect(page.get_by_role("link", name="ui-test.pdf")).to_be_visible()
        page.screenshot(path=f"{OUT}/07-files.png")
        print("  ✓ dashboard lists the file")

        browser.close()
    real = [e for e in errors if "favicon" not in e and "fonts.g" not in e and "ERR_" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("UI test passed.")

if __name__ == "__main__":
    main()
