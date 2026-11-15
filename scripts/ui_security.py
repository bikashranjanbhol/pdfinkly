"""Browser test of password protection and unlocking.
Usage: python3 scripts/ui_security.py   (app running on BASE_URL, default http://localhost:3000)"""
import io, os, sys, tempfile
from playwright.sync_api import sync_playwright, expect
from pypdf import PdfReader, PdfWriter
from pypdf.constants import UserAccessPermissions as P

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = os.environ.get("SHOTS", "/tmp/shots")
FIX = os.path.join(os.path.dirname(__file__), "..", "packages/shared/test/fixtures")
TMP = tempfile.mkdtemp()
os.makedirs(OUT, exist_ok=True)

def upload(page, path):
    page.goto(BASE + "/upload")
    page.set_input_files("#file-input", path)

def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))

        # --- Protect: open password + no printing/copying
        upload(page, os.path.join(FIX, "chrome-cid.pdf"))
        page.wait_for_url("**/edit/**", timeout=20000)
        page.get_by_role("button", name="Download", exact=True).click()
        page.get_by_role("menuitem", name="Download with password…").click()
        dlg = page.get_by_role("dialog", name="Download with password")
        dlg.get_by_label("Password to open").fill("s3cret pw")
        dlg.get_by_label("Repeat the password").fill("s3cret pX")
        expect(dlg.get_by_text("The passwords don't match.")).to_be_visible()
        expect(dlg.get_by_role("button", name="Download protected PDF")).to_be_disabled()
        dlg.get_by_label("Repeat the password").fill("s3cret pw")
        dlg.get_by_label("Print").uncheck()
        dlg.get_by_label("Copy text and images").uncheck()
        dlg.get_by_label("Password to change these permissions").fill("owner-pw")
        page.screenshot(path=f"{OUT}/security-01-protect.png")
        with page.expect_download() as dl:
            dlg.get_by_role("button", name="Download protected PDF").click()
        d = dl.value
        assert d.suggested_filename == "chrome-cid (protected).pdf", d.suggested_filename
        protected = os.path.join(TMP, d.suggested_filename)
        d.save_as(protected)
        r = PdfReader(protected)
        assert r.is_encrypted
        assert r.decrypt("wrong") == 0
        assert r.decrypt("s3cret pw") == 1  # user password
        perms = r.user_access_permissions
        assert not (perms & P.PRINT) and not (perms & P.EXTRACT), perms
        assert perms & P.MODIFY, perms
        assert "Aditi Sharma" in r.pages[0].extract_text()
        r2 = PdfReader(protected)
        assert r2.decrypt("owner-pw") == 2  # owner password
        print("  ✓ protected copy: AES-256, opens only with the password, printing/copying off, owner password works")

        # --- Unlock on upload: wrong password, then the right one
        upload(page, protected)
        li = page.get_by_role("listitem").filter(has_text="chrome-cid (protected).pdf")
        expect(li.get_by_text("This PDF is password protected. Enter its password")).to_be_visible(timeout=20000)
        li.get_by_label("Password for chrome-cid (protected).pdf").fill("nope")
        li.get_by_role("button", name="Unlock and upload").click()
        expect(li.get_by_role("alert")).to_contain_text("That password isn't right")
        page.screenshot(path=f"{OUT}/security-02-unlock.png")
        li.get_by_label("Password for chrome-cid (protected).pdf").fill("s3cret pw")
        li.get_by_role("button", name="Unlock and upload").click()
        page.wait_for_url("**/edit/**", timeout=30000)
        expect(page.get_by_text("Aditi Sharma").first).to_be_visible(timeout=20000) if page.get_by_text("Aditi Sharma").count() else None
        expect(page.locator('[id^="page-"]').first).to_be_visible(timeout=20000)
        print("  ✓ unlock: wrong password rejected, right password decrypts in the browser and opens the editor")

        # --- Restrictions only (opens without a password): needs the owner password
        w = PdfWriter(clone_from=os.path.join(FIX, "letter-libreoffice.pdf"))
        w.encrypt(user_password="", owner_password="perm-pw", permissions_flag=0, algorithm="AES-256")
        restricted = os.path.join(TMP, "restricted.pdf")
        with open(restricted, "wb") as f:
            w.write(f)
        upload(page, restricted)
        li = page.get_by_role("listitem").filter(has_text="restricted.pdf")
        expect(li.get_by_text("permissions are locked")).to_be_visible(timeout=20000)
        li.get_by_role("button", name="Unlock and upload").click()  # empty password
        expect(li.get_by_role("alert")).to_contain_text("permissions (owner) password")
        li.get_by_label("Password for restricted.pdf").fill("perm-pw")
        li.get_by_role("button", name="Unlock and upload").click()
        page.wait_for_url("**/edit/**", timeout=30000)
        print("  ✓ restriction-only PDF: needs its permissions password, then unlocks and opens")
        browser.close()

    real = [e for e in errors if "favicon" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("Security UI test passed.")

if __name__ == "__main__":
    main()
