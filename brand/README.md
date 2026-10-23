# gitgoblin brand

gitgoblin is a goblin that digs through forgotten corners of open source and ships what it
finds. The mark is that goblin: a 16×16 pixel head, ears out, scheming eyes, one snaggletooth.
It is drawn once as a text file ([goblin.txt](goblin.txt)) and built into everything else, so the
favicon, the terminal banner and the sticker are literally the same drawing.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="banner-dark.svg">
    <img alt="gitgoblin" src="banner-light.svg" width="560">
  </picture>
</p>

## Files

| File | Use it for |
| --- | --- |
| `mark.svg` | The mark, full colour. Works on light and dark. Has a viewBox and no fixed size. |
| `mark-mono.svg` | One colour, follows `currentColor`. Nav icons, print, embroidery. |
| `mark-lurk.svg` | Dark silhouette with glowing eyes. Dark surfaces only: loading states, 404s. |
| `wordmark.svg`, `lockup.svg` | Outlined type (`currentColor`); lockup is mark + wordmark. |
| `banner-light.svg`, `banner-dark.svg` | README header, displayed at 560px wide. |
| `favicon/` | `favicon.svg`, `favicon.ico`, PNGs at 16, 32, 180 (apple-touch), 192, 512. |
| `social/preview.png` | 1280×640 GitHub social preview and `og:image`. `avatar.png` is the GitHub avatar. |
| `mascot/` | Full-body sprites: `goblin-found` (holding up a shiny) and `goblin-peek` (over a ledge). |
| `terminal/` | The mark as ANSI half-blocks. `goblin.ans` is truecolor, `goblin-256.ans` the fallback. |
| `tokens.css` | Colour and font tokens, light and dark roles. |

## The mark

- Minimum size 16px. Scale in whole multiples where you can (16, 32, 48, 64, 80…). When a
  raster has to be resized, use nearest-neighbour (`image-rendering: pixelated`).
- Clear space: two grid pixels (an ear's length) on every side. Nothing else inside it.
- On a tile or avatar the mark fills 75% of the width and sits a little above centre, as in
  `favicon/icon-512.png`. Tiles are ink, never green.
- The eyes and mouth are ink. On dark backgrounds they read as holes; that is intended.
- Lockup: mark, a gap of three grid pixels, then the wordmark with its x-height centred on the
  face. Use `lockup.svg` instead of rebuilding it.

## Wordmark

`gitgoblin` is one word, always lowercase, including at the start of a sentence. The wordmark
is Bricolage Grotesque ExtraBold with -0.03em tracking, outlined into `wordmark.svg`; do not set
it live. Package names are `@gitgoblin/<name>`.

## Colour

| Token | Hex | Role | Terminal |
| --- | --- | --- | --- |
| goblin | `#6FDC4F` | The green. Skin, accents and text on dark (10.7:1 on ink). Graphic only on light. | `38;2;111;220;79` · 256: `77` |
| moss | `#2F6B27` | Green for text and links on light (5.7:1 on bone). | `38;2;47;107;39` · 256: `22` |
| ink | `#10140F` | Near-black. Text on light; dark backgrounds and tiles. | `38;2;16;20;15` · 256: `233` |
| ink-2 | `#41503F` | Secondary text on light (7.6:1 on bone). | |
| bone | `#F4F1E6` | Warm off-white. Light backgrounds; text on dark. The snaggletooth. | `38;2;244;241;230` · 256: `255` |
| bone-2 / line | `#E9E6D8` / `#D3CFBF` | Raised surfaces and borders on light. | |
| loot | `#FFC53D` | Gold for found things and highlights. Graphic only on light. | `38;2;255;197;61` · 256: `221` |
| ember | `#B8411A` | Stops, errors, warnings. | `38;2;184;65;26` · 256: `130` |
| cave | `#1B2418` | Raised surfaces on dark; the lurk silhouette. | |

Light pages are bone with ink text and moss accents. Dark pages are ink with bone text and goblin
accents. Green and gold are too light for body text on light backgrounds; use moss there.

## Type

- Display and headings: [Bricolage Grotesque](https://github.com/ateliertriay/bricolage), weights 600–800.
- Body: [Recursive](https://github.com/arrowtype/recursive) Sans Linear. Code and terminal-style text: Recursive Mono.
- Both are SIL Open Font License. `tokens.css` carries the font stacks.

## Voice

- Lowercase, short, dry. Say what was found and why it matters; let the evidence do the bragging.
- Curious and a little chaotic, never destructive. The mischief points at the code, not at maintainers.
- Goblin words are seasoning: "found", "dug up", "shiny", "loot" for opportunities. Never "steal", "raid" or "hack".

## Don't

- Don't smooth, round, outline, redraw, rotate or skew the pixels.
- Don't add gradients, glows, shadows or 3D.
- Don't recolour the goblin. Mono and lurk are the only variants.
- Don't put the mark on git's orange or inside a green tile.
- Don't set the wordmark in another font, in Title Case or as "GitGoblin".
- Don't turn the goblin into a robot.

## Rebuilding

```sh
node brand/build.mjs                                      # SVG and terminal art
npm i --no-save @resvg/resvg-js && node brand/build.mjs   # also PNG and ICO
```

Edit `goblin.txt` or the grids in `mascot/` and rebuild; everything else is derived. The wordmark
and tagline are outlined type. To change the tagline, download Recursive from Google Fonts and run
`outline-type.py` (needs `pip install fonttools uharfbuzz`; the docstring has the exact command),
then rebuild.

To print the goblin in a terminal, write `terminal/goblin.ans` to stdout as-is, and prefer
`goblin-256.ans` when `COLORTERM` is not `truecolor`.
