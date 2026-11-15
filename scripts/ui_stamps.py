"""Browser test of page stamps (watermark, …): dialog → preview → save → the file has them.
Usage: python3 scripts/ui_stamps.py   (app running on BASE_URL, default http://localhost:3000)"""
import base64, io, os, sys
from playwright.sync_api import sync_playwright, expect
import pypdf

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
    open("/tmp/stamps-last.pdf", "wb").write(raw)
    return pypdf.PdfReader(io.BytesIO(raw)), raw

def save(page):
    page.get_by_role("button", name="Save version").click()
    expect(page.get_by_text("Saved as a new version")).to_be_visible(timeout=60000)

def open_stamps(page, tab=None):
    page.get_by_role("toolbar", name="Editing tools").get_by_role("button", name="Stamps").click()
    dlg = page.get_by_role("dialog", name="Page stamps")
    expect(dlg).to_be_visible()
    if tab:
        dlg.get_by_role("tab", name=tab).click()
    return dlg

def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))

        page.goto(BASE + "/upload")
        page.set_input_files("#file-input", os.path.join(FIX, "chrome-cid.pdf"))
        page.wait_for_url("**/edit/**", timeout=20000)

        # --- Watermark
        dlg = open_stamps(page)
        expect(dlg.get_by_label("Text", exact=True)).to_have_value("CONFIDENTIAL")
        expect(dlg.get_by_test_id("stamp-preview").locator("text")).to_have_text("CONFIDENTIAL")
        dlg.get_by_label("Text", exact=True).fill("DRAFT COPY")
        dlg.get_by_label("Repeated across the page").check()
        expect(dlg.get_by_test_id("stamp-preview").locator("text").first).to_have_text("DRAFT COPY")
        n_tiles = dlg.get_by_test_id("stamp-preview").locator("text").count()
        assert n_tiles > 6, n_tiles
        page.screenshot(path=f"{OUT}/stamps-01-watermark-dialog.png")
        dlg.get_by_role("button", name="Add watermark").click()
        expect(dlg).to_have_count(0)
        expect(page.locator('[data-testid="stamp-preview"] text').first).to_have_text("DRAFT COPY")
        save(page)
        reader, raw = saved(page)
        text = reader.pages[0].extract_text()
        assert text.count("DRAFT COPY") >= 6, text
        assert "Aditi Sharma" in text, text
        print(f"  ✓ watermark: tiled in the preview ({n_tiles}) and in the saved file ({text.count('DRAFT COPY')}), content intact")
        page.wait_for_timeout(600)
        page.screenshot(path=f"{OUT}/stamps-02-watermark-saved.png")

        # Removing it on a later version leaves the earlier one alone (stamps are drawn into the file on save).
        dlg = open_stamps(page)
        expect(dlg.get_by_role("button", name="Remove watermark")).to_have_count(0)
        dlg.get_by_role("button", name="Cancel").click()
        print("  ✓ after saving, the watermark is part of the file (dialog starts fresh)")
        browser.close()

    real = [e for e in errors if "favicon" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("Stamps UI test passed.")

if __name__ == "__main__":
    main()
