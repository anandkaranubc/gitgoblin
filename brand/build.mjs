#!/usr/bin/env node
// Builds every gitgoblin brand asset from the pixel grids (*.txt) and the outlined type
// (wordmark.svg, tagline.svg) in this folder. Run: node brand/build.mjs
// SVG output needs only Node. PNG and ICO output also need @resvg/resvg-js
// (npm i --no-save @resvg/resvg-js); without it those files are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const here = path.dirname(new URL(import.meta.url).pathname);
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');
function write(f, data) {
  if (typeof data === 'string' && data.includes('NaN')) throw new Error(`${f} has NaN coordinates; check wordmark.svg and tagline.svg`);
  fs.mkdirSync(path.dirname(path.join(here, f)), { recursive: true });
  fs.writeFileSync(path.join(here, f), data);
  console.log('  ' + f);
}

export const colors = {
  goblin: '#6FDC4F', moss: '#2F6B27', ink: '#10140F', ink2: '#41503F', bone: '#F4F1E6',
  bone2: '#E9E6D8', line: '#D3CFBF', loot: '#FFC53D', ember: '#B8411A', cave: '#1B2418',
};
const C = colors;

// Grid legend: . transparent  g goblin  k ink  w bone  y loot  h hoodie
const PAL = {
  light: { g: C.goblin, k: C.ink, w: C.bone, y: C.loot, h: C.ink },
  dark: { g: C.goblin, k: C.ink, w: C.bone, y: C.loot, h: C.bone },
  mono: { g: 'currentColor', w: 'currentColor', y: 'currentColor', h: 'currentColor' },
  lurk: { g: C.cave, k: C.goblin, w: C.bone },
};

const grid = (f) => read(f).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

// One path per colour; horizontal runs of pixels become rectangles.
function pixels(rows, pal) {
  const runs = {};
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const c = row[x];
      let x2 = x;
      while (x2 < row.length && row[x2] === c) x2++;
      if (pal[c]) (runs[c] ||= []).push(`M${x} ${y}h${x2 - x}v1h${x - x2}z`);
      x = x2;
    }
  });
  return Object.entries(runs).map(([c, d]) => `<path fill="${pal[c]}" d="${d.join('')}"/>`).join('');
}

const SVG = (viewBox, body, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" shape-rendering="crispEdges"${attrs}>${body}</svg>\n`;

const sprite = (rows, pal) => SVG(`0 0 ${rows[0].length} ${rows.length}`, pixels(rows, pal));

// Outlined type exported with its metrics (see wordmark.svg).
function type(f) {
  const s = read(f);
  const vb = /viewBox="([^"]+)"/.exec(s)[1].split(/\s+/).map(Number);
  return {
    d: /\sd="([^"]+)"/.exec(s)[1],
    shift: /transform="translate\(([^)]+)\)"/.exec(s)[1],
    w: vb[2], h: vb[3],
    baseline: +/data-baseline="([^"]+)"/.exec(s)[1],
    xHeight: +/data-x-height="([^"]+)"/.exec(s)[1],
  };
}
const place = (t, x, y, scale, fill) =>
  `<g transform="translate(${x} ${y}) scale(${scale})" fill="${fill}"><path transform="translate(${t.shift})" d="${t.d}"/></g>`;

// ---------------------------------------------------------------- marks
const mark = grid('goblin.txt');
write('mark.svg', sprite(mark, PAL.light));
write('mark-mono.svg', sprite(mark, PAL.mono));
write('mark-lurk.svg', sprite(mark, PAL.lurk));

for (const name of ['goblin-found', 'goblin-peek']) {
  const rows = grid(`mascot/${name}.txt`);
  write(`mascot/${name}-light.svg`, sprite(rows, PAL.light));
  write(`mascot/${name}-dark.svg`, sprite(rows, PAL.dark));
}

// ---------------------------------------------------------------- lockups
const wordmark = type('wordmark.svg');
const tagline = type('tagline.svg');
const U = 10; // mark pixel size in lockups; the mark is 160 units tall
const FACE_CENTER = 8.5 * U; // the head spans grid rows 3..13

// Mark plus wordmark, x-height centred on the face.
function lockup(fg) {
  const s = (8 * U) / wordmark.xHeight;
  const x = 16 * U + 3 * U;
  const y = FACE_CENTER - s * (wordmark.baseline - wordmark.xHeight / 2);
  const body = `<g transform="scale(${U})">${pixels(mark, PAL.light)}</g>` + place(wordmark, x, y, s, fg);
  return { body, w: x + s * wordmark.w, h: Math.max(16 * U, y + s * wordmark.h) };
}
const lk = lockup('currentColor');
write('lockup.svg', SVG(`0 0 ${Math.ceil(lk.w)} ${Math.ceil(lk.h)}`, lk.body));

