// Copies the shared brand assets from ../brand into public/ so the site never
// keeps a diverging copy. Runs before dev and build.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const brand = resolve(here, "../../brand");
const pub = resolve(here, "../public");

const files = {
  "favicon/favicon.svg": "favicon.svg",
  "favicon/favicon.ico": "favicon.ico",
  "favicon/favicon-16.png": "favicon-16.png",
  "favicon/favicon-32.png": "favicon-32.png",
  "favicon/apple-touch-icon.png": "apple-touch-icon.png",
  "favicon/icon-192.png": "icon-192.png",
  "favicon/icon-512.png": "icon-512.png",
  "social/preview.png": "og.png",
};

if (!existsSync(brand)) {
  console.error(`sync-brand: ${brand} not found. The site needs the repository's brand/ directory.`);
  process.exit(1);
}

mkdirSync(pub, { recursive: true });
let missing = 0;
for (const [from, to] of Object.entries(files)) {
  const src = resolve(brand, from);
  if (!existsSync(src)) {
    console.warn(`sync-brand: missing brand/${from}`);
    missing += 1;
    continue;
  }
  copyFileSync(src, resolve(pub, to));
}
console.log(`sync-brand: copied ${Object.keys(files).length - missing} of ${Object.keys(files).length} files`);
if (missing) process.exit(1);
