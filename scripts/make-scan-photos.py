"""Make phone-photo-like pictures of printed pages for testing the scanner:
a page rendered from a PDF, lying at an angle on a surface, with uneven light,
a soft shadow, camera noise and JPEG compression.

Usage: python3 scripts/make-scan-photos.py <page.png> <out-dir> [--small]
Writes <name>.jpg and <name>.json (true corners, in photo pixels)."""
import json, math, os, random, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

def coeffs(dst, src):
    """PIL perspective coefficients mapping output (photo) points to input (page) points."""
    A, B = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    return np.linalg.solve(np.array(A, float), np.array(B, float)).tolist()

def surface(kind, W, H, rng):
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    if kind == "wood":
        g = 20 * np.sin(y * 0.03 + 3 * np.sin(x * 0.004)) + 8 * np.sin(y * 0.4)
        base = np.stack([150 + g, 102 + g * 0.7, 62 + g * 0.4], -1)
    elif kind == "granite":
        base = np.full((H, W, 3), 55, np.float32) + rng.normal(0, 14, (H, W, 1))
    elif kind == "lightdesk":
        base = np.stack([np.full((H, W), 196.0), np.full((H, W), 192.0), np.full((H, W), 186.0)], -1)
    elif kind == "bedsheet":
        stripes = ((x + y) // 40 % 2) * 25
        base = np.stack([200 - stripes, 170 - stripes, 205 - stripes * 0.5], -1)
    else:
        base = np.full((H, W, 3), 90, np.float32)
    return base + rng.normal(0, 4, (H, W, 3))

def camera_quad(W, H, pitch, yaw, roll, dist, shift=(0, 0), focal=1.0):
    """Where an A4 sheet's corners land in a photo from a pinhole camera (focal = × long side)
    tilted by pitch/yaw/roll degrees, `dist` mm away, centre shifted by `shift` mm."""
    f = focal * max(W, H)
    a, b, c = (math.radians(v) for v in (pitch, yaw, roll))
    Rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    Ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
    Rz = np.array([[math.cos(c), -math.sin(c), 0], [math.sin(c), math.cos(c), 0], [0, 0, 1]])
    R = Rz @ Ry @ Rx
    pts = []
    for x, y in [(-105, -148.5), (105, -148.5), (105, 148.5), (-105, 148.5)]:
        X = R @ np.array([x + shift[0], y + shift[1], 0.0]) + np.array([0, 0, dist])
        pts.append((W / 2 + f * X[0] / X[2], H / 2 + f * X[1] / X[2]))
    return pts

CASES = {
    "desk-angle":   dict(kind="wood",      cam=(-28, 6, 4, 420, (0, -10)),  shadow=True,  cast=(1.0, 0.95, 0.82)),
    "granite-flat": dict(kind="granite",   cam=(3, -2, -1, 380, (0, 0)),    shadow=False, cast=(1, 1, 1)),
    "bed-tilted":   dict(kind="bedsheet",  cam=(-15, 12, 22, 470, (10, 0)), shadow=True,  cast=(1, 0.97, 0.9)),
    "light-desk":   dict(kind="lightdesk", cam=(18, -8, -3, 400, (0, 5)),   shadow=True,  cast=(1, 1, 1)),
}

def make(page_path, out_dir, small=False):
    rng = np.random.default_rng(3)
    page = Image.open(page_path).convert("RGB")
    W, H = (900, 1200) if small else (1800, 2400)
    os.makedirs(out_dir, exist_ok=True)
    for name, c in CASES.items():
        bg = surface(c["kind"], W, H, rng)
        pitch, yaw, roll, d, shift = c["cam"]
        quad = camera_quad(W, H, pitch, yaw, roll, d, shift)
        pw, ph = page.size
        paper = np.asarray(page, np.float32) * np.array([0.97, 0.96, 0.93])
        warped = Image.fromarray(paper.clip(0, 255).astype(np.uint8)).transform(
            (W, H), Image.PERSPECTIVE, coeffs(quad, [(0, 0), (pw, 0), (pw, ph), (0, ph)]), Image.BICUBIC)
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).polygon(quad, fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(1.2))
        m = np.asarray(mask, np.float32)[..., None] / 255
        img = bg * (1 - m) + np.asarray(warped, np.float32) * m
        # Light: brighter towards the top right, and a soft shadow (a phone or a hand) from the bottom left.
        y, x = np.mgrid[0:H, 0:W].astype(np.float32)
        light = 0.78 + 0.28 * (x / W) * (1 - 0.35 * y / H)
        if c["shadow"]:
            sh = Image.new("L", (W, H), 0)
            ImageDraw.Draw(sh).ellipse([-0.3 * W, 0.55 * H, 0.5 * W, 1.4 * H], fill=255)
            light = light - 0.32 * np.asarray(sh.filter(ImageFilter.GaussianBlur(W * 0.06)), np.float32) / 255
        img = img * light[..., None] * np.array(c["cast"])
        img = img + rng.normal(0, 3.5, img.shape)
        out = Image.fromarray(img.clip(0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
        out.save(os.path.join(out_dir, f"{name}.jpg"), quality=85)
        json.dump({"width": W, "height": H, "quad": [{"x": a, "y": b} for a, b in quad]}, open(os.path.join(out_dir, f"{name}.json"), "w"))
        print(name)

if __name__ == "__main__":
    make(sys.argv[1], sys.argv[2], "--small" in sys.argv)
