"""Browser test of OCR: scan → Recognise text → searchable PDF → Edit text on recognised words.
Usage: python3 scripts/ui_ocr.py   (app running on BASE_URL, default http://localhost:3000)"""
import base64, io, os, sys, time
from playwright.sync_api import sync_playwright, expect
import pypdf

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = os.environ.get("SHOTS", "/tmp/shots")
FIX = os.path.join(os.path.dirname(__file__), "..", "packages/shared/test/fixtures")
os.makedirs(OUT, exist_ok=True)

def saved_pdf(page):
    file_id = page.url.split("/edit/")[1].split("?")[0]
    b64 = page.evaluate("""async (id) => {
      const f = await (await fetch(`/api/files/${id}`)).json();
      const b = new Uint8Array(await (await fetch(f.downloadUrl)).arrayBuffer());
      let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s);
    }""", file_id)
    raw = base64.b64decode(b64)
    open("/tmp/ocr-browser-last.pdf", "wb").write(raw)
    first = pypdf.PdfReader(io.BytesIO(raw)).pages[0]
    return " ".join(first.extract_text().split()), int(first.get("/Rotate", 0) or 0)

def saved_text(page):
    return saved_pdf(page)[0]

def recognise(page, langs, from_hint=True, redo=False):
    if from_hint:
        expect(page.get_by_text("This PDF looks scanned")).to_be_visible(timeout=20000)
        print("  ✓ scanned PDF detected, OCR suggested")
        page.get_by_role("status").get_by_role("button", name="Recognise text").click()
    else:
        page.get_by_role("banner").get_by_role("button", name="Recognise text").click()
    dlg = page.get_by_role("dialog", name="Recognise text (OCR)")
    expect(dlg.get_by_text("Scanned pages (1 of 1)")).to_be_visible(timeout=15000)
    if redo:
        expect(dlg.get_by_text("1 page was recognised before. Recognising again replaces that text.")).to_be_visible()
    expect(dlg.get_by_role("checkbox", name="Turn sideways or upside-down pages upright")).to_be_checked()
    for label, want in [("English", "eng" in langs), ("Hindi (हिन्दी)", "hin" in langs)]:
        box = dlg.get_by_role("checkbox", name=label)
        if box.is_checked() != want: box.click()
    page.screenshot(path=f"{OUT}/ocr-01-dialog.png")
    t0 = time.time()
    dlg.get_by_role("button", name="Recognise text on 1 page").click()
    expect(dlg.get_by_role("progressbar")).to_be_visible()
    expect(page.get_by_text("and saved a new version")).to_be_visible(timeout=180000)
    print(f"  ✓ OCR finished and saved in {time.time() - t0:.1f}s:", page.get_by_role("status").first.inner_text().split(" and saved")[0])

