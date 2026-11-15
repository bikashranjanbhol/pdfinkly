"""Browser test of billing: Free limits, the day pass, Pro monthly, cancelling, and webhooks.
Needs the mock Razorpay (scripts/mock-razorpay.mjs) and the app started with
  RAZORPAY_KEY_ID=rzp_test_mock RAZORPAY_KEY_SECRET=mocksecret RAZORPAY_WEBHOOK_SECRET=whsecret
  RAZORPAY_API_BASE=http://127.0.0.1:4010/v1
Usage: python3 scripts/ui_billing.py"""
import hashlib, hmac, json, os, sys, time, urllib.error, urllib.request, uuid
from testutil import sign_in, sql
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
MOCK = os.environ.get("MOCK_RAZORPAY", "http://127.0.0.1:4010")
WEBHOOK_SECRET = os.environ.get("RAZORPAY_WEBHOOK_SECRET", "whsecret")
OUT = os.environ.get("SHOTS", "/tmp/shots")
FIX = os.path.join(os.path.dirname(__file__), "..", "packages/shared/test/fixtures")
os.makedirs(OUT, exist_ok=True)

def use_mock_checkout(ctx):
    ctx.route("https://checkout.razorpay.com/v1/checkout.js", lambda r: r.fulfill(
        status=200, content_type="application/javascript", body=urllib.request.urlopen(MOCK + "/checkout.js").read()))

RUN = uuid.uuid4().hex[:8]  # event ids are remembered across runs

def webhook(event, payload, event_id, secret=WEBHOOK_SECRET):
    event_id = f"{event_id}-{RUN}"
    body = json.dumps({"entity": "event", "event": event, "payload": payload}).encode()
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    req = urllib.request.Request(BASE + "/api/billing/webhook", data=body, method="POST", headers={
        "content-type": "application/json", "x-razorpay-signature": sig, "x-razorpay-event-id": event_id})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def plan_of(uid):
    return sql(f"SELECT plan_id, plan_expires_at > now() FROM users WHERE id = '{uid}'")[0]

