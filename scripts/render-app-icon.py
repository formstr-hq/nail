#!/usr/bin/env python3
"""Render the Mail by Form* adaptive icon to PNG at every launcher density.

Why this exists:
  Adaptive-icon XML renders the foreground vector on API 26+, but many
  launchers (and any pre-API-26 device) fall back to the raster PNGs in
  `mipmap-*/`. We want those PNGs to show the same mark — a white envelope
  with a bold red wax seal on solid black — not the default Capacitor clipart.
  Drawing once with PIL is simpler and more reliable than round-tripping
  through an SVG tool.

Output:
  mobile/android/app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/
    ic_launcher.png            108×108 base, scaled per density
    ic_launcher_round.png      same
  client/public/favicon-512.png (square, for the web manifest, 512×512)

Run: python3 scripts/render-app-icon.py
"""

from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
RES = REPO / "mobile" / "android" / "app" / "src" / "main" / "res"

# Adaptive icon geometry: the launcher masks a 108×108 canvas into a circle,
# squircle, teardrop, etc. The safe zone (where art is guaranteed not to be
# clipped) is the central 66×66 — a 21-unit margin all around. We keep all
# geometry inside an inner ~24–84 band so the mark survives every mask.
INK = (11, 11, 12, 255)         # #0B0B0C — background "ink"
PAPER = (244, 244, 243, 255)    # #F4F4F3 — envelope body
SEAL = (229, 72, 77, 255)       # #E5484D — wax seal accent


def render(size: int) -> Image.Image:
    """Render the icon at `size`×`size` (square)."""
    img = Image.new("RGBA", (size, size), INK)
    draw = ImageDraw.Draw(img)

    # Scale every geometry from the canonical 108-unit viewport.
    s = size / 108

    # Envelope body — white rounded rectangle. Wider than the seal so the
    # seal sits *on* it, not beside it. Centered vertically inside the safe
    # zone (the central 66 of 108 — i.e. y=21..87), so the mark reads as
    # centered under every launcher mask, not pinned to the bottom.
    env_box = (22 * s, 30 * s, 86 * s, 78 * s)
    draw.rounded_rectangle(env_box, radius=6 * s, fill=PAPER)

    # Envelope flap — a black V drawn inside the envelope's top edge.
    # (Three lines: left top → bottom-center → right top.) Stroke is thick
    # enough to read at smallest launcher sizes.
    flap_w = 4 * s
    draw.line(
        [
            (22 * s, 36 * s),
            (54 * s, 64 * s),
            (86 * s, 36 * s),
        ],
        fill=INK,
        width=max(1, int(round(flap_w))),
        joint="curve",
    )

    # Wax seal — a single bold red circle, sitting on the bottom-right of
    # the envelope flap where it visually anchors the mark. Big enough to
    # be the focal point even on the smallest launcher sizes.
    seal_r = 10 * s
    seal_cx, seal_cy = 68 * s, 60 * s
    draw.ellipse(
        (
            seal_cx - seal_r,
            seal_cy - seal_r,
            seal_cx + seal_r,
            seal_cy + seal_r,
        ),
        fill=SEAL,
    )

    return img


# Android launcher icon densities. Sizes are per Android's "icon" spec:
# mdpi is the 48dp base, and the foreground bitmap inside the adaptive icon
# is the full 108dp canvas (so the foreground scales 108/48 ≈ 2.25× mdpi).
DENSITIES = {
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}


def main() -> None:
    for bucket, size in DENSITIES.items():
        out_dir = RES / f"mipmap-{bucket}"
        out_dir.mkdir(parents=True, exist_ok=True)
        icon = render(size)
        icon.save(out_dir / "ic_launcher.png")
        icon.save(out_dir / "ic_launcher_round.png")
        print(f"  {bucket:>7}  {size:>4}×{size:<4}  →  {out_dir.name}/")

    # Also drop a 512×512 square at client/public/favicon-512.png so the web
    # app's manifest icon and the landing share one source of truth.
    web = REPO / "client" / "public" / "favicon-512.png"
    web.parent.mkdir(parents=True, exist_ok=True)
    render(512).save(web)
    print(f"   web      512×512   →  {web.relative_to(REPO)}")


if __name__ == "__main__":
    main()
