"""Browser test of Scan: photos → found and straightened pages → looks → corners → PDF.
Usage: python3 scripts/ui_scan.py (app running at BASE_URL, default http://localhost:3000)"""
import os, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = os.environ.get("SHOTS", "/tmp/shots")
PHOTOS = os.path.join(os.path.dirname(__file__), "..", "packages/shared/test/fixtures/photos")
os.makedirs(OUT, exist_ok=True)
photo = lambda n: os.path.join(PHOTOS, n)

def wait_ready(page, count):
    expect(page.get_by_role("region", name="Pages").get_by_role("listitem").filter(has=page.get_by_role("img"))).to_have_count(count, timeout=60000)
    expect(page.get_by_role("status").filter(has_text="Finding the page")).to_have_count(0, timeout=60000)
    expect(page.get_by_role("status").filter(has_text="Cleaning up")).to_have_count(0, timeout=60000)

def thumb_ratio(page, n):
    return page.get_by_alt_text(f"Scanned page {n}").evaluate("i => i.naturalHeight / i.naturalWidth")

def pdf_info(path):
    info = subprocess.run(["pdfinfo", path], capture_output=True, text=True).stdout
    pages = int(next(l.split()[-1] for l in info.splitlines() if l.startswith("Pages:")))
    size = next(l for l in info.splitlines() if l.startswith("Page size:"))
    return pages, size