def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])

        # --- A guest is sent to sign in before paying
        g = browser.new_context(viewport={"width": 1440, "height": 900})
        page = g.new_page()
        page.goto(BASE + "/pricing")
        expect(page.get_by_role("heading", name="Simple plans for every PDF")).to_be_visible()
        expect(page.get_by_text("₹199", exact=True)).to_be_visible()
        expect(page.get_by_text("₹49", exact=True)).to_be_visible()
        expect(page.get_by_text("or ₹1,499 a year (save 37%)")).to_be_visible()
        page.screenshot(path=f"{OUT}/billing-01-pricing.png", full_page=True)
        href = page.get_by_role("link", name="Buy a day pass").get_attribute("href")
        assert href == "/signin?next=%2Fpricing%3Fbuy%3Dpro_day_inr", href
        page.get_by_role("link", name="Show in dollars").click()
        expect(page.get_by_text("$7", exact=True)).to_be_visible()
        expect(page.get_by_text("or $59 a year (save 30%)")).to_be_visible()
        print("  ✓ pricing in rupees and dollars; guests are sent to sign in first")
        page.goto(BASE + "/signin?next=%2Fpricing%3Fbuy%3Dpro_day_inr")
        expect(page.get_by_text("Pro is tied to your account, so sign in first.")).to_be_visible()
        g.close()

        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        use_mock_checkout(ctx)
        uid, _ = sign_in(ctx, BASE)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))

        # --- Free: Pro tools show an upgrade prompt
        page.goto(BASE + "/upload")
        page.set_input_files("#file-input", os.path.join(FIX, "chrome-cid.pdf"))
        page.wait_for_url("**/edit/**", timeout=20000)
        edit_url = page.url
        tools = page.get_by_role("toolbar", name="Editing tools")
        expect(tools.get_by_role("button", name="Redact")).to_contain_text("PRO", timeout=10000)
        tools.get_by_role("button", name="Redact").click()
        up = page.get_by_role("dialog", name="Redaction is part of Pro")
        expect(up).to_be_visible()
        expect(tools.get_by_role("button", name="Redact")).to_have_attribute("aria-pressed", "false")
        page.screenshot(path=f"{OUT}/billing-02-upgrade.png")
        up.get_by_role("button", name="Not now").click()
        page.get_by_role("button", name="Download", exact=True).click()
        page.get_by_role("menuitem", name="Download with password…").click()
        expect(page.get_by_role("dialog", name="Password protection is part of Pro")).to_be_visible()
        page.keyboard.press("Escape")
        page.get_by_role("button", name="Stamps").click()
        st = page.get_by_role("dialog", name="Page stamps")
        st.get_by_role("tab", name="Bates numbering").click()
        expect(st.get_by_text("Bates numbering is part of Pro.")).to_be_visible()
        expect(st.get_by_role("button", name="Add Bates numbers")).to_be_disabled()
        st.get_by_role("button", name="Close").click()
        print("  ✓ Free: redaction, password protection and Bates numbering ask for Pro")

        # --- Free: the monthly allowance of conversions and compressions
        sql(f"INSERT INTO usage_events (user_id, kind, tool) SELECT '{uid}', 'job', 'convert' FROM generate_series(1, 9)")
        page.get_by_role("button", name="Download", exact=True).click()
        page.get_by_role("menuitem", name="Compress…").click()
        dlg = page.get_by_role("dialog", name="Compress PDF")
        expect(dlg.get_by_text("1 of 10 free conversions and compressions left this month.")).to_be_visible(timeout=10000)
        dlg.get_by_role("button", name="Compress", exact=True).click()
        expect(dlg.get_by_role("status").filter(has_text="smaller")).to_be_visible(timeout=60000)
        dlg.get_by_role("button", name="Close").click()
        page.get_by_role("button", name="Download", exact=True).click()
        page.get_by_role("menuitem", name="Convert to Word, Excel…").click()
        cv = page.get_by_role("dialog", name="Convert PDF")
        expect(cv.get_by_text("0 of 10 free conversions and compressions left this month.")).to_be_visible(timeout=10000)
        cv.get_by_role("button", name="Convert to Word").click()
        expect(cv.get_by_role("alert")).to_contain_text("You've used all 10 free conversions and compressions this month.")
        expect(cv.get_by_role("button", name="Convert to Word")).to_be_disabled()
        page.screenshot(path=f"{OUT}/billing-03-quota.png")
        cv.get_by_role("button", name="Cancel").click()
        assert sql(f"SELECT count(*) FROM usage_events WHERE user_id = '{uid}'")[0][0] == "10"
        print("  ✓ Free: 10 conversions/compressions a month, then an upgrade prompt")

        # --- Day pass
        page.goto(BASE + "/pricing")
        page.get_by_role("button", name="Buy a day pass").click()
        page.wait_for_url("**/account?welcome=1", timeout=20000)
        expect(page.get_by_role("status").filter(has_text="Thank you! Pro is on until")).to_be_visible()
        expect(page.get_by_text("Day pass · Pro until")).to_be_visible()
        expect(page.get_by_text("Pro plan", exact=True).first).to_be_visible()
        expect(page.get_by_role("cell", name="₹49")).to_be_visible()
        page.screenshot(path=f"{OUT}/billing-04-daypass.png", full_page=True)
        assert plan_of(uid) == ["pro", "t"], plan_of(uid)
        hours = float(sql(f"SELECT extract(epoch FROM plan_expires_at - now()) / 3600 FROM users WHERE id = '{uid}'")[0][0])
        assert 23.9 < hours <= 24, hours
        print("  ✓ day pass: paid, Pro for 24 hours, payment listed")

        # A second pass adds 24 hours after the first
        page.goto(BASE + "/pricing")
        page.get_by_role("button", name="Buy a day pass").click()
        page.wait_for_url("**/account?welcome=1", timeout=20000)
        hours = float(sql(f"SELECT extract(epoch FROM plan_expires_at - now()) / 3600 FROM users WHERE id = '{uid}'")[0][0])
        assert 47.9 < hours <= 48, hours
        print("  ✓ a second day pass stacks (48 hours)")

        # --- Pro tools now work
        page.goto(edit_url)
        tools = page.get_by_role("toolbar", name="Editing tools")
        expect(page.get_by_role("group", name="Page 1")).to_be_visible(timeout=20000)
        tools.get_by_role("button", name="Redact").click()
        expect(tools.get_by_role("button", name="Redact")).to_have_attribute("aria-pressed", "true")
        expect(tools.get_by_role("button", name="Redact")).not_to_contain_text("PRO")
        page.get_by_role("button", name="Download", exact=True).click()
        page.get_by_role("menuitem", name="Convert to Word, Excel…").click()
        cv = page.get_by_role("dialog", name="Convert PDF")
        expect(cv.get_by_text("free conversions")).to_have_count(0)
        with page.expect_download() as dl:
            cv.get_by_role("button", name="Convert to Word").click()
        assert dl.value.suggested_filename.endswith(".docx")
        cv.get_by_label("Close").click()
        print("  ✓ with Pro: redaction opens and conversions are unlimited")

        # --- Pro monthly subscription
        page.goto(BASE + "/pricing")
        page.get_by_role("button", name="Get Pro monthly").click()
        page.wait_for_url("**/account?welcome=1", timeout=20000)
        expect(page.get_by_text("Pro monthly · ₹199 · renews on")).to_be_visible()
        sub = sql(f"SELECT provider_subscription_id, status, current_period_end > now() + interval '29 days' FROM subscriptions WHERE user_id = '{uid}' AND kind = 'recurring'")
        assert len(sub) == 1 and sub[0][1:] == ["active", "t"], sub
        sub_id = sub[0][0]
        calls = json.loads(urllib.request.urlopen(MOCK + "/__calls").read())
        plan_calls = [c for c in calls if c["path"] == "/v1/plans"]
        assert plan_calls and plan_calls[-1]["body"]["item"] == {"name": "PDFInkly Pro (monthly)", "amount": 19900, "currency": "INR"}, plan_calls
        assert sql("SELECT razorpay_plan_ids ? 'test' FROM prices WHERE id = 'pro_month_inr'")[0][0] == "t"
        page.goto(BASE + "/pricing")
        expect(page.get_by_role("button", name="You're subscribed").first).to_be_disabled()
        print("  ✓ Pro monthly: Razorpay plan made once, subscription active, renew date shown")

        # Starting a second subscription is refused by the API too
        r = page.request.post(BASE + "/api/billing/checkout", data={"priceId": "pro_year_inr"})
        assert r.status == 409, r.status

        # A forged confirmation is refused
        r = page.request.post(BASE + "/api/billing/verify", data={"kind": "subscription", "id": sub_id, "paymentId": "pay_fake", "signature": "0" * 64})
        assert r.status == 400, r.status
        print("  ✓ a second subscription and a forged payment are refused")

        # --- Webhooks: renewal, duplicates, bad signatures
        end = int(time.time()) + 60 * 86400
        payload = {"subscription": {"entity": {"id": sub_id, "status": "active", "current_start": int(time.time()), "current_end": end}},
                   "payment": {"entity": {"id": f"pay_renewal_{RUN}", "amount": 19900, "currency": "INR", "status": "captured", "invoice_id": "inv_1", "created_at": int(time.time())}}}
        status, res = webhook("subscription.charged", payload, "evt_renew_1")
        assert status == 200 and res == {"ok": True}, (status, res)
        status, res = webhook("subscription.charged", payload, "evt_renew_1")
        assert res.get("duplicate") is True, res
        status, _ = webhook("subscription.charged", payload, "evt_renew_2", secret="wrong")
        assert status == 400, status
        assert sql(f"SELECT count(*) FROM payments WHERE provider_payment_id = 'pay_renewal_{RUN}'")[0][0] == "1"
        days = float(sql(f"SELECT extract(epoch FROM plan_expires_at - now()) / 86400 FROM users WHERE id = '{uid}'")[0][0])
        assert 62.9 < days < 63.1, days  # 60 days paid + 3 days' grace
        print("  ✓ webhooks: a renewal extends Pro; duplicates and bad signatures are ignored")

        # Day pass whose browser closed before confirming: the webhook switches it on
        o = page.request.post(BASE + "/api/billing/checkout", data={"priceId": "pro_day_inr"}).json()
        status, _ = webhook("payment.captured", {"payment": {"entity": {"id": f"pay_bg_{RUN}", "amount": 4900, "currency": "INR", "status": "captured", "order_id": o["id"], "created_at": int(time.time())}}}, "evt_pass_1")
        assert status == 200
        assert sql(f"SELECT status FROM subscriptions WHERE provider_subscription_id = '{o['id']}'")[0][0] == "active"
        print("  ✓ a day pass paid with the tab closed is switched on by the webhook")

        # --- Cancel
        page.goto(BASE + "/account")
        page.get_by_role("button", name="Cancel subscription").click()
        expect(page.get_by_text("Your subscription won't renew.")).to_be_visible()
        page.get_by_role("button", name="Yes, cancel").click()
        expect(page.get_by_text("Pro monthly · cancelled, Pro until")).to_be_visible(timeout=10000)
        page.screenshot(path=f"{OUT}/billing-05-cancelled.png", full_page=True)
        assert sql(f"SELECT cancel_at_period_end FROM subscriptions WHERE provider_subscription_id = '{sub_id}'")[0][0] == "t"
        calls = json.loads(urllib.request.urlopen(MOCK + "/__calls").read())
        assert any(c["path"] == f"/v1/subscriptions/{sub_id}/cancel" and c["body"] == {"cancel_at_cycle_end": 1} for c in calls)
        assert plan_of(uid) == ["pro", "t"]
        print("  ✓ cancel: stops renewal at Razorpay, Pro kept until the period ends")

        # --- When everything has run out, the account is back on Free
        sql(f"UPDATE users SET plan_expires_at = now() - interval '1 minute' WHERE id = '{uid}'")
        page.goto(BASE + "/account")
        expect(page.get_by_role("heading", name="Free plan")).to_be_visible()
        print("  ✓ an expired plan reads as Free without any background job")
        browser.close()

    real = [e for e in errors if "favicon" not in e and "402" not in e and "409" not in e and "400" not in e]
    if real:
        print("Browser errors:", *real, sep="\n  ")
        sys.exit(1)
    print("Billing UI test passed.")

if __name__ == "__main__":
    main()
