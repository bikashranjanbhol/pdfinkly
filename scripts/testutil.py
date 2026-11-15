"""Helpers shared by the browser tests: direct database access for setting up plans and accounts."""
import os, secrets, subprocess, uuid

def _db_url():
    url = os.environ.get("DATABASE_URL")
    if not url:
        env = os.path.join(os.path.dirname(__file__), "..", "apps/web/.env.local")
        for line in open(env):
            if line.startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"')
    return url

def sql(query):
    """Run SQL with psql; returns the rows as lists of strings."""
    out = subprocess.run(["psql", _db_url(), "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", query],
                         check=True, capture_output=True, text=True).stdout
    return [r.split("\t") for r in out.splitlines() if r]

def guest_id(ctx):
    for c in ctx.cookies():
        if c["name"] == "pdfinkly_guest":
            return c["value"].split(".")[0]
    raise AssertionError("no guest cookie yet")

def make_pro(ctx, hours=2):
    """Give the browser's current visitor (guest) Pro for a while, as a paid day pass would."""
    uid = guest_id(ctx)
    sql(f"UPDATE users SET plan_id = 'pro', plan_expires_at = now() + interval '{int(hours)} hours' WHERE id = '{uid}'")
    return uid

def sign_in(ctx, base, email=None, name="Test Buyer"):
    """Create an account with a database session and put its cookie in the browser context."""
    email = email or f"buyer-{secrets.token_hex(4)}@example.test"
    uid = str(uuid.uuid4())
    token = secrets.token_hex(32)
    sql(f"INSERT INTO users (id, email, name, email_verified) VALUES ('{uid}', '{email}', '{name}', now())")
    sql(f"INSERT INTO sessions (session_token, user_id, expires_at) VALUES ('{token}', '{uid}', now() + interval '1 day')")
    host = base.split("://", 1)[1].split("/")[0].split(":")[0]
    ctx.add_cookies([{"name": "authjs.session-token", "value": token, "domain": host, "path": "/", "httpOnly": True}])
    return uid, email