def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])

        # ---------------- Desktop ----------------
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.goto(BASE + "/scan")
        expect(page.get_by_role("heading", name="Scan documents")).to_be_visible()
        expect(page.get_by_text("Take a photo")).to_be_visible()
        page.screenshot(path=f"{OUT}/scan-01-empty.png")

        page.set_input_files("#scan-photos", [photo("desk-angle.jpg"), photo("light-desk.jpg"), photo("no-page.jpg")])
        wait_ready(page, 3)
        pages = page.get_by_role("region", name="Pages")
        # Pages found and straightened to A4 proportions; the empty photo is flagged.
        for n in (1, 2):
            r = thumb_ratio(page, n)
            assert abs(r - 1.414) < 0.02, (n, r)
            expect(pages.get_by_role("listitem", name=f"Page {n}")).not_to_contain_text("Edges not found")
        expect(pages.get_by_role("listitem", name="Page 3")).to_contain_text("Edges not found")
        page.screenshot(path=f"{OUT}/scan-02-pages.png", full_page=True)
        print("  ✓ three photos: two pages found and straightened (A4), one flagged")

        # Preview: big, page by page, with its own look.
        page.get_by_role("button", name="Preview page 1").click()
        vw = page.get_by_role("dialog", name="Page 1 of 3")
        expect(vw).to_be_visible()
        w = vw.get_by_alt_text("Preview of page 1").evaluate("i => i.naturalWidth")
        assert w >= 600, w  # the page at full size (these test photos are small), well above the thumbnail
        vw.get_by_role("button", name="Next page").click()
        expect(page.get_by_role("dialog", name="Page 2 of 3")).to_be_visible()
        page.keyboard.press("ArrowLeft")
        vw = page.get_by_role("dialog", name="Page 1 of 3")
        expect(vw).to_be_visible()
        vw.get_by_role("radio", name="Greyscale").click()
        expect(vw.get_by_role("status")).to_have_count(0, timeout=60000)
        expect(vw.get_by_role("radio", name="Greyscale")).to_have_attribute("aria-checked", "true")
        col = vw.get_by_alt_text("Preview of page 1").evaluate("""i => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
            const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data;
            let n = 0; for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - d[k+2]) > 30) n++; return n; }""")
        assert col == 0, col
        vw.get_by_role("button", name="Zoom in").click()
        expect(vw.get_by_role("button", name="Fit to screen")).to_be_visible()
        page.screenshot(path=f"{OUT}/scan-02b-preview.png")
        vw.get_by_role("radio", name="Same as all").click()
        expect(vw.get_by_role("status")).to_have_count(0, timeout=60000)
        page.keyboard.press("Escape")
        expect(vw).to_be_hidden()
        print("  ✓ preview: full size, next/previous, keyboard, zoom, a look for one page")

        # The cleaned-up page is white at the edges (no table) and has text.
        px = page.get_by_alt_text("Scanned page 1").evaluate("""i => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
            const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data;
            const at = (u, v) => { const k = (Math.floor(v * c.height) * c.width + Math.floor(u * c.width)) * 4; return (d[k] + d[k+1] + d[k+2]) / 3; };
            let dark = 0; for (let k = 0; k < d.length; k += 4) if (d[k] < 160) dark++;
            return { corners: [at(.02,.02), at(.98,.02), at(.98,.98), at(.02,.98), at(.05,.9)], dark: dark / (d.length / 4) }; }""")
        assert min(px["corners"]) > 235, px
        assert 0.002 < px["dark"] < 0.2, px
        print("  ✓ Auto look: white page (shadow gone), text kept")

        # Black & white for all pages.
        page.get_by_role("radio", name="Black & white").click()
        expect(page.get_by_role("radio", name="Black & white")).to_have_attribute("aria-checked", "true")
        wait_ready(page, 3)
        grey = page.get_by_alt_text("Scanned page 1").evaluate("""i => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
            const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data;
            let mid = 0, col = 0; for (let k = 0; k < d.length; k += 4) { if (d[k] > 70 && d[k] < 185) mid++; if (Math.abs(d[k] - d[k+2]) > 30) col++; } return { mid: mid / (d.length / 4), col }; }""")
        assert grey["mid"] < 0.06 and grey["col"] == 0, grey  # black and white (thumbnail smoothing aside), no colour
        print("  ✓ Black & white applies to every page")

        # Remove the photo with no page.
        pages.get_by_role("listitem", name="Page 3").get_by_role("button", name="Remove page 3").click()
        expect(pages.get_by_role("listitem").filter(has=page.get_by_role("img"))).to_have_count(2)

        # Adjust corners: drag, keyboard, find again, per-page look.
        page.get_by_role("button", name="Adjust page 1").click()
        dlg = page.get_by_role("dialog", name="Adjust page 1")
        expect(dlg).to_be_visible()
        tl = dlg.get_by_role("button", name="Top-left corner")
        before = tl.evaluate("b => b.style.left")
        box = tl.bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.mouse.move(box["x"] + 60, box["y"] + 50, steps=6)
        page.screenshot(path=f"{OUT}/scan-03-corners-drag.png")  # magnifier visible while dragging
        page.mouse.up()
        assert tl.evaluate("b => b.style.left") != before
        tl.focus()
        moved = tl.evaluate("b => b.style.left")
        page.keyboard.press("ArrowLeft")
        assert tl.evaluate("b => b.style.left") != moved
        dlg.get_by_role("button", name="Find edges again").click()
        assert tl.evaluate("b => b.style.left") == before
        dlg.get_by_label("Look").select_option("auto")
        dlg.get_by_role("button", name="Apply").click()
        expect(dlg).to_be_hidden()
        wait_ready(page, 2)
        col = page.get_by_alt_text("Scanned page 1").evaluate("""i => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
            const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data;
            let n = 0; for (let k = 0; k < d.length; k += 4) if (d[k+2] - d[k] > 60) n++; return n; }""")
        assert col > 20, col  # page 1 has its own look (Auto): the blue heading is back
        print("  ✓ corners: drag with magnifier, arrow keys, find again; per-page look")

        # Rotate page 2 a quarter turn, then back upright.
        page.get_by_role("button", name="Rotate page 2").click()
        wait_ready(page, 2)
        assert thumb_ratio(page, 2) < 0.75
        for _ in range(3):
            page.get_by_role("button", name="Rotate page 2").click()
            wait_ready(page, 2)
        assert abs(thumb_ratio(page, 2) - 1.414) < 0.02
        page.get_by_role("button", name="Move page 2 earlier").click()
        print("  ✓ rotate and reorder")

        # Download, under 200 KB.
        page.get_by_label("File name").fill("Bank statement")
        page.get_by_label("File size").select_option("200")
        with page.expect_download(timeout=60000) as dl:
            page.get_by_role("button", name="Download PDF").click()
        d = dl.value
        assert d.suggested_filename == "Bank statement.pdf", d.suggested_filename
        path = os.path.join(tempfile.mkdtemp(), d.suggested_filename)
        d.save_as(path)
        size = os.path.getsize(path)
        n, psize = pdf_info(path)
        assert n == 2 and "595.28 x 841.89" in psize and size <= 200 * 1024, (n, psize, size)
        expect(page.get_by_role("status").filter(has_text="Downloaded Bank statement.pdf (2 pages")).to_be_visible()
        subprocess.run(["pdftoppm", "-r", "50", "-png", "-f", "1", "-l", "1", path, os.path.join(OUT, "scan-page")], check=True)
        page.screenshot(path=f"{OUT}/scan-04-ready.png", full_page=True)
        print(f"  ✓ download: 2 A4 pages, {size // 1024} KB (limit 200 KB)")

        # Same shape as the scan: A4-tall pages in the scan's proportions (A4 here).
        page.get_by_label("Page size").select_option("fit")
        page.get_by_label("File size").select_option("0")
        with page.expect_download(timeout=60000) as dl:
            page.get_by_role("button", name="Download PDF").click()
        path2 = os.path.join(tempfile.mkdtemp(), "fit.pdf")
        dl.value.save_as(path2)
        n, psize = pdf_info(path2)
        assert n == 2 and "x 841.89" in psize and psize.split()[2].startswith("595."), psize

        # Save and edit: goes to the editor with both pages.
        page.get_by_role("button", name="Save and edit").click()
        page.wait_for_url("**/edit/**", timeout=30000)
        expect(page.get_by_role("group", name="Page 2")).to_be_visible(timeout=20000)
        print("  ✓ save and edit opens the scan in the editor")
        ctx.close()

        # ---------------- Phone ----------------
        m = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = m.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/scan")
        assert page.evaluate("document.scrollingElement.scrollWidth") <= 390
        # A camera photo stored sideways (EXIF): the page comes out upright, and is shown straight away.
        page.set_input_files("#scan-camera", photo("desk-exif.jpg"))
        rv = page.get_by_role("dialog", name="Here's your scan")
        expect(rv).to_be_visible(timeout=30000)
        expect(rv.get_by_role("status")).to_have_count(0, timeout=60000)
        img = rv.get_by_alt_text("Preview of page 1")
        r = img.evaluate("i => i.naturalHeight / i.naturalWidth")
        assert abs(r - 1.414) < 0.02, r
        expect(rv.get_by_role("radiogroup", name="Look for this page")).to_be_visible()
        page.screenshot(path=f"{OUT}/scan-05-phone-review.png")
        print("  ✓ phone: camera photo turned upright and previewed straight away")

        # Take next photo from the preview: no clear page → corners first, then the preview.
        with page.expect_file_chooser() as fc:
            rv.get_by_role("button", name="Take next photo").click()
        fc.value.set_files(photo("no-page.jpg"))
        dlg = page.get_by_role("dialog", name="Adjust page 2")
        expect(dlg).to_be_visible(timeout=30000)
        expect(dlg.get_by_text("We couldn't find the page edges.")).to_be_visible()
        page.screenshot(path=f"{OUT}/scan-06-phone-corners.png")
        dlg.get_by_role("button", name="Whole photo").click()
        dlg.get_by_role("button", name="Apply").click()
        expect(rv).to_be_visible(timeout=30000)
        expect(rv.get_by_text("Page 2", exact=True)).to_be_visible()

        # Retake replaces that page.
        with page.expect_file_chooser() as fc:
            rv.get_by_role("button", name="Retake").click()
        fc.value.set_files(photo("light-desk.jpg"))
        expect(rv).to_be_visible(timeout=30000)
        expect(rv.get_by_role("status")).to_have_count(0, timeout=60000)
        rv.get_by_role("button", name="Done").click()
        expect(rv).to_be_hidden()
        wait_ready(page, 2)
        assert abs(thumb_ratio(page, 2) - 1.414) < 0.02
        assert page.evaluate("document.scrollingElement.scrollWidth") <= 390
        page.screenshot(path=f"{OUT}/scan-07-phone.png", full_page=True)
        print("  ✓ phone: take next photo, fix corners, retake, all from the preview")
        browser.close()

    real = [e for e in errors if "favicon" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("Scan UI test passed.")

if __name__ == "__main__":
    main()