def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))

        # --- English scan
        page.goto(BASE + "/upload")
        page.set_input_files("#file-input", os.path.join(FIX, "scan-en.pdf"))
        page.wait_for_url("**/edit/**", timeout=20000)
        recognise(page, ["eng"])
        text = saved_text(page)
        for s in ["Aditi Sharma", "Product designer", "payments dashboard", "Invoice total due", "INV-2026-0042"]:
            assert s in text, f"missing {s!r} in OCR text:\n{text}"
        print("  ✓ saved PDF is searchable (pypdf extracts the recognised text)")
        expect(page.get_by_text("This PDF looks scanned")).to_have_count(0)

        tools = page.get_by_role("toolbar", name="Editing tools")
        tools.get_by_role("button", name="Edit text").click()
        block = page.get_by_role("button", name="Edit text: Product designer")
        expect(block).to_be_visible(timeout=15000)
        block.hover()
        expect(block.locator("div").first).to_contain_text("Recognised text (OCR)")
        print("  ✓ hover identifies recognised text:", block.locator("div").first.inner_text().replace("\n", " | "))
        page.screenshot(path=f"{OUT}/ocr-02-hover.png")
        block.click()
        ta = page.get_by_role("textbox", name="Edit text")
        ff = ta.evaluate("el => getComputedStyle(el).fontFamily")
        assert "Helvetica" in ff or "Arial" in ff, ff
        ta.fill("Senior designer, now editing a scanned page.")
        page.keyboard.press("Escape")
        page.screenshot(path=f"{OUT}/ocr-03-edited.png")
        page.get_by_role("button", name="Save version").click()
        expect(page.get_by_text("Saved as a new version.")).to_be_visible(timeout=30000)
        page.wait_for_timeout(1500)
        page.screenshot(path=f"{OUT}/ocr-04-saved.png")
        text = saved_text(page)
        assert "Senior designer, now editing a scanned page." in text, text
        assert "healthcare" not in text, text
        assert "Invoice total due" in text
        print("  ✓ edited recognised text: new words in the file, old OCR words gone")

        # --- Hindi + English scan
        page.goto(BASE + "/upload")
        page.set_input_files("#file-input", os.path.join(FIX, "scan-hi.pdf"))
        page.wait_for_url("**/edit/**", timeout=20000)
        recognise(page, ["eng", "hin"])
        text = saved_text(page)
        for s in ["भुगतान", "दिनों", "Invoice", "2026-0042"]:
            assert s in text, f"missing {s!r}:\n{text}"
        print("  ✓ Hindi scan: Devanagari text extractable from the saved PDF")
        page.get_by_role("toolbar", name="Editing tools").get_by_role("button", name="Edit text").click()
        hindi = page.locator('[aria-label^="Edit text: "][aria-disabled="true"]').first
        expect(hindi).to_be_visible(timeout=15000)
        hindi.hover()
        expect(hindi.locator("div").first).to_contain_text("isn't supported yet")
        hindi.click(force=True)
        expect(page.get_by_role("textbox", name="Edit text")).to_have_count(0)
        latin = page.get_by_role("button", name="Edit text: Invoice total due")
        expect(latin).to_be_visible()
        print("  ✓ Hindi blocks are marked not editable; English blocks on the same page stay editable")

        # --- Sideways scan: OCR detects it, turns the page upright, and the text is editable
        page.goto(BASE + "/upload")
        page.set_input_files("#file-input", os.path.join(FIX, "scan-en-sideways.pdf"))
        page.wait_for_url("**/edit/**", timeout=20000)
        expect(page.get_by_role("button", name="Rotate page 1 right")).to_be_visible(timeout=15000)
        recognise(page, ["eng"])
        expect(page.get_by_text("Turned 1 sideways page upright.")).to_be_visible()
        text, rot = saved_pdf(page)
        assert rot == 90, rot
        for s in ["Aditi Sharma", "Product designer", "payments dashboard", "Invoice total due"]:
            assert s in text, f"missing {s!r} in OCR text of the sideways scan:\n{text}"
        print("  ✓ sideways scan: detected, turned upright (/Rotate 90) and recognised correctly")
        page.wait_for_timeout(800)
        page.screenshot(path=f"{OUT}/ocr-05-sideways-upright.png")

        tools = page.get_by_role("toolbar", name="Editing tools")
        tools.get_by_role("button", name="Edit text").click()
        block = page.get_by_role("button", name="Edit text: Product designer")
        expect(block).to_be_visible(timeout=15000)
        block.click()
        ta = page.get_by_role("textbox", name="Edit text")
        ta.fill("Edited after turning the page.")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        page.screenshot(path=f"{OUT}/ocr-06-sideways-edited.png")
        page.get_by_role("button", name="Save version").click()
        expect(page.get_by_text("Saved as a new version.")).to_be_visible(timeout=30000)
        text, rot = saved_pdf(page)
        assert rot == 90 and "Edited after turning the page." in text and "healthcare" not in text, (rot, text)
        print("  ✓ Edit text works on the turned page; the new text reads upright in the saved file")

        # Recognising again replaces the old text layer (no duplicate words).
        recognise(page, ["eng"], from_hint=False, redo=True)
        text, rot = saved_pdf(page)
        assert text.count("Aditi") == 1 and text.count("Invoice total due") == 1, text
        assert rot == 90, rot
        print("  ✓ recognising again replaced the old text layer (each line once), page stays upright")

        # Rotate buttons in the Edit view; sideways text offers to turn the page back.
        page.get_by_role("button", name="Rotate page 1 left").click()
        tools.get_by_role("button", name="Edit text").click()
        hint = page.get_by_text("The text on this page runs sideways. Turn the page to edit it.")
        expect(hint).to_be_visible(timeout=15000)
        expect(page.get_by_role("button", name="Edit text: Invoice total due")).to_have_count(0)
        page.screenshot(path=f"{OUT}/ocr-07-rotated-hint.png")
        page.get_by_role("button", name="Turn page upright").click()
        expect(hint).to_have_count(0)
        expect(page.get_by_role("button", name="Edit text: Invoice total due")).to_be_visible(timeout=15000)
        print("  ✓ rotate buttons work; sideways text offers 'Turn page upright', which makes it editable again")
        browser.close()

    real = [e for e in errors if "fonts.g" not in e and "favicon" not in e and "Parameter not found" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("OCR UI test passed.")

if __name__ == "__main__":
    main()
