/**
 * Deprecated and removed APIs worth replacing. Python rules carry the version
 * that removed the API so they can be gated on what the project claims to support.
 * Last reviewed 2026-10-22.
 */
export type Ecosystem = "python" | "node" | "go" | "rust";

export interface DeprecationRule {
  id: string;
  ecosystem: Ecosystem;
  /** Tested per line of source, with strings and comments blanked unless `quoted` is set. */
  pattern: RegExp;
  /** The pattern names a quoted import path, so string literals stay visible to it. */
  quoted?: boolean;
  severity: "removed" | "deprecated";
  /** Python minor version where the API was removed; the rule only fires when the project can run there. */
  removedIn?: string;
  title: string;
  detail: string;
  fix: string;
  reference: string;
}

const PEP594 = "asyncore|asynchat|smtpd|imghdr|sndhdr|nntplib|telnetlib|cgi|cgitb|crypt|pipes|mailcap|msilib|nis|ossaudiodev|spwd|sunau|uu|xdrlib|audioop|aifc|chunk";

export const DEPRECATION_RULES: DeprecationRule[] = [
  {
    id: "py-imp", ecosystem: "python", severity: "removed", removedIn: "3.12",
    pattern: /^\s*(import imp\b|from imp import)/,
    title: "Replace the removed `imp` module with importlib",
    detail: "`imp` was removed in Python 3.12; any import of it raises ModuleNotFoundError there.",
    fix: "Use importlib.util.spec_from_file_location / module_from_spec, or importlib.import_module.",
    reference: "https://docs.python.org/3.12/whatsnew/3.12.html#imp",
  },
  {
    id: "py-distutils", ecosystem: "python", severity: "removed", removedIn: "3.12",
    pattern: /^\s*(import distutils\b|from distutils(\.\w+)* import)/,
    title: "Replace distutils, removed from the standard library",
    detail: "distutils was removed in Python 3.12. setuptools still ships a shim, but only when setuptools is installed and imported first.",
    fix: "Use setuptools, packaging.version, shutil, or sysconfig depending on what was imported.",
    reference: "https://peps.python.org/pep-0632/",
  },
  {
    id: "py-pep594", ecosystem: "python", severity: "removed", removedIn: "3.13",
    pattern: new RegExp(`^\\s*(import (${PEP594})\\b|from (${PEP594}) import)`),
    title: "Replace standard-library modules removed by PEP 594",
    detail: "These 'dead battery' modules were removed in Python 3.13; importing them fails there.",
    fix: "Use the replacements listed in PEP 594 (for example `email` for cgi parsing, `legacy-cgi` on PyPI, `asyncio` for asyncore).",
    reference: "https://peps.python.org/pep-0594/",
  },
  {
    id: "py-collections-abc", ecosystem: "python", severity: "removed", removedIn: "3.10",
    pattern: /\bcollections\.(Mapping|MutableMapping|Sequence|MutableSequence|Iterable|Iterator|Callable|Hashable|Sized|Container|Set|MutableSet|Generator|Awaitable|Coroutine|AsyncIterable|AsyncIterator)\b/,
    title: "Import ABCs from collections.abc instead of collections",
    detail: "The aliases in `collections` were removed in Python 3.10; attribute access raises AttributeError.",
    fix: "Change `collections.X` to `collections.abc.X`.",
    reference: "https://docs.python.org/3.10/whatsnew/3.10.html#removed",
  },
  {
    id: "py-makesuite", ecosystem: "python", severity: "removed", removedIn: "3.13",
    pattern: /\bunittest\.(makeSuite|findTestCases|getTestCaseNames)\b/,
    title: "Replace unittest.makeSuite, removed in Python 3.13",
    detail: "makeSuite and findTestCases were removed in 3.13 after a long deprecation.",
    fix: "Use unittest.TestLoader().loadTestsFromTestCase(...).",
    reference: "https://docs.python.org/3.13/whatsnew/3.13.html#unittest",
  },
  {
    id: "py-utcnow", ecosystem: "python", severity: "deprecated",
    pattern: /\bdatetime\.(utcnow|utcfromtimestamp)\(/,
    title: "Replace datetime.utcnow(), deprecated since Python 3.12",
    detail: "utcnow() and utcfromtimestamp() return naive datetimes and emit DeprecationWarning on 3.12+; they are scheduled for removal.",
    fix: "Use datetime.now(datetime.UTC) (or timezone.utc on older Pythons) and fromtimestamp(ts, UTC).",
    reference: "https://docs.python.org/3.12/library/datetime.html#datetime.datetime.utcnow",
  },
  {
    id: "py-pkg-resources", ecosystem: "python", severity: "deprecated",
    pattern: /^\s*(import pkg_resources\b|from pkg_resources import)/,
    title: "Replace pkg_resources with importlib.metadata and importlib.resources",
    detail: "setuptools deprecated pkg_resources, scheduled its removal, and newer releases warn on import; it is also slow to import.",
    fix: "Use importlib.metadata.version()/entry_points() and importlib.resources.files(); use `packaging` for version parsing.",
    reference: "https://setuptools.pypa.io/en/latest/pkg_resources.html",
  },
  {
    id: "py-six", ecosystem: "python", severity: "deprecated",
    pattern: /^\s*(import six\b|from six(\.\w+)* import)/,
    title: "Drop the `six` Python 2 compatibility layer",
    detail: "The project only supports Python 3, so `six` adds a dependency for shims that have direct stdlib equivalents.",
    fix: "Replace six.moves imports with the Python 3 module paths and six.string_types with str.",
    reference: "https://six.readthedocs.io/",
  },
  {
    id: "node-buffer", ecosystem: "node", severity: "deprecated",
    pattern: /\bnew Buffer\(/,
    title: "Replace `new Buffer()` with Buffer.from / Buffer.alloc",
    detail: "The Buffer constructor has been deprecated since Node 6 (DEP0005) for security reasons and prints a runtime warning.",
    fix: "Use Buffer.from(data), Buffer.alloc(size) or Buffer.allocUnsafe(size).",
    reference: "https://nodejs.org/api/deprecations.html#DEP0005",
  },
  {
    id: "node-fs-exists", ecosystem: "node", severity: "deprecated",
    pattern: /\bfs\.exists\(/,
    title: "Replace fs.exists() (DEP0013)",
    detail: "fs.exists uses a non-standard callback and is deprecated.",
    fix: "Use fs.access, fs.stat, or fs.existsSync where a synchronous check is acceptable.",
    reference: "https://nodejs.org/api/deprecations.html#DEP0013",
  },
  {
    id: "node-url-parse", ecosystem: "node", severity: "deprecated",
    pattern: /\burl\.parse\(/,
    title: "Replace url.parse() with the WHATWG URL class",
    detail: "The legacy url.parse() API is documentation- and runtime-deprecated (DEP0169) because it is not spec-compliant and has had security issues.",
    fix: "Use `new URL(input, base)` and URLSearchParams.",
    reference: "https://nodejs.org/api/deprecations.html#DEP0169",
  },
  {
    id: "go-ioutil", ecosystem: "go", severity: "deprecated",
    pattern: /^\s*(?:\w+\s+)?"io\/ioutil"/,
    quoted: true,
    title: "Replace io/ioutil with io and os",
    detail: "io/ioutil has been deprecated since Go 1.16; its functions moved to io and os.",
    fix: "ioutil.ReadFile -> os.ReadFile, ioutil.ReadAll -> io.ReadAll, ioutil.TempDir -> os.MkdirTemp, and so on.",
    reference: "https://pkg.go.dev/io/ioutil",
  },
  {
    id: "go-x-net-context", ecosystem: "go", severity: "deprecated",
    pattern: /"golang\.org\/x\/net\/context"/,
    quoted: true,
    title: "Use the standard library context package",
    detail: "golang.org/x/net/context is a thin alias kept for compatibility; the standard `context` has been the right import since Go 1.7.",
    fix: "Import \"context\" instead.",
    reference: "https://pkg.go.dev/golang.org/x/net/context",
  },
  {
    id: "go-golang-protobuf", ecosystem: "go", severity: "deprecated",
    pattern: /"github\.com\/golang\/protobuf\/proto"/,
    quoted: true,
    title: "Migrate from github.com/golang/protobuf to google.golang.org/protobuf",
    detail: "The old protobuf module is deprecated in favour of the APIv2 module.",
    fix: "Import google.golang.org/protobuf/proto and regenerate with protoc-gen-go v1.20+.",
    reference: "https://go.dev/blog/protobuf-apiv2",
  },
];

/** npm packages that are deprecated or compromised; matched against direct dependencies. */
export const DEPRECATED_NPM: Record<string, { fix: string; reference: string }> = {
  request: { fix: "Use undici, node-fetch, got or the built-in fetch.", reference: "https://github.com/request/request/issues/3142" },
  "request-promise": { fix: "Use the built-in fetch or got.", reference: "https://github.com/request/request/issues/3142" },
  "node-sass": { fix: "Use `sass` (Dart Sass).", reference: "https://sass-lang.com/blog/libsass-is-deprecated/" },
  tslint: { fix: "Migrate to eslint with typescript-eslint.", reference: "https://github.com/palantir/tslint/issues/4534" },
  istanbul: { fix: "Use nyc or c8.", reference: "https://github.com/gotwarlost/istanbul" },
  "babel-preset-es2015": { fix: "Use @babel/preset-env.", reference: "https://babeljs.io/docs/babel-preset-env" },
  "node-uuid": { fix: "Use `uuid`.", reference: "https://www.npmjs.com/package/node-uuid" },
  "coffee-script": { fix: "Use `coffeescript`.", reference: "https://www.npmjs.com/package/coffee-script" },
  jade: { fix: "Use `pug`.", reference: "https://www.npmjs.com/package/jade" },
  optimist: { fix: "Use yargs or commander.", reference: "https://www.npmjs.com/package/optimist" },
  faker: { fix: "Use @faker-js/faker; the original package was sabotaged in 2022.", reference: "https://github.com/faker-js/faker" },
  "gulp-util": { fix: "Use the individual replacement modules listed in the gulp-util README.", reference: "https://github.com/gulpjs/gulp-util" },
  "left-pad": { fix: "Use String.prototype.padStart.", reference: "https://www.npmjs.com/package/left-pad" },
  "@types/mocha": { fix: "", reference: "" },
};
delete DEPRECATED_NPM["@types/mocha"]; // placeholder removed; keep the table honest

/** Cargo crates that are unmaintained with a well-known successor. */
export const DEPRECATED_CRATES: Record<string, { fix: string; reference: string }> = {
  failure: { fix: "Use thiserror for libraries or anyhow for applications.", reference: "https://github.com/rust-lang-deprecated/failure" },
  "error-chain": { fix: "Use thiserror or anyhow.", reference: "https://github.com/rust-lang-deprecated/error-chain" },
  "rustc-serialize": { fix: "Use serde.", reference: "https://github.com/rust-lang-deprecated/rustc-serialize" },
  tempdir: { fix: "Use tempfile.", reference: "https://github.com/rust-lang-deprecated/tempdir" },
  net2: { fix: "Use socket2.", reference: "https://github.com/deprecrated/net2-rs" },
};

/** Deprecated Go modules by import path prefix. */
export const DEPRECATED_GO_MODULES: Record<string, { fix: string; reference: string }> = {
  "github.com/pkg/errors": { fix: "Use fmt.Errorf with %w and errors.Is/As from the standard library.", reference: "https://github.com/pkg/errors" },
  "github.com/golang/protobuf": { fix: "Use google.golang.org/protobuf.", reference: "https://go.dev/blog/protobuf-apiv2" },
  "github.com/dgrijalva/jwt-go": { fix: "Use github.com/golang-jwt/jwt (maintained fork, fixes CVE-2020-26160).", reference: "https://github.com/dgrijalva/jwt-go/issues/462" },
};

/** Python minor versions and when they stopped receiving security fixes. */
export const PYTHON_EOL: Record<string, string> = {
  "2.7": "2020-01-01", "3.5": "2020-09-30", "3.6": "2021-12-23", "3.7": "2023-06-27",
  "3.8": "2024-10-07", "3.9": "2025-10-31", "3.10": "2026-10-31", "3.11": "2027-10-31",
};
/** Newest Python release line at the time of the last rule review. */
export const LATEST_PYTHON = "3.15";
