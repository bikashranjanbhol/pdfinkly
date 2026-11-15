"""Browser test of "Use your phone": a computer shows a QR code, a phone scans pages and sends them.
Usage: python3 scripts/ui_scan_phone.py (app running at BASE_URL, default http://localhost:3000)"""
import hashlib, os, re, sys, tempfile, subprocess
import cv2
from testutil import sql
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = os.environ.get("SHOTS", "/tmp/shots")
PHOTOS = os.path.join(os.path.dirname(__file__), "..", "packages/shared/test/fixtures/photos")
STORE = os.path.join(os.path.dirname(__file__), "..", "apps/web/.dev-storage")
os.makedirs(OUT, exist_ok=True)
photo = lambda n: os.path.join(PHOTOS, n)

def wait_ready(page, count):
    expect(page.get_by_role("region", name="Pages").get_by_role("listitem").filter(has=page.get_by_role("img"))).to_have_count(count, timeout=60000)
    expect(page.get_by_role("status").filter(has_text="Finding the page")).to_have_count(0, timeout=60000)
    expect(page.get_by_role("status").filter(has_text="Cleaning up")).to_have_count(0, timeout=60000)

def corners(page, n):
    return page.get_by_alt_text(f"Scanned page {n}").evaluate("""i => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
        const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data;
        const at = (u, v) => { const k = (Math.floor(v * c.height) * c.width + Math.floor(u * c.width)) * 4; return Math.round((d[k] + d[k+1] + d[k+2]) / 3); };
        return { ratio: c.height / c.width, px: [at(.03,.03), at(.97,.03), at(.97,.97), at(.03,.97)] }; }""")

