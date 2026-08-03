#!/usr/bin/env python
"""
portrait-cutout — audit / repair transparency on a delivered portrait asset set.

Subcommands:
  audit <dir>              which files lack TRUE transparency, and why
  cut   <dir> [--src DIR]  produce RGBA cutouts into an output folder
  qa    <dir> [--ref DIR]  measure edge quality vs a reference set

Deps: pillow, numpy, scipy, rembg, onnxruntime.
Models cache to ~/.u2net (birefnet-portrait ~973MB, isnet-general-use ~178MB).

Key law (learned the hard way on a delivered asset set): NEVER use rembg's
alpha_matting=True on these. See SKILL.md.
"""
import argparse, os, sys, time
import numpy as np
from PIL import Image

WEBP = dict(quality=82, method=6)


# ---------- metrics -------------------------------------------------------

def subpix_rough(a, y0=500, y1=900):
    """Mean |2nd derivative| of the sub-pixel left-edge path. THE quality gate.
    Measure sub-pixel: a hard alpha>128 threshold measures pixel quantisation,
    not smoothness, and will score a visibly jagged edge as fine."""
    A = a.astype(float); pos = []
    for y in range(y0, min(y1, A.shape[0])):
        r = A[y]; idx = np.where(r > 128)[0]
        if len(idx) == 0: pos.append(np.nan); continue
        i = idx.min()
        if i == 0: pos.append(0.0); continue
        lo, hi = r[i-1], r[i]
        pos.append(i - 1 + ((128.0 - lo) / (hi - lo) if hi != lo else 0.0))
    pos = np.array(pos, float); pos = pos[~np.isnan(pos)]
    return float(np.mean(np.abs(np.diff(pos, 2)))) if len(pos) > 50 else float("nan")


def edge_width(a, y0=500, y1=900):
    """Mean count of partial-alpha px crossing the boundary. Target ~2."""
    w = []
    for y in range(y0, min(y1, a.shape[0])):
        idx = np.where(a[y] > 250)[0]
        if len(idx) == 0: continue
        i = idx.min(); seg = a[y][max(0, i-15):i]
        w.append(int(((seg > 5) & (seg < 250)).sum()))
    return float(np.mean(w)) if w else float("nan")


def classify(path):
    """-> (verdict, detail). Distinguishes a real cutout from a fake one."""
    im = Image.open(path)
    if im.mode not in ("RGBA", "LA", "PA") and "transparency" not in im.info:
        rgb = np.array(im.convert("RGB"))
        c = tuple(int(v) for v in rgb[0, 0])
        # Use a corner PATCH, not one pixel: a single sample lands on a light
        # checker square as often as a dark one (one checkerboard-baked file
        # sampled 250,250,250 and was misfiled as flat white, which sends it
        # down the wrong repair path). A painted checkerboard has real variance.
        patch = rgb[0:64, 0:64].astype(float).mean(2)
        kind = "checkerboard-baked" if patch.std() > 2.0 else "flat background"
        return "NO_ALPHA", "%s, corner rgb%s std=%.1f" % (kind, c, patch.std())
    a = np.array(im.convert("RGBA"))[:, :, 3]
    if a.min() == 255:
        return "OPAQUE_ALPHA", "alpha channel present but fully opaque"
    return "OK", "%.1f%% transparent" % (100 * (a == 0).mean())


# ---------- pipeline ------------------------------------------------------

def decontaminate(rgb, alpha, sigma=3.0):
    """Push interior colour outward into the rim so background bleed does not
    show as a halo when composited onto a dark panel."""
    from scipy.ndimage import gaussian_filter
    w = (alpha > 0.98).astype(np.float32)
    num = np.stack([gaussian_filter(rgb[:, :, c] * w, sigma) for c in range(3)], -1)
    den = gaussian_filter(w, sigma)[..., None] + 1e-6
    t = np.clip((0.98 - alpha) / 0.98, 0, 1)[..., None]
    return np.clip(rgb * (1 - t) + (num / den) * t, 0, 1)


def cut_one(im, session, gain, size, autocrop):
    from rembg import remove
    # alpha_matting=False is load-bearing -- see SKILL.md
    out = remove(im, session=session, alpha_matting=False).convert("RGBA")
    if autocrop:
        bb = out.getbbox()
        if bb: out = out.crop(bb)
    if size and out.size != size:
        out = out.resize(size, Image.LANCZOS)
    arr = np.array(out).astype(np.float32) / 255.0
    a = np.clip((arr[:, :, 3] - 0.5) * gain + 0.5, 0, 1)
    rgb = decontaminate(arr[:, :, :3], a)
    return Image.fromarray((np.dstack([rgb, a]) * 255).round().astype(np.uint8), "RGBA")


def iter_images(d):
    for dp, _, fns in os.walk(d):
        for fn in sorted(fns):
            if fn.lower().endswith((".webp", ".png", ".jpg", ".jpeg")):
                yield os.path.join(dp, fn)


# ---------- commands ------------------------------------------------------

def cmd_audit(args):
    rows = [(os.path.relpath(p, args.dir),) + classify(p) for p in iter_images(args.dir)]
    bad = [r for r in rows if r[1] != "OK"]
    for rel, verdict, detail in sorted(rows, key=lambda r: (r[1] == "OK", r[0])):
        print("%-14s %-62s %s" % (verdict, rel[:62], detail))
    print("\n%d/%d lack true transparency" % (len(bad), len(rows)))
    return 1 if bad else 0


