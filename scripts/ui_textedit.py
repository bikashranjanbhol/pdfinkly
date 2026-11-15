"""Browser test of editing existing PDF text.
Usage: python3 scripts/ui_textedit.py [pdf]   (app running on BASE_URL, default http://localhost:3000)"""
import base64, io, os, sys
from playwright.sync_api import sync_playwright, expect
import pypdf

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = os.environ.get("SHOTS", "/tmp/shots")
PDF = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "packages/shared/test/fixtures/chrome-cid.pdf")
os.makedirs(OUT, exist_ok=True)

def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))

        page.goto(BASE + "/upload")
        page.set_input_files("#file-input", PDF)
        page.wait_for_url("**/edit/**", timeout=20000)
        expect(page.get_by_role("group", name="Page 1")).to_be_visible(timeout=20000)
        page.wait_for_timeout(1000)

        tools = page.get_by_role("toolbar", name="Editing tools")
        tools.get_by_role("button", name="Edit text").click()
        block = page.get_by_role("button", name="Edit text: Product designer")
        expect(block).to_be_visible(timeout=15000)
        n_blocks = page.locator('[aria-label^="Edit text: "]').count()
        print(f"  ✓ Edit text tool found {n_blocks} text blocks")

        block.hover()
        chip = block.locator("div").first
        expect(chip).to_contain_text("Carlito")
        expect(chip).to_contain_text("11 pt")
        expect(chip).to_contain_text("embedded (partial)")
        page.screenshot(path=f"{OUT}/te-01-hover.png")
        print("  ✓ hover shows font:", chip.inner_text().replace("\n", " | "))

        heading = page.get_by_role("button", name="Edit text: Aditi Sharma")
        heading.hover()
        expect(heading.locator("div").first).to_contain_text("Poppins Bold · 22 pt")
        print("  ✓ heading font detected as Poppins Bold · 22 pt")

        block.click()
        ta = page.get_by_role("textbox", name="Edit text")
        expect(ta).to_be_focused()
        assert ta.input_value().startswith("Product designer with 6 years"), ta.input_value()
        page.screenshot(path=f"{OUT}/te-02-editing.png")
        ta.fill("Senior product designer with 7 years of experience in fintech.\nLed the payments dashboard redesign for 40,000 merchants.")
        page.keyboard.press("Escape")
        expect(page.get_by_text("Your edits · 1")).to_be_visible()
        page.screenshot(path=f"{OUT}/te-03-edited.png")
        print("  ✓ paragraph edited in place")

        # Properties panel shows the font comparison
        tools.get_by_role("button", name="Select").click()
        page.get_by_role("complementary", name="Properties").get_by_role("button", name="Edited · Senior product designer").click()
        expect(page.get_by_text("Font in the PDF")).to_be_visible()
        expect(page.get_by_text("Carlito · 11 pt")).to_be_visible()
        print("  ✓ properties show original font")

        # Edit the e-mail on the mixed-font line (bold label + regular value)
        tools.get_by_role("button", name="Edit text").click()
        email = page.get_by_role("button", name="Edit text: aditi.sharma@example.com")
        expect(email).to_be_visible()
        email.click()
        ta = page.get_by_role("textbox", name="Edit text")
        ta.fill("aditi@pdfinkly.com")
        page.keyboard.press("Escape")
        expect(page.get_by_text("Your edits · 2")).to_be_visible()
        print("  ✓ second edit on a mixed-font line")

        # Opening and closing without changes adds nothing
        page.get_by_role("button", name="Edit text: Reference:").click()
        page.keyboard.press("Escape")
        expect(page.get_by_text("Your edits · 2")).to_be_visible()
        print("  ✓ opening without changes adds no edit")

        expect(page.get_by_text("Draft saved")).to_be_visible(timeout=8000)
        page.reload()
        expect(page.get_by_text("Your edits · 2")).to_be_visible(timeout=20000)
        print("  ✓ edits survive reload (autosaved draft)")

        page.get_by_role("button", name="Save version").click()
        expect(page.get_by_text("Saved as a new version.")).to_be_visible(timeout=30000)
        page.wait_for_timeout(1500)
        page.screenshot(path=f"{OUT}/te-04-saved.png")

        file_id = page.url.split("/edit/")[1].split("?")[0]
        b64 = page.evaluate("""async (id) => {
          const f = await (await fetch(`/api/files/${id}`)).json();
          const b = new Uint8Array(await (await fetch(f.downloadUrl)).arrayBuffer());
          let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s);
        }""", file_id)
        pdf = pypdf.PdfReader(io.BytesIO(base64.b64decode(b64)))
        text = pdf.pages[0].extract_text()
        assert "Senior product designer with 7 years" in text, text
        assert "aditi@pdfinkly.com" in text, text
        for gone in ["6 years of experience", "healthcare", "aditi.sharma@example.com"]:
            assert gone not in text, f"old text still in file: {gone}\n{text}"
        for kept in ["Aditi Sharma", "Email:", "Phone:", "Invoice total due", "INV-2026-0042"]:
            assert kept in text, f"lost: {kept}"
        fonts = sorted({str(f.get_object().get("/BaseFont")) for f in pdf.pages[0]["/Resources"]["/Font"].values()})
        print("  ✓ saved PDF: new text present, old text truly gone, other text intact")
        print("    fonts in saved page:", ", ".join(fonts))

        browser.close()
    real = [e for e in errors if "fonts.g" not in e and "favicon" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("Text editing UI test passed.")

if __name__ == "__main__":
    main()
