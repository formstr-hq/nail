#!/usr/bin/env python3
"""Render the Mail by Form* app icon — one source of truth for every target.

Design:
  Solid black canvas, a red envelope (filled) with a white flap V centred
  with black margin, and a white Form*-style asterisk on the top-right corner
  like an unread-mail notification badge.

Why one script:
  Adaptive-icon XML renders the foreground vector on API 26+, but many
  launchers (and any pre-API-26 device) fall back to the raster PNGs in
  `mipmap-*/`. Authoring them separately makes them drift, so this script
  emits BOTH from the same geometry constants:
    - the raster PNGs (all five density buckets), and
    - the adaptive foreground vector drawable.

Outputs:
  mobile/.../res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png
                                                          ic_launcher_round.png
  mobile/.../res/drawable-v24/ic_launcher_foreground.xml
  client/public/favicon-512.png   (512×512, for the web manifest)

Run: python3 scripts/render-app-icon.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
RES = REPO / "mobile" / "android" / "app" / "src" / "main" / "res"

# --- palette ---------------------------------------------------------------
INK = "#0B0B0C"     # background — the brand's black "ink"
RED = "#E5484D"     # envelope body — the brand's red
PAPER = "#F4F4F3"   # flap + asterisk — near-white

# --- geometry (canonical 108-unit adaptive-icon viewport) ------------------
# The launcher masks a 108×108 canvas; the guaranteed-safe zone is the central
# 66 (x,y in 21..87). The envelope stays well inside it with black margin.
ENV_L, ENV_T, ENV_R, ENV_B = 32.0, 40.0, 76.0, 74.0   # envelope box
ENV_RADIUS = 6.0
FLAP_INSET_Y = 4.0        # flap V starts this far below the envelope top
FLAP_DEPTH = 15.0         # how far the flap V dips
FLAP_W = 3.6              # flap stroke width (108-unit)

# Asterisk badge — white Form*-style asterisk on the top-right corner. Six
# arms (three crossing strokes). A thin black halo separates it from the red
# envelope where they overlap.
AST_CX, AST_CY = 70.0, 38.0     # centre — top-right, overlapping the corner
AST_ARM = 22.0                  # tip-to-tip length of each stroke
AST_W = 5.0                     # stroke width
AST_HALO = 3.0                  # black halo added to width/length
AST_ANGLES = (90.0, 30.0, 150.0)  # vertical + two diagonals


def _round_line(draw, p0, p1, width, fill):
    """A round-capped line (PIL's native line caps are square)."""
    draw.line([p0, p1], fill=fill, width=max(1, round(width)))
    r = width / 2.0
    for (x, y) in (p0, p1):
        draw.ellipse((x - r, y - r, x + r, y + r), fill=fill)


def _asterisk(draw, s, width, extra_len, fill):
    """Draw the three-stroke asterisk, scaled by `s`."""
    half = (AST_ARM + extra_len) / 2.0
    for ang in AST_ANGLES:
        dx = half * math.cos(math.radians(ang))
        dy = half * math.sin(math.radians(ang))
        _round_line(
            draw,
            ((AST_CX - dx) * s, (AST_CY - dy) * s),
            ((AST_CX + dx) * s, (AST_CY + dy) * s),
            width * s, fill,
        )


def render(size: int) -> Image.Image:
    """Render the icon at `size`×`size` (square)."""
    img = Image.new("RGBA", (size, size), INK)
    draw = ImageDraw.Draw(img)
    s = size / 108.0

    def sc(box):
        return [c * s for c in box]

    # Envelope body — red rounded rectangle, centred with black margin.
    draw.rounded_rectangle(
        sc((ENV_L, ENV_T, ENV_R, ENV_B)), radius=ENV_RADIUS * s, fill=RED
    )

    # Envelope flap — a white V inside the top edge.
    fy = ENV_T + FLAP_INSET_Y
    draw.line(
        [
            (ENV_L * s, fy * s),
            (((ENV_L + ENV_R) / 2) * s, (fy + FLAP_DEPTH) * s),
            (ENV_R * s, fy * s),
        ],
        fill=PAPER,
        width=max(1, round(FLAP_W * s)),
        joint="curve",
    )

    # Asterisk — black halo first (so it reads "on top" of the red envelope),
    # then the white asterisk over it.
    _asterisk(draw, s, AST_W + AST_HALO, AST_HALO, INK)
    _asterisk(draw, s, AST_W, 0.0, PAPER)
    return img


def emit_foreground_vector() -> None:
    """Write the adaptive-icon foreground drawable from the same geometry."""
    env = (
        f"M{ENV_L + ENV_RADIUS},{ENV_T} "
        f"H{ENV_R - ENV_RADIUS} "
        f"A{ENV_RADIUS},{ENV_RADIUS} 0 0 1 {ENV_R},{ENV_T + ENV_RADIUS} "
        f"V{ENV_B - ENV_RADIUS} "
        f"A{ENV_RADIUS},{ENV_RADIUS} 0 0 1 {ENV_R - ENV_RADIUS},{ENV_B} "
        f"H{ENV_L + ENV_RADIUS} "
        f"A{ENV_RADIUS},{ENV_RADIUS} 0 0 1 {ENV_L},{ENV_B - ENV_RADIUS} "
        f"V{ENV_T + ENV_RADIUS} "
        f"A{ENV_RADIUS},{ENV_RADIUS} 0 0 1 {ENV_L + ENV_RADIUS},{ENV_T} Z"
    )
    fy = ENV_T + FLAP_INSET_Y
    cx = (ENV_L + ENV_R) / 2
    flap = f"M{ENV_L},{fy} L{cx},{fy + FLAP_DEPTH} L{ENV_R},{fy}"

    def ast_paths(width, extra_len, color):
        half = (AST_ARM + extra_len) / 2.0
        out = []
        for ang in AST_ANGLES:
            dx = half * math.cos(math.radians(ang))
            dy = half * math.sin(math.radians(ang))
            out.append(
                f'    <path\n'
                f'        android:strokeColor="{color}"\n'
                f'        android:strokeWidth="{width}"\n'
                f'        android:strokeLineCap="round"\n'
                f'        android:pathData="M{AST_CX - dx:.2f},{AST_CY - dy:.2f} '
                f'L{AST_CX + dx:.2f},{AST_CY + dy:.2f}" />'
            )
        return "\n".join(out)

    halo = ast_paths(AST_W + AST_HALO, AST_HALO, INK)
    star = ast_paths(AST_W, 0.0, PAPER)

    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<!-- Mail by Form* app mark — adaptive-icon foreground (API 26+).

     GENERATED by scripts/render-app-icon.py — do not edit by hand; edit the
     geometry constants in that script and re-run it (it regenerates this file
     and the mipmap-*/ic_launcher{{,_round}}.png fallbacks together, so the
     adaptive and raster renders never drift).

     Design: a red envelope with a white flap on a black background (from
     @drawable/ic_launcher_background) with a white Form*-style asterisk on
     the top-right corner, like an unread-mail notification. The envelope is
     kept well inside the adaptive safe zone (central 66 of 108) with black
     margin, so no launcher mask clips it and the black reads clearly. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">

    <!-- envelope body -->
    <path
        android:fillColor="{RED}"
        android:pathData="{env}" />

    <!-- envelope flap -->
    <path
        android:strokeColor="{PAPER}"
        android:strokeWidth="{FLAP_W}"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:pathData="{flap}" />

    <!-- asterisk halo (background ink, so the asterisk reads "on top") -->
{halo}

    <!-- Form* asterisk -->
{star}
</vector>
"""
    out = RES / "drawable-v24" / "ic_launcher_foreground.xml"
    out.write_text(xml)
    print(f"   vector             →  {out.relative_to(REPO)}")


# Android launcher densities. The adaptive foreground bitmap is the full 108dp
# canvas, so mdpi (48dp base) renders the 108-unit art at 108px, etc.
DENSITIES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def main() -> None:
    for bucket, size in DENSITIES.items():
        out_dir = RES / f"mipmap-{bucket}"
        out_dir.mkdir(parents=True, exist_ok=True)
        icon = render(size)
        icon.save(out_dir / "ic_launcher.png")
        icon.save(out_dir / "ic_launcher_round.png")
        print(f"  {bucket:>7}  {size:>4}×{size:<4}  →  {out_dir.name}/")

    emit_foreground_vector()

    web = REPO / "client" / "public" / "favicon-512.png"
    web.parent.mkdir(parents=True, exist_ok=True)
    render(512).save(web)
    print(f"   web      512×512   →  {web.relative_to(REPO)}")


if __name__ == "__main__":
    main()
