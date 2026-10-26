// Checks the built site in dist/: every internal link and asset resolves, every
// page has the metadata search engines and social cards need, and basic
// accessibility invariants hold. Exit code 1 on any failure.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const base = (process.env.BASE_PATH ?? "/gitgoblin").replace(/\/$/, "");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

const pages = walk(dist);
const problems = [];
const ids = new Map();

for (const page of pages) {
  const html = readFileSync(page, "utf8");
  ids.set(page, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
}

function targetFile(urlPath) {
  const clean = urlPath.replace(/\/$/, "");
  const candidates = [join(dist, clean, "index.html"), join(dist, clean), join(dist, `${clean}.html`)];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

for (const page of pages) {
  // Forward slashes on every platform, so the path checks below also hold on Windows.
  const rel = page.slice(dist.length).replaceAll("\\", "/");
  const html = readFileSync(page, "utf8");
  const need = (re, label) => {
    if (!re.test(html)) problems.push(`${rel}: missing ${label}`);
  };
  need(/<html[^>]+lang="/, "html lang");
  need(/<title>[^<]+<\/title>/, "title");
  need(/<meta name="description" content="[^"]+"/, "meta description");
  // The 404 page has no address of its own, so it is kept out of search instead of naming one.
  if (rel === "/404.html") need(/<meta name="robots" content="noindex"/, "noindex");
  else need(/<link rel="canonical"/, "canonical link");
  need(/<meta property="og:image"/, "og:image");
  // Docs pages are articles for link previews; every other page is the website.
  const ogType = rel.startsWith("/docs/") ? "article" : "website";
  need(new RegExp(`<meta property="og:type" content="${ogType}"`), `og:type ${ogType}`);
  need(/<meta name="viewport"/, "viewport");
  const h1s = html.match(/<h1[\s>]/g)?.length ?? 0;
  if (h1s !== 1) problems.push(`${rel}: expected one h1, found ${h1s}`);
  for (const img of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\balt=/.test(img[0])) problems.push(`${rel}: img without alt: ${img[0].slice(0, 60)}`);
  }

  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    if (/^(https?:|mailto:|data:|#$)/.test(url)) continue;
    const [pathPart, fragment] = url.split("#");
    let file = page;
    if (pathPart) {
      if (!pathPart.startsWith(base + "/") && pathPart !== base) {
        problems.push(`${rel}: link outside base path: ${url}`);
        continue;
      }
      file = targetFile(pathPart.slice(base.length) || "/");
      if (!file) {
        problems.push(`${rel}: broken link ${url}`);
        continue;
      }
    }
    if (fragment && file.endsWith(".html") && !ids.get(file)?.has(fragment)) {
      problems.push(`${rel}: missing anchor #${fragment} in ${file.slice(dist.length)}`);
    }
  }
}

for (const required of ["sitemap-index.xml", "robots.txt", "llms.txt", "404.html", "site.webmanifest", "og.png"]) {
  if (!existsSync(join(dist, required))) problems.push(`dist: missing ${required}`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s) in ${pages.length} pages`);
  process.exit(1);
}
console.log(`check-dist: ${pages.length} pages, all links, anchors and metadata ok`);
