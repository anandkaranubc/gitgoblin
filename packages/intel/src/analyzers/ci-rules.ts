/**
 * What breaks or has broken in GitHub Actions workflows. Each rule names a
 * date and a reference so a contributor can cite it in the PR.
 * Last reviewed 2026-10-22 against actions/runner-images and the GitHub changelog.
 */
export type CiSeverity = "broken" | "deprecated" | "security";

export interface CiRule {
  id: string;
  severity: CiSeverity;
  /** Tested against each non-comment line. */
  pattern: RegExp;
  title: string;
  detail: string;
  fix: string;
  reference: string;
}

const RETIRED_RUNNERS = "ubuntu-18\\.04|ubuntu-20\\.04|macos-10\\.15|macos-11|macos-12|macos-13(-large|-xlarge)?|windows-2016|windows-2019";

export const CI_RULES: CiRule[] = [
  {
    id: "retired-runner",
    severity: "broken",
    pattern: new RegExp(`(^|[\\s\\[,"'])(${RETIRED_RUNNERS})(?=[\\s\\],"']|$)`),
    title: "Workflow targets a retired runner image",
    detail: "GitHub has removed this runner label; jobs that request it fail at queue time. ubuntu-20.04 went away in April 2025, macOS 13 in December 2025, windows-2019 in June 2025.",
    fix: "Move to ubuntu-24.04 (or ubuntu-latest), macos-15, or windows-2025 and fix anything that depended on the old image.",
    reference: "https://github.com/actions/runner-images#available-images",
  },
  {
    id: "macos-14-deprecated",
    severity: "deprecated",
    pattern: /(^|[\s\[,"'])macos-14(-large|-xlarge)?(?=[\s\],"']|$)/,
    title: "Workflow targets the deprecated macOS 14 runner",
    detail: "macos-14 is marked deprecated in actions/runner-images and its retirement was announced in October 2026; jobs will start failing when it is removed.",
    fix: "Switch to macos-15 or macos-latest.",
    reference: "https://github.com/actions/runner-images/issues/13518",
  },
  {
    id: "artifact-v3",
    severity: "broken",
    pattern: /uses:\s*actions\/(upload|download)-artifact@v[123]\b/,
    title: "upload-artifact/download-artifact v3 or older no longer works",
    detail: "GitHub shut down the v1 to v3 artifact actions on 30 January 2025; steps using them fail.",
    fix: "Upgrade to actions/upload-artifact@v4 and actions/download-artifact@v4 (note: v4 artifacts are immutable and names must be unique per run).",
    reference: "https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/",
  },
  {
    id: "cache-v2",
    severity: "broken",
    pattern: /uses:\s*actions\/cache@(v[12]\b|v3\.[0-3]\.\d+)/,
    title: "actions/cache version uses the shut-down cache service",
    detail: "The legacy cache service was turned off on 1 March 2025; actions/cache v1, v2 and v3.0 to v3.3 fail.",
    fix: "Upgrade to actions/cache@v4.",
    reference: "https://github.blog/changelog/2024-12-05-notice-of-upcoming-releases-and-breaking-changes-for-github-actions/",
  },
  {
    id: "set-env",
    severity: "broken",
    pattern: /::(set-env|add-path)\b/,
    title: "Workflow uses the disabled set-env or add-path commands",
    detail: "These workflow commands were disabled in November 2020 for security reasons; the step fails.",
    fix: "Write to $GITHUB_ENV and $GITHUB_PATH instead.",
    reference: "https://github.blog/changelog/2020-10-01-github-actions-deprecating-set-env-and-add-path-commands/",
  },
  {
    id: "codeql-v1-v2",
    severity: "broken",
    pattern: /uses:\s*github\/codeql-action\/[\w-]+@v[12]\b/,
    title: "CodeQL action v1 or v2 is no longer supported",
    detail: "CodeQL Action v1 stopped working in January 2023 and v2 was deprecated in December 2024 in favour of v3.",
    fix: "Upgrade to github/codeql-action/*@v3 (or v4).",
    reference: "https://github.blog/changelog/2024-01-12-code-scanning-deprecation-of-codeql-action-v2/",
  },
  {
    id: "codecov-v1",
    severity: "broken",
    pattern: /uses:\s*codecov\/codecov-action@v1\b/,
    title: "codecov-action v1 relies on the removed bash uploader",
    detail: "Codecov removed the bash uploader in February 2022; v1 of the action cannot upload reports.",
    fix: "Upgrade to codecov/codecov-action@v4 or later and pass a token where required.",
    reference: "https://about.codecov.io/blog/introducing-codecovs-new-uploader/",
  },
  {
    id: "set-output",
    severity: "deprecated",
    pattern: /::(set-output|save-state)\b/,
    title: "Workflow uses deprecated set-output or save-state commands",
    detail: "Deprecated since October 2022; GitHub prints warnings and has announced removal.",
    fix: "Append to $GITHUB_OUTPUT or $GITHUB_STATE instead.",
    reference: "https://github.blog/changelog/2022-10-11-github-actions-deprecating-save-state-and-set-output-commands/",
  },
  {
    id: "node16-actions",
    severity: "deprecated",
    pattern: /uses:\s*actions\/(checkout|setup-node|setup-python|setup-go|setup-java|setup-dotnet|github-script|labeler|stale|cache)@v[123]\b/,
    title: "Core actions pinned to Node 16 era versions",
    detail: "Versions v1 to v3 of the core actions run on Node 12 or 16, which GitHub stopped supporting; the runner now forces a newer Node and warns on every run.",
    fix: "Bump each action to its current major (checkout@v5, setup-node@v5, setup-python@v6, cache@v4, and so on) and read the release notes for input changes.",
    reference: "https://github.blog/changelog/2023-09-22-github-actions-transitioning-from-node-16-to-node-20/",
  },
  {
    id: "python-eol-on-latest",
    severity: "broken",
    pattern: /python-version:.{0,200}(^|[\s\["'])(2\.7|3\.[5-7])(?=[\s\]"',]|$)/,
    title: "Workflow asks setup-python for a Python that ubuntu-latest cannot install",
    detail: "ubuntu-latest is Ubuntu 24.04, and the python-versions manifest has no 3.7 or older builds for it; setup-python fails unless the job pins ubuntu-22.04.",
    fix: "Drop the end-of-life Python versions from the matrix (and from python_requires if still claimed), or pin runs-on to ubuntu-22.04.",
    reference: "https://github.com/actions/setup-python/issues/544",
  },
  {
    id: "create-release",
    severity: "deprecated",
    pattern: /uses:\s*actions\/create-release@/,
    title: "actions/create-release is archived",
    detail: "The action is unmaintained and archived; it still runs today but receives no security fixes.",
    fix: "Use softprops/action-gh-release or `gh release create` in a run step.",
    reference: "https://github.com/actions/create-release",
  },
];

/** Dangerous trigger: untrusted PR code checked out under a workflow with write permissions. */
export const PWN_REQUEST = {
  id: "pull-request-target-checkout",
  severity: "security" as CiSeverity,
  title: "pull_request_target workflow checks out untrusted pull request code",
  detail: "Workflows triggered by pull_request_target run with the base repository's secrets and a write token; checking out the PR head lets any PR run code with those privileges.",
  fix: "Use the pull_request trigger, or split into a privileged workflow that never checks out PR code (workflow_run pattern).",
  reference: "https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/",
};
