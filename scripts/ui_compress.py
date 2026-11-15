"""Browser test of compression: presets and a target size, downloaded and saved as a version.
Usage: python3 scripts/ui_compress.py   (app running on BASE_URL, default http://localhost:3000)"""
import os, sys, tempfile
from playwright.sync_api import sync_playwright, expect
from pypdf import PdfReader

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = os.environ.get("SHOTS", "/tmp/shots")
FIX = os.path.join(os.path.dirname(__file__), "..", "packages/shared/test/fixtures")
TMP = tempfile.mkdtemp()
os.makedirs(OUT, exist_ok=True)

def open_compress(page):
    page.get_by_role("button", name="Download", exact=True).click()
    page.get_by_role("menuitem", name="Compress…").click()
    dlg = page.get_by_role("dialog", name="Compress PDF")
    expect(dlg.get_by_text("Now ")).to_be_visible(timeout=20000)
    return dlg

def download(page, dlg, name):
    with page.expect_download() as dl:
        dlg.get_by_role("button", name="Download").click()
    path = os.path.join(TMP, name)
    dl.value.save_as(path)
    return path, dl.value.suggested_filename

def main():
    errors = []
    original = os.path.getsize(os.path.join(FIX, "scan-en.pdf"))
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.goto(BASE + "/upload")
        page.set_input_files("#file-input", os.path.join(FIX, "scan-en.pdf"))
        page.wait_for_url("**/edit/**", timeout=20000)

        # --- Recommended preset
        dlg = open_compress(page)
        dlg.get_by_role("button", name="Compress", exact=True).click()
        status = dlg.get_by_role("status").filter(has_text="smaller")
        expect(status).to_be_visible(timeout=60000)
        print("  ✓ recommended:", status.inner_text())
        page.screenshot(path=f"{OUT}/compress-01-result.png")
        path, name = download(page, dlg, "rec.pdf")
        assert name == "scan-en (compressed).pdf", name
        size = os.path.getsize(path)
        r = PdfReader(path)
        img = list(r.pages[0].images)[0].image
        assert size < original * 0.5, (size, original)
        assert 1100 < img.size[0] < 1400, img.size  # 150 dpi across an A4 width ≈ 1240 px
        assert len(r.pages) == 1
        print(f"  ✓ downloaded {name}: {original // 1024} KB → {size // 1024} KB, image {img.size[0]}×{img.size[1]}")
        dlg.get_by_role("button", name="Close").click()

        # --- Under 100 KB, then save as a new version
        dlg = open_compress(page)
        dlg.get_by_label("Under a size").check()
        dlg.get_by_role("button", name="100 KB").click()
        dlg.get_by_role("button", name="Compress", exact=True).click()
        status = dlg.get_by_role("status").filter(has_text="smaller")
        expect(status).to_be_visible(timeout=120000)
        assert "couldn't get under" not in status.inner_text(), status.inner_text()
        path, _ = download(page, dlg, "100k.pdf")
        size = os.path.getsize(path)
        assert size <= 100 * 1024, size
        print(f"  ✓ under 100 KB: {size // 1024} KB ({status.inner_text().splitlines()[0]})")
        dlg.get_by_role("button", name="Save as new version").click()
        expect(page.get_by_text("Saved the compressed PDF as a new version.")).to_be_visible(timeout=30000)
        print("  ✓ saved the compressed PDF as a new version")
        browser.close()

    real = [e for e in errors if "favicon" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("Compression UI test passed.")

if __name__ == "__main__":
    main()