// README banner: lockup and tagline, transparent, 1120x300 (displayed at 560).
function banner(fg, tagFg) {
  const W = 1120, H = 300;
  const l = lockup(fg);
  const ts = 26 / tagline.xHeight;
  const tw = ts * tagline.w;
  const body =
    `<g transform="translate(${((W - l.w) / 2).toFixed(1)} 40)">${l.body}</g>` +
    place(tagline, (W - tw) / 2, 248, ts, tagFg);
  return SVG(`0 0 ${W} ${H}`, body, ` width="${W}" height="${H}"`);
}
write('banner-light.svg', banner(C.ink, C.moss));
write('banner-dark.svg', banner(C.bone, C.goblin));

// Social preview 1280x640: wordmark and tagline top-left, the goblin peeking over a bar.
function social() {
  const W = 1280, H = 640, bar = 560, peek = grid('mascot/goblin-peek.txt'), S = 18;
  const ws = 640 / wordmark.w, ts = 26 / tagline.xHeight;
  const body =
    `<rect width="${W}" height="${H}" fill="${C.ink}"/>` +
    `<rect y="${bar}" width="${W}" height="${H - bar}" fill="${C.cave}"/>` +
    place(wordmark, 96, 120, ws, C.bone) +
    place(tagline, 96, 120 + ws * wordmark.h + 60, ts, C.goblin) +
    `<g transform="translate(${W - 16 * S - 96} ${bar - 9 * S}) scale(${S})">${pixels(peek, PAL.light)}</g>`;
  return SVG(`0 0 ${W} ${H}`, body, ` width="${W}" height="${H}"`);
}
write('social/preview.svg', social());

// Mark on an ink tile (app icons, avatars). The head sits a little above centre.
const tile = (inner = 0.75) => SVG('0 0 16 16',
  `<rect width="16" height="16" fill="${C.ink}"/><g transform="translate(${8 - 8 * inner} ${8 - 8.5 * inner}) scale(${inner})">${pixels(mark, PAL.light)}</g>`);
write('favicon/favicon.svg', sprite(mark, PAL.light));

// ---------------------------------------------------------------- terminal
// Two grid rows per text line using half blocks; fg is the upper pixel, bg the lower.
function ansi(rows, pal, sgr) {
  let out = '';
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y], bot = rows[y + 1] ?? '';
    for (let x = 0; x < top.length; x++) {
      const t = pal[top[x]], b = pal[bot[x]];
      if (t && b) out += `\x1b[38;${sgr(t)};48;${sgr(b)}m▀`;
      else if (t) out += `\x1b[0;38;${sgr(t)}m▀`;
      else if (b) out += `\x1b[0;38;${sgr(b)}m▄`;
      else out += '\x1b[0m ';
    }
    out += '\x1b[0m\n';
  }
  return out;
}
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const truecolor = (hex) => `2;${rgb(hex).join(';')}`;
// Nearest xterm-256 colour: the 6x6x6 cube or, for greys, the 24-step ramp.
const LEVELS = [0, 95, 135, 175, 215, 255];
const nearest = (v) => LEVELS.reduce((best, l, i) => (Math.abs(l - v) < Math.abs(LEVELS[best] - v) ? i : best), 0);
function xterm256(hex) {
  const [r, g, b] = rgb(hex);
  const [ri, gi, bi] = [r, g, b].map(nearest);
  const grey = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const nearGrey = Math.max(r, g, b) - Math.min(r, g, b) < 24;
  return `5;${nearGrey ? 232 + grey : 16 + 36 * ri + 6 * gi + bi}`;
}
write('terminal/goblin.ans', ansi(mark.slice(2, 14), PAL.light, truecolor));
write('terminal/goblin-256.ans', ansi(mark.slice(2, 14), PAL.light, xterm256));
write('terminal/goblin-found.ans', ansi(grid('mascot/goblin-found.txt'), PAL.dark, truecolor));

// ---------------------------------------------------------------- rasters
let Resvg;
try { ({ Resvg } = createRequire(import.meta.url)('@resvg/resvg-js')); } catch {
  console.log('  (skipping PNG/ICO: npm i --no-save @resvg/resvg-js to build them)');
}
if (Resvg) {
  const png = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
  const ico = (images) => { // PNG-in-ICO, one entry per size
    const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
    let offset = 6 + 16 * images.length;
    const dirs = images.map(({ size, data }) => {
      const e = Buffer.alloc(16); e[0] = e[1] = size & 0xff; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
      e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12); offset += data.length; return e;
    });
    return Buffer.concat([head, ...dirs, ...images.map((i) => i.data)]);
  };
  const fav = read('favicon/favicon.svg');
  const sizes = [16, 32].map((size) => ({ size, data: png(fav, size) }));
  for (const { size, data } of sizes) write(`favicon/favicon-${size}.png`, data);
  write('favicon/favicon.ico', ico(sizes));
  write('favicon/apple-touch-icon.png', png(tile(), 180));
  write('favicon/icon-192.png', png(tile(), 192));
  write('favicon/icon-512.png', png(tile(), 512));
  write('social/avatar.png', png(tile(0.7), 512));
  write('social/preview.png', png(read('social/preview.svg'), 1280));
  write('mascot/goblin-found.png', png(read('mascot/goblin-found-light.svg'), 32 * 8));
}
