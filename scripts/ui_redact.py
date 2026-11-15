"""Browser test of redaction: find personal data → mark → save → the saved file no longer contains it.
Usage: python3 scripts/ui_redact.py   (app running on BASE_URL, default http://localhost:3000)"""
import base64, io, os, sys, time
from testutil import make_pro
from playwright.sync_api import sync_playwright, expect
import pypdf
from PIL import Image, ImageChops

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = os.environ.get("SHOTS", "/tmp/shots")
FIX = os.path.join(os.path.dirname(__file__), "..", "packages/shared/test/fixtures")
os.makedirs(OUT, exist_ok=True)

def saved(page):
    file_id = page.url.split("/edit/")[1].split("?")[0]
    b64 = page.evaluate("""async (id) => {
      const f = await (await fetch(`/api/files/${id}`)).json();
      const b = new Uint8Array(await (await fetch(f.downloadUrl)).arrayBuffer());
      let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s);
    }""", file_id)
    raw = base64.b64decode(b64)
    open("/tmp/redact-last.pdf", "wb").write(raw)
    return pypdf.PdfReader(io.BytesIO(raw))

def text_of(reader):
    return " ".join(reader.pages[0].extract_text().split())

_pro = set()
def upload(page, name):
    page.goto(BASE + "/upload")
    page.set_input_files("#file-input", os.path.join(FIX, name))
    page.wait_for_url("**/edit/**", timeout=20000)
    if id(page.context) not in _pro:  # redaction is a Pro tool
        make_pro(page.context)
        _pro.add(id(page.context))
        page.reload()

def find_and_mark(page, query=None):
    page.get_by_role("toolbar", name="Editing tools").get_by_role("button", name="Redact").click()
    panel = page.get_by_role("complementary", name="Properties")
    if query:
        panel.get_by_label("Words or numbers").fill(query)
    panel.get_by_role("button", name="Find", exact=True).click()
    status = panel.get_by_role("status")
    expect(status).to_be_visible(timeout=20000)
    return panel, status

def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))

        # --- Born-digital PDF: personal data + a custom phrase
        upload(page, "chrome-cid.pdf")
        panel, status = find_and_mark(page, "Product designer")
        expect(status).to_contain_text("Found 3")
        expect(status).to_contain_text("Phone 1")
        expect(status).to_contain_text("Email / UPI ID 1")
        print("  ✓ Find:", status.locator("p").first.inner_text())
        status.get_by_role("button", name="Mark all 3 for redaction").click()
        expect(panel).to_contain_text("3 areas marked")
        expect(status).to_contain_text("Everything found is already marked")
        page.screenshot(path=f"{OUT}/redact-01-marked.png")
        page.get_by_role("button", name="Save version").click()
        expect(page.get_by_text("with 3 areas redacted")).to_be_visible(timeout=60000)
        notice = page.get_by_role("status").first.inner_text()
        assert "Check before sharing" not in notice, notice
        text = text_of(saved(page))
        for gone in ["98765", "43210", "aditi.sharma@example.com", "Product designer"]:
            assert gone not in text, f"{gone!r} still in the saved file: {text}"
        for kept in ["Aditi Sharma", "Invoice total due", "INV-2026-0042"]:
            assert kept in text, f"{kept!r} missing: {text}"
        page.wait_for_timeout(800)
        page.screenshot(path=f"{OUT}/redact-02-saved.png")
        print("  ✓ born-digital PDF: phone, email and the phrase are gone from the saved file; the rest is intact")

        # --- A second round on the saved version
        tb = page.get_by_role("button", name="Save version")
        panel, status = find_and_mark(page, "Invoice total")
        expect(status).to_contain_text("Found 1")
        status.get_by_role("button", name="Mark it for redaction").click()
        tb.click()
        expect(page.get_by_text("with 1 area redacted")).to_be_visible(timeout=60000)
        text = text_of(saved(page))
        assert "Invoice total" not in text and "due within 15 days" in text, text
        print("  ✓ a second redaction on the new version removes just those words")

        # --- Scanned PDF: OCR first, then find, then the image pixels are blacked out
        upload(page, "scan-en.pdf")
        panel, status = find_and_mark(page)
        expect(status).to_contain_text("no text (scanned)")
        print("  ✓ scans without OCR: Find explains they need Recognise text first")
        status.get_by_role("button", name="Recognise text").click()
        dlg = page.get_by_role("dialog", name="Recognise text (OCR)")
        dlg.get_by_role("button", name="Recognise text on 1 page").click()
        expect(page.get_by_text("and saved a new version")).to_be_visible(timeout=180000)
        before = saved(page)
        img_before = next(iter(before.pages[0].images)).image.convert("L")

        panel, status = find_and_mark(page)
        expect(status).to_contain_text("Phone 1")
        n = int(status.locator("p").first.inner_text().split("Found ")[1].split(":")[0])
        status.get_by_role("button", name=f"Mark all {n} for redaction" if n > 1 else "Mark it for redaction").click()
        page.screenshot(path=f"{OUT}/redact-03-scan-marked.png")
        t0 = time.time()
        page.get_by_role("button", name="Save version").click()
        expect(page.get_by_text("areas redacted" if n > 1 else "area redacted")).to_be_visible(timeout=90000)
        notice = page.get_by_role("status").first.inner_text()
        assert "Check before sharing" not in notice and "removed entirely" not in notice, notice
        after = saved(page)
        text = text_of(after)
        assert "98765" not in text and "aditi.sharma" not in text, text
        assert "Invoice total due" in text, text
        img_after = next(iter(after.pages[0].images)).image.convert("L")
        assert img_after.size == img_before.size, (img_after.size, img_before.size)
        diff = ImageChops.difference(img_before, img_after).point(lambda v: 255 if v > 60 else 0)
        bbox = diff.getbbox()
        assert bbox, "the scan image did not change"
        changed = img_after.crop(bbox)
        hist = changed.histogram()
        dark = sum(hist[:40]) / max(1, sum(hist))
        assert bbox[1] < img_after.size[1] * 0.2, ("changed area should be near the top (contact line)", bbox)
        print(f"  ✓ scan: OCR text gone and the image pixels under the marks are black ({dark:.0%} dark in {bbox}), saved in {time.time() - t0:.1f}s")
        page.wait_for_timeout(800)
        page.screenshot(path=f"{OUT}/redact-04-scan-saved.png")
        browser.close()

    real = [e for e in errors if "fonts.g" not in e and "favicon" not in e and "Parameter not found" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("Redaction UI test passed.")

if __name__ == "__main__":
    main()