def cmd_cut(args):
    from rembg import new_session
    src_index = {}
    if args.src:
        for p in iter_images(args.src):
            src_index.setdefault(os.path.splitext(os.path.basename(p))[0].lower(), []).append(p)

    targets = [p for p in iter_images(args.dir)
               if args.all or classify(p)[1] != "OK"]
    if args.only:
        targets = [t for t in targets if any(o.lower() in t.lower() for o in args.only)]

    os.makedirs(args.out, exist_ok=True)
    todo = []
    for t in targets:
        o = os.path.join(args.out, os.path.relpath(t, args.dir))
        if not args.force and os.path.exists(o):
            try:
                im = Image.open(o); im.load()
                if im.mode == "RGBA": continue          # resume
            except Exception: pass
        todo.append(t)
    print("model=%s gain=%.2f todo=%d (skipped %d done)"
          % (args.model, args.gain, len(todo), len(targets) - len(todo)), flush=True)

    session = new_session(args.model)
    size = tuple(int(v) for v in args.size.split("x")) if args.size else None
    for i, t in enumerate(todo, 1):
        rel = os.path.relpath(t, args.dir)
        stem = os.path.splitext(os.path.basename(t))[0].lower()
        # prefer the ORIGINAL delivered file over an already-compressed export
        src = src_index.get(stem, [t])[0]
        t0 = time.time()
        img = cut_one(Image.open(src).convert("RGB"), session, args.gain, size, args.autocrop)
        outp = os.path.join(args.out, rel)
        os.makedirs(os.path.dirname(outp), exist_ok=True)
        img.save(outp, "WEBP", **WEBP)
        a = np.array(img)[:, :, 3]
        print("%3d/%d %-48s rough=%.3f width=%.2f transp=%.1f%% %4.0fKB %.0fs"
              % (i, len(todo), rel[:48], subpix_rough(a), edge_width(a),
                 100 * (a == 0).mean(), os.path.getsize(outp) / 1024, time.time() - t0), flush=True)
    print("DONE ->", args.out)
    return 0


def cmd_qa(args):
    def stats(d):
        R, W = [], []
        for p in iter_images(d):
            im = Image.open(p)
            if im.mode != "RGBA": continue
            a = np.array(im.convert("RGBA"))[:, :, 3]
            r, w = subpix_rough(a), edge_width(a)
            if not np.isnan(r): R.append((r, os.path.relpath(p, d)))
            if not np.isnan(w): W.append(w)
        return R, W
    R, W = stats(args.dir)
    if not R:
        print("no RGBA images found"); return 1
    R.sort()
    med = R[len(R)//2][0]
    print("%-10s n=%-4d roughness med %.3f max %.3f | width med %.2f max %.2f"
          % ("TARGET", len(R), med, R[-1][0], sorted(W)[len(W)//2], max(W)))
    ceiling = None
    if args.ref:
        Rr, Wr = stats(args.ref)
        if Rr:
            Rr.sort()
            # Gate on the ref MEDIAN, not its max: the ref folder usually still
            # contains the very files being replaced, so its max is whatever we
            # are trying to beat and gates nothing.
            ceiling = Rr[len(Rr)//2][0]
            print("%-10s n=%-4d roughness med %.3f max %.3f | width med %.2f max %.2f"
                  % ("REF", len(Rr), ceiling, Rr[-1][0],
                     sorted(Wr)[len(Wr)//2], max(Wr)))
    print("\nworst 5:")
    for r, rel in R[-5:]: print("   %.3f  %s" % (r, rel))
    if ceiling is not None:
        over = [x for x in R if x[0] > ceiling]
        print("\n%d file(s) above reference MEDIAN roughness (%.3f)" % (len(over), ceiling))
        for r, rel in over[-5:]: print("   %.3f  %s" % (r, rel))
        return 1 if over else 0
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("audit"); a.add_argument("dir"); a.set_defaults(fn=cmd_audit)

    c = sub.add_parser("cut")
    c.add_argument("dir")
    c.add_argument("--src", help="folder of ORIGINAL delivered files (higher quality than exports)")
    c.add_argument("--out", required=True, help="output folder -- never write in place")
    c.add_argument("--model", default="birefnet-portrait")
    c.add_argument("--gain", type=float, default=1.15, help="alpha contrast; ~2px edge")
    c.add_argument("--size", default="1080x1080", help="WxH, or '' to keep native")
    c.add_argument("--autocrop", action="store_true", help="crop to alpha bbox (scraped sources)")
    c.add_argument("--all", action="store_true", help="process every file, not just broken ones")
    c.add_argument("--force", action="store_true", help="redo files already in --out")
    c.add_argument("--only", nargs="*", help="substring filter")
    c.set_defaults(fn=cmd_cut)

    q = sub.add_parser("qa")
    q.add_argument("dir"); q.add_argument("--ref", help="known-good set to compare against")
    q.set_defaults(fn=cmd_qa)

    args = ap.parse_args()
    sys.exit(args.fn(args))


if __name__ == "__main__":
    main()
