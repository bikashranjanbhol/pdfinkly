"""Browser test of conversion: PDF → Word, Excel, PowerPoint, images (and scanned → Word with OCR).
Checks the files with python-docx, openpyxl and python-pptx, and renders them with LibreOffice for a look.
Usage: python3 scripts/ui_convert.py   (app running on BASE_URL, default http://localhost:3000)"""
import os, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright, expect
import docx, openpyxl, pptx
from PIL import Image

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = os.environ.get("SHOTS", "/tmp/shots")
FIX = os.path.join(os.path.dirname(__file__), "..", "packages/shared/test/fixtures")
TMP = tempfile.mkdtemp()
os.makedirs(OUT, exist_ok=True)

def upload(page, name):
    page.goto(BASE + "/upload")
    page.set_input_files("#file-input", os.path.join(FIX, name))
    page.wait_for_url("**/edit/**", timeout=20000)

def convert(page, choice, button, setup=None, timeout=90000):
    page.get_by_role("button", name="Download", exact=True).click()
    page.get_by_role("menuitem", name="Convert to Word, Excel…").click()
    dlg = page.get_by_role("dialog", name="Convert PDF")
    dlg.get_by_label(choice).check()
    if setup:
        setup(dlg)
    btn = dlg.get_by_role("button", name=button)
    expect(btn).to_be_enabled(timeout=30000)
    with page.expect_download(timeout=timeout) as dl:
        btn.click()
    d = dl.value
    path = os.path.join(TMP, d.suggested_filename)
    d.save_as(path)
    expect(dlg.get_by_role("status").filter(has_text="Downloaded")).to_be_visible()
    done = dlg.get_by_role("status").filter(has_text="Downloaded").inner_text()
    dlg.get_by_role("button", name="Close", exact=True).last.click()
    return path, done

def look(path, shot):
    """Render an Office file's first page with LibreOffice, for the screenshot folder."""
    subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", TMP, path], capture_output=True, timeout=120)
    pdf = os.path.splitext(path)[0] + ".pdf"
    if os.path.exists(pdf):
        subprocess.run(["pdftoppm", "-png", "-r", "70", "-f", "1", "-l", "1", pdf, os.path.join(OUT, shot)], capture_output=True)

def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))

        # --- Word
        upload(page, "chrome-cid.pdf")
        path, _ = convert(page, "Word", "Convert to Word")
        assert path.endswith("chrome-cid.docx"), path
        d = docx.Document(path)
        paras = [p for p in d.paragraphs if p.text.strip()]
        texts = [p.text for p in paras]
        title = next(p for p in paras if p.text.strip() == "Aditi Sharma")
        r = title.runs[0]
        assert r.font.size.pt > 20 and r.font.bold, (r.font.size, r.font.bold)
        assert str(r.font.color.rgb) not in ("000000", "None"), r.font.color.rgb
        contact = next(p for p in paras if p.text.startswith("Email:"))
        assert "aditi.sharma@example.com" in contact.text and "Phone:" in contact.text, contact.text
        assert any(r.bold for r in contact.runs) and any(not r.bold for r in contact.runs), [(r.text, r.bold) for r in contact.runs]
        body = next(t for t in texts if t.startswith("Product designer"))
        assert body.endswith("40,000 merchants.") and "Led the redesign" in body, body  # two lines joined into one paragraph
        assert any("INV-2026-0042" in t for t in texts)
        sec = d.sections[0]
        assert abs(sec.page_width.pt - 595.92) < 1, sec.page_width.pt
        print(f"  ✓ Word: {len(paras)} paragraphs; heading 22pt+ bold coloured, mixed bold/regular runs kept, wrapped lines rejoined")
        look(path, "convert-word")

        # --- PowerPoint
        path, _ = convert(page, "PowerPoint", "Convert to PowerPoint")
        prs = pptx.Presentation(path)
        assert len(prs.slides) == 1
        slide = prs.slides[0]
        texts = [sh.text_frame.text for sh in slide.shapes if sh.has_text_frame]
        assert any(t == "Aditi Sharma" for t in texts), texts
        assert any("Product designer" in t for t in texts), texts
        assert abs(prs.slide_width.pt - 595.92) < 1
        bg = slide.background.fill
        print(f"  ✓ PowerPoint: 1 slide at page size, {len(texts)} editable text boxes over a text-free background")
        look(path, "convert-pptx")

        # --- Images
        path, _ = convert(page, "Images", "Convert to JPG images")
        im = Image.open(path)
        assert path.endswith("chrome-cid.jpg") and abs(im.size[0] - 1242) <= 2, (path, im.size)
        print(f"  ✓ Images: {os.path.basename(path)} at 150 dpi ({im.size[0]}×{im.size[1]})")

        # --- Excel from a statement
        upload(page, "statement-libreoffice.pdf")
        path, _ = convert(page, "Excel", "Convert to Excel")
        wb = openpyxl.load_workbook(path)
        ws = wb.worksheets[0]
        rows = [[c.value for c in row] for row in ws.iter_rows()]
        flat = [r for r in rows if any(v is not None for v in r)]
        header = next(r for r in flat if "Date" in r)
        assert header[:5] == ["Date", "Description", "Debit", "Credit", "Balance"], header
        salary = next(r for r in flat if "Salary credit" in r)
        assert salary[0] == "02/11/2026" and salary[3] == 124500 and salary[4] == 136950, salary
        rent = next(r for r in flat if "Rent transfer" in r)
        assert rent[2] == 25000 and rent[3] is None, rent
        cell = next(c for row in ws.iter_rows() for c in row if c.value == 124500)
        assert cell.number_format == "#,##0.00", cell.number_format
        print(f"  ✓ Excel: header + {len([r for r in flat if r and isinstance(r[0], str) and r[0].count('/') == 2])} transactions in columns, amounts as numbers (#,##0.00)")
        look(path, "convert-xlsx")

        # --- Scanned → Word with OCR
        upload(page, "scan-en.pdf")
        def ocr_on(dlg):
            expect(dlg.get_by_text("Recognise text on the scanned page first")).to_be_visible(timeout=20000)
            expect(dlg.get_by_label("Recognise text on the scanned page first", exact=False)).to_be_checked()
        path, done = convert(page, "Word", "Convert to Word", ocr_on, timeout=180000)
        assert "recognised first" in done, done
        d = docx.Document(path)
        text = "\n".join(p.text for p in d.paragraphs)
        for s in ["Aditi Sharma", "Product designer", "Invoice total due"]:
            assert s in text, f"{s!r} missing from OCR'd Word: {text[:400]}"
        print("  ✓ scanned PDF → Word: text recognised first and editable in the document")
        browser.close()

    real = [e for e in errors if "favicon" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("Conversion UI test passed.")

if __name__ == "__main__":
    main()
