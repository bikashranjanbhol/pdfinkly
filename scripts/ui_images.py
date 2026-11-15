"""Browser test of pictures → PDF: order, page size, EXIF rotation.
Usage: python3 scripts/ui_images.py   (app running on BASE_URL, default http://localhost:3000)"""
import base64, io, os, sys, tempfile
from playwright.sync_api import sync_playwright, expect
from PIL import Image, ImageDraw
import pypdf

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = os.environ.get("SHOTS", "/tmp/shots")
TMP = tempfile.mkdtemp()
os.makedirs(OUT, exist_ok=True)

def main():
    # A landscape PNG, and a phone-style JPEG stored sideways with EXIF orientation 6 (shows portrait).
    land = os.path.join(TMP, "chart.png")
    im = Image.new("RGB", (900, 500), "white"); d = ImageDraw.Draw(im); d.rectangle([50, 50, 850, 450], outline="blue", width=8); im.save(land)
    photo = os.path.join(TMP, "receipt.jpg")
    raw = Image.new("RGB", (800, 600), "#f5f0e6"); d = ImageDraw.Draw(raw); d.rectangle([20, 20, 300, 580], fill="black")
    exif = Image.Exif(); exif[0x0112] = 6
    raw.save(photo, quality=90, exif=exif.tobytes())

    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.goto(BASE + "/upload")
        page.set_input_files("#file-input", [land, photo])
        panel = page.get_by_role("region", name="Make a PDF from 2 pictures")
        expect(panel).to_be_visible()
        panel.get_by_role("button", name="Move receipt.jpg earlier").click()
        expect(panel.get_by_role("listitem").first).to_contain_text("1. receipt.jpg")
        page.screenshot(path=f"{OUT}/images-01-panel.png")
        panel.get_by_role("button", name="Make PDF (2 pages)").click()
        page.wait_for_url("**/edit/**", timeout=30000)
        expect(page.get_by_text("receipt and 1 more.pdf")).to_be_visible(timeout=20000)
        file_id = page.url.split("/edit/")[1].split("?")[0]
        b64 = page.evaluate("""async (id) => {
          const f = await (await fetch(`/api/files/${id}`)).json();
          const b = new Uint8Array(await (await fetch(f.downloadUrl)).arrayBuffer());
          let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s);
        }""", file_id)
        r = pypdf.PdfReader(io.BytesIO(base64.b64decode(b64)))
        assert len(r.pages) == 2
        w0, h0 = float(r.pages[0].mediabox.width), float(r.pages[0].mediabox.height)
        w1, h1 = float(r.pages[1].mediabox.width), float(r.pages[1].mediabox.height)
        assert (round(w0), round(h0)) == (595, 842), (w0, h0)   # receipt: portrait after EXIF rotation
        assert (round(w1), round(h1)) == (842, 595), (w1, h1)   # chart: landscape A4
        img0 = list(r.pages[0].images)[0].image
        assert img0.size == (600, 800), img0.size               # redrawn upright
        # The black bar was on the left of the stored image; rotated 90° clockwise it's along the top.
        top = img0.crop((0, 0, 600, 100)).convert("L").getextrema()[0]
        bottom = img0.crop((0, 700, 600, 800)).convert("L").getextrema()[0]
        assert top < 40 and bottom > 200, (top, bottom)
        print("  ✓ 2 pictures → 2 A4 pages in the chosen order; the sideways phone photo is upright, the wide one landscape")
        browser.close()
    real = [e for e in errors if "favicon" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("Images UI test passed.")

if __name__ == "__main__":
    main()
