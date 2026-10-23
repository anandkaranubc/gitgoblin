/**
 * What kind of work a pull request is, from the paths it touched. Used to
 * see which non-tracker work actually gets merged from outsiders.
 */

export const CHANGE_KINDS = ["docs", "ci", "tests", "dependencies", "code", "mixed"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

const DOCS = /(^|\/)(readme|changelog|contributing|license|docs?|documentation|examples?|website|site)(\/|\.|$)|\.(md|mdx|rst|txt|adoc)$/i;
const CI = /^\.github\/|^\.gitlab-ci\.yml$|^\.circleci\/|^\.travis\.yml$|^azure-pipelines\.yml$|^Jenkinsfile$|^\.pre-commit-config\.yaml$|(^|\/)Dockerfile$|^\.devcontainer\//i;
const TESTS = /(^|\/)(tests?|__tests__|spec|specs|testdata|fixtures)\/|(^|\/)[^/]*(_test|\.test|\.spec|_spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$/i;
const DEPS = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|setup\.(py|cfg)|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|\.tool-versions)$/i;

export function kindOfPath(path: string): Exclude<ChangeKind, "mixed"> {
  if (CI.test(path)) return "ci";
  if (TESTS.test(path)) return "tests";
  if (DEPS.test(path)) return "dependencies";
  if (DOCS.test(path)) return "docs";
  return "code";
}

/** One kind when every file agrees (tests may accompany code); otherwise "mixed". */
export function classifyChange(paths: string[]): ChangeKind | undefined {
  if (paths.length === 0) return undefined;
  const kinds = new Set(paths.map(kindOfPath));
  if (kinds.size === 1) return [...kinds][0]!;
  if (kinds.size === 2 && kinds.has("code") && kinds.has("tests")) return "code";
  return "mixed";
}
