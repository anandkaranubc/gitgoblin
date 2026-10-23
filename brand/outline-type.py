#!/usr/bin/env python3
"""Outline a line of text into an SVG that build.mjs can place (wordmark.svg, tagline.svg).

    pip install fonttools uharfbuzz
    python3 brand/outline-type.py Bricolage.ttf gitgoblin brand/wordmark.svg \
        --tracking -0.03 --axis wght=800 --axis opsz=96 --comment "gitgoblin wordmark ..."

HarfBuzz shapes the text (kerning, ligatures) and fontTools draws the outlines. Variable fonts
work directly: pick the instance with --axis. The brand uses Bricolage Grotesque
(github.com/ateliertriay/bricolage) for the wordmark and Recursive (github.com/arrowtype/recursive,
MONO=1 CASL=0 wght=500) for the tagline. Both are SIL OFL 1.1 and on Google Fonts.
"""
import argparse

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont


def outline(path, text, size, tracking, axes, decimals):
    face = hb.Face(hb.Blob.from_file_path(path))
    font = hb.Font(face)
    upem = face.upem
    font.scale = (upem, upem)
    if axes:
        font.set_variations(axes)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, {"kern": True, "liga": True})

    tt = TTFont(path)
    glyphs = tt.getGlyphSet(location=axes or None)
    names = tt.getGlyphOrder()
    scale = size / upem
    fmt = lambda v: f"{v:.{decimals}f}".rstrip("0").rstrip(".") or "0"
    svg, bounds = SVGPathPen(glyphs, ntos=fmt), BoundsPen(glyphs)
    x = 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        t = (scale, 0, 0, -scale, (x + pos.x_offset) * scale, -pos.y_offset * scale)
        glyph = glyphs[names[info.codepoint]]
        glyph.draw(TransformPen(svg, t))
        glyph.draw(TransformPen(bounds, t))
        x += pos.x_advance + tracking * upem
    os2 = tt["OS/2"]
    return svg.getCommands(), bounds.bounds, os2.sxHeight * scale, os2.sCapHeight * scale


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("font")
    p.add_argument("text")
    p.add_argument("out")
    p.add_argument("--size", type=float, default=100, help="font size in SVG units (default 100)")
    p.add_argument("--tracking", type=float, default=0, help="extra letter spacing in em (e.g. -0.03)")
    p.add_argument("--axis", action="append", default=[], metavar="TAG=VALUE", help="variable font axis, repeatable")
    p.add_argument("--decimals", type=int, default=2)
    p.add_argument("--comment", default="")
    a = p.parse_args()
    axes = {k: float(v) for k, v in (s.split("=") for s in a.axis)}

    d, (x1, y1, x2, y2), xh, cap = outline(a.font, a.text, a.size, a.tracking, axes, a.decimals)
    w, h, baseline = round(x2 - x1, 2), round(y2 - y1, 2), round(-y1, 2)
    with open(a.out, "w") as f:
        f.write(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
            f'data-baseline="{baseline}" data-x-height="{xh:.2f}" data-cap-height="{cap:.2f}">\n'
            + (f"<!-- {a.comment} -->\n" if a.comment else "")
            + f'<path fill="currentColor" transform="translate({-x1:.2f} {baseline})" d="{d}"/>\n</svg>\n'
        )
    print(f"{a.out}: {w} x {h}, baseline {baseline}, x-height {xh:.2f}")


if __name__ == "__main__":
    main()
