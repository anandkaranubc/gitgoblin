// Writes THIRD_PARTY_NOTICES.md for the npm packages an esbuild bundle inlines.
//
// A bundle copies other people's code into one file, and their licenses (MIT, ISC, BSD, Apache-2.0)
// require their copyright and license text to travel with it. This reads esbuild's metafile, finds
// the node_modules package behind every input, and writes each package's license, notice and
// copying files. Workspace sources (not under node_modules) are this repository's own code.
// Node built-ins only, so any bundle script in the repository can use it.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
// Licenses whose terms a bundled, MIT-licensed release cannot meet by including a notice.
const REFUSED = /\b(?:A?GPL|LGPL|SSPL|EUPL|OSL|CC-BY-SA)\b/i;

/** The packages behind a metafile's inputs, sorted by name. `root` is the build's absWorkingDir. */
export function collectPackages(metafile, { root }) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    // Greedy match: the last node_modules segment is the package that owns the file.
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll("\\", "/"));
    if (match) roots.add(resolve(root, match[1]));
  }
  const packages = [...roots].map((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const license = typeof manifest.license === "string" ? manifest.license : (manifest.license?.type ?? "UNKNOWN");
    const files = readdirSync(dir)
      .filter((name) => LICENSE_FILE.test(name))
      .sort()
      .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8").trim() }));
    return { name: manifest.name, version: manifest.version, license, files };
  });
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/** The notices file as Markdown. */
export function renderNotices(packages, { product = "This package" } = {}) {
  const lines = [
    "# Third-party notices",
    "",
    `${product} bundles the following packages. Their licenses require these notices to accompany it.`,
    "",
  ];
  for (const pkg of packages) {
    lines.push(`## ${pkg.name} ${pkg.version}`, "", `License: ${pkg.license}`, "");
    if (pkg.files.length === 0) lines.push("The package ships no license file; its license is stated in its package.json.", "");
    for (const file of pkg.files) lines.push(`### ${file.name}`, "", "```text", file.text, "```", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Collects, checks and writes the notices. Throws when a bundled package carries a license the
 * release cannot honour by including a notice; returns the packages and any warnings otherwise.
 */
export function writeNotices(metafile, outFile, { root, product } = {}) {
  if (!root) throw new Error("writeNotices needs { root }: the absWorkingDir the bundle was built from");
  const packages = collectPackages(metafile, { root });
  const refused = packages.filter((pkg) => REFUSED.test(pkg.license));
  if (refused.length > 0) {
    throw new Error(`refusing to bundle ${refused.map((pkg) => `${pkg.name} (${pkg.license})`).join(", ")}: its license needs more than a notice`);
  }
  const warnings = packages
    .filter((pkg) => pkg.files.length === 0 || pkg.license === "UNKNOWN")
    .map((pkg) => `${pkg.name} ${pkg.version}: ${pkg.license === "UNKNOWN" ? "no license declared" : "no license file"}`);
  writeFileSync(outFile, renderNotices(packages, { product }));
  return { packages, warnings };
}