def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        desk_ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        desk = desk_ctx.new_page()
        desk.on("pageerror", lambda e: errors.append(f"desk: {e}"))
        desk.on("console", lambda m: m.type == "error" and "404" not in m.text and errors.append(f"desk: {m.text}"))
        desk.goto(BASE + "/scan")
        desk.get_by_role("button", name="Use your phone").click()
        qr = desk.get_by_role("img", name="QR code for scanning with your phone")
        expect(qr).to_be_visible(timeout=15000)
        expect(desk.get_by_role("status").filter(has_text="Waiting for your phone")).to_be_visible()
        url = desk.locator("#phone-h").locator("xpath=ancestor::section").locator("code").inner_text()
        assert url.startswith(BASE + "/scan/phone/"), url
        # The QR code really holds that link.
        shot = os.path.join(OUT, "phone-01-qr.png")
        qr.screenshot(path=shot)
        img = cv2.imread(shot)
        img = cv2.copyMakeBorder(img, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=(255, 255, 255))
        decoded, *_ = cv2.QRCodeDetector().detectAndDecode(img)
        assert decoded == url, (decoded, url)
        desk.screenshot(path=os.path.join(OUT, "phone-02-desktop-waiting.png"))
        print("  ✓ computer shows a QR code holding the one-time link")

        # A phone opens the link (no cookies, no sign-in).
        phone_ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ph = phone_ctx.new_page()
        ph.on("pageerror", lambda e: errors.append(f"phone: {e}"))
        ph.goto(url)
        expect(ph.get_by_role("heading", name="Scan for your computer")).to_be_visible()
        expect(ph.get_by_role("button", name="Use your phone")).to_have_count(0)
        expect(desk.get_by_role("status").filter(has_text="Phone connected")).to_be_visible(timeout=10000)
        assert not phone_ctx.cookies(), phone_ctx.cookies()  # the phone gets no account or guest cookie
        print("  ✓ phone opens the link without signing in; computer shows it's connected")

        ph.set_input_files("#scan-camera", photo("desk-angle.jpg"))
        wait_ready(ph, 1)
        ph.set_input_files("#scan-photos", photo("light-desk.jpg"))
        wait_ready(ph, 2)
        expect(ph.get_by_role("radiogroup")).to_have_count(0)  # the computer chooses the look
        c = corners(ph, 1)
        assert min(c["px"]) > 235, c  # the phone previews the cleaned-up look
        ph.screenshot(path=os.path.join(OUT, "phone-03-phone-pages.png"), full_page=True)
        ph.get_by_role("button", name="Send to computer (2 pages)").click()
        expect(ph.get_by_role("status").filter(has_text="Sent 2 pages")).to_be_visible(timeout=30000)
        expect(ph.get_by_alt_text("Scanned page 1")).to_have_count(0)
        print("  ✓ phone scans two pages and sends them")

        # They arrive on the computer, get the computer's look, and are deleted from the server.
        wait_ready(desk, 2)
        expect(desk.get_by_role("status").filter(has_text="2 pages received")).to_be_visible(timeout=10000)
        expect(desk.get_by_text("From phone")).to_have_count(2)
        for n in (1, 2):
            c = corners(desk, n)
            assert abs(c["ratio"] - 1.414) < 0.02 and min(c["px"]) > 235, (n, c)
        hid = url.rsplit("/", 1)[1]
        rows = sql(f"SELECT count(*) FROM scan_handoff_pages p JOIN scan_handoffs h ON h.id = p.handoff_id WHERE h.token_hash = '{hashlib.sha256(hid.encode()).hexdigest()}'")
        assert rows[0][0] == "0", rows
        left = [f for _, _, fs in os.walk(os.path.join(STORE, "scan-handoffs")) for f in fs] if os.path.isdir(os.path.join(STORE, "scan-handoffs")) else []
        assert not left, left
        desk.screenshot(path=os.path.join(OUT, "phone-04-desktop-received.png"), full_page=True)
        print("  ✓ computer receives both pages (A4, cleaned up); server copies deleted")

        # Finish on the computer as usual.
        desk.get_by_role("radio", name="Black & white").click()
        wait_ready(desk, 2)
        with desk.expect_download(timeout=60000) as dl:
            desk.get_by_role("button", name="Download PDF").click()
        path = os.path.join(tempfile.mkdtemp(), "scan.pdf")
        dl.value.save_as(path)
        info = subprocess.run(["pdfinfo", path], capture_output=True, text=True).stdout
        assert re.search(r"^Pages:\s+2$", info, re.M), info
        print("  ✓ computer applies its look and makes the PDF")

        # The phone link can't read anything back.
        r = ph.request.get(BASE + "/api/scan/handoff/00000000-0000-0000-0000-000000000000")
        assert r.status in (401, 404), r.status
        # Anything that isn't a JPEG is refused.
        start = ph.request.post(f"{BASE}/api/scan/phone/{hid}/pages", data={"width": 100, "height": 100, "sizeBytes": 200})
        assert start.ok, start.text()
        t = start.json()
        ph.request.put(t["upload"]["url"], data=b"%PDF-1.7" + b"x" * 192, headers=t["upload"]["headers"])
        bad = ph.request.post(f"{BASE}/api/scan/phone/{hid}/pages/{t['pageId']}/complete")
        assert bad.status == 400, bad.status
        print("  ✓ the phone link can only add JPEG pages")

        # Stop on the computer: the link stops working.
        desk.get_by_role("button", name="Stop using your phone").click()
        expect(desk.get_by_role("heading", name="Scan with your phone")).to_have_count(0)
        ph.set_input_files("#scan-camera", photo("bed-tilted.jpg"))  # a striped bedsheet: found without help
        wait_ready(ph, 1)
        ph.get_by_role("button", name="Send to computer (1 page)").click()
        expect(ph.get_by_role("alert").filter(has_text="This link has expired or was closed")).to_be_visible(timeout=15000)
        th = hashlib.sha256(hid.encode()).hexdigest()
        assert sql(f"SELECT count(*) FROM scan_handoffs WHERE token_hash = '{th}'")[0][0] == "0"
        ph2 = phone_ctx.new_page()
        ph2.goto(url)
        expect(ph2.get_by_role("heading", name="This link has expired")).to_be_visible()
        ph2.screenshot(path=os.path.join(OUT, "phone-05-expired.png"))
        print("  ✓ stopping closes the link; the phone is told; old links show 'expired'")
        browser.close()

    real = [e for e in errors if "favicon" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("Phone scan UI test passed.")

if __name__ == "__main__":
    main()
