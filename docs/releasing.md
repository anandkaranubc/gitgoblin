# Releasing

gitgoblin publishes two packages to npm, each with its own version and tag:

| Package | Source | Tag | Installs as |
| --- | --- | --- | --- |
| `gitgoblin` | `packages/cli` | `v<version>` | `npm install -g gitgoblin` |
| `@gitgoblin/mcp` | `packages/mcp` | `mcp-v<version>` | `npx -y @gitgoblin/mcp` |

The other packages (`core`, `sources`, `discovery`, `intel`, `engine`) are not published. Each published package bundles them into plain JavaScript when it is packed, along with a `THIRD_PARTY_NOTICES.md` for the code it inlines.

Versions follow [Semantic Versioning](https://semver.org). Before 1.0, a patch release fixes things and a minor release may change behavior. [CHANGELOG.md](../CHANGELOG.md) records every release.

## How a release works

Pushing a tag starts [.github/workflows/release.yml](../.github/workflows/release.yml). Every step that makes something public waits for a person.

1. **Build and check.** The workflow checks that the tag is on `main`, that it matches the package's version, and that CHANGELOG.md has a dated section for it. Then it runs the type check, tests and docs check, packs the package (plus the `.mcpb` bundle for the MCP server), installs the tarball into an empty prefix and runs it (the MCP server must answer an `initialize` request), and writes `SHA256SUMS`. A separate job, which runs no third-party code, signs a [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations) for every file.
2. **Draft release.** It creates a draft GitHub release with those files, using the CHANGELOG section as the notes. Nobody sees a draft until the maintainer publishes it.
3. **npm.** After the draft exists and the maintainer approves the job in the `npm` environment, it checks the files against `SHA256SUMS` and publishes the same tarball it built. npm records provenance that links the package to the workflow run.

The build also fails on a high-severity advisory in a runtime dependency (`npm audit --omit=dev --audit-level=high`). Dependencies that are only used to build or test are not checked there; Dependabot alerts cover them. Known build-only advisories, reviewed on 2026-10-23: `@anthropic-ai/mcpb` (which packs the `.mcpb` bundle) pulls in `node-forge` and `tmp` versions with advisories that have no upstream fix. They matter only to an interactive or signing use of that tool, and the release job runs it non-interactively on files it just built.

To rehearse without a tag, run the workflow by hand: **Actions → Release → Run workflow**, then pick the package. It builds and checks from any branch, and attests, drafts and publishes nothing.

## Cutting a release

1. **Prepare a pull request** titled `chore(release): gitgoblin 0.2.0` (or `@gitgoblin/mcp 0.2.0`). It should:
   - Bump `version` in the package's `package.json`, plus the places that repeat it. For the CLI that is `.version()` in `packages/cli/src/index.ts`; a test fails if the two differ. For the MCP server it is `src/version.ts` and `bin/gitgoblin-mcp.mjs`. Install URLs and the plugin manifests name a release tag that does not exist yet, so they move in step 7.
   - Turn the CHANGELOG section's heading from `## gitgoblin 0.2.0 - Unreleased` into `## gitgoblin 0.2.0 - <today>`. Write it for users: what they can do now, what changed, what to watch out for.
2. **Merge it**, then tag the merge commit and push the tag:

   ```sh
   git fetch origin
   git tag -a v0.2.0 -m "gitgoblin 0.2.0" origin/main
   git push origin v0.2.0
   ```

3. **Watch the run.** If a check fails, fix it on `main` and tag again with a new patch version. A tag that has been pushed is never moved or reused.
4. **Read the draft release**, then approve the **Publish to npm** job.
5. **Verify** what was published: that npm serves the bytes the workflow attested, and that it runs.

   ```sh
   npm pack gitgoblin@0.2.0
   gh attestation verify gitgoblin-0.2.0.tgz --repo anandkaranubc/gitgoblin \
     --signer-workflow anandkaranubc/gitgoblin/.github/workflows/release.yml
   npx -y gitgoblin@0.2.0 --version
   ```

6. **Publish the draft release.**
7. **MCP server only.** Open a pull request that points everything at the new release:
   - `packages/mcp/server.json`: its version, the `.mcpb` URL, and the SHA-256 copied from the published release's `SHA256SUMS`. The `.mcpb` is a zip whose hash changes with every build, so never use a hash from a local rebuild.
   - The version in the two `.claude-plugin` manifests, and the install URLs that name the tag, until the npm package is the documented install: `.mcp.json`, `docs/agents.md` (including the base64 Cursor link and the URL-encoded VS Code link), `skills/gitgoblin/SKILL.md`, the README, and the site's front page and getting-started page. `git grep -n mcp-v<old version>` finds them.

   Merge it, then run **Actions → MCP Registry → Run workflow**. Fill in `deprecate` with the previous version when it has a known defect.

## One-time setup

The maintainer does this once, before the first release. None of it can be done from a pull request.

1. **npm.** Use an npm account with two-factor authentication. Create the free npm organization `gitgoblin`, which owns the `@gitgoblin` scope. Until the scope and the `gitgoblin` name are claimed, anyone could register them, which is why the docs never tell people to run `npx -y` against either name yet.
2. **Tags.** Add a tag ruleset (**Settings → Rules → Rulesets → New tag ruleset**) for `refs/tags/v*` and `refs/tags/mcp-v*` that restricts creations, updates and deletions, with only the maintainer allowed to bypass. Releases can then only start from the maintainer, and a published tag cannot move. The workflow also refuses a tag that is not on `main`.
3. **The `npm` environment.** In **Settings → Environments**, create `npm`. Add yourself as a required reviewer and limit deployment to tags matching `v*` and `mcp-v*`.
4. **Turn publishing on.** In **Settings → Secrets and variables → Actions → Variables**, set `NPM_PUBLISH` to `true`. Until then, the workflow drafts releases and never publishes. This makes sure step 3 is done first.
5. **First publish of each package.** npm can only set up trusted publishing for a package that already exists, so the first version of each package needs a token. The first npm release of `@gitgoblin/mcp` needs a version that has no `mcp-v` tag yet, so 0.1.5 or later (0.1.4 was withdrawn after its GitHub release). Either:
   - create a granular access token with read and write access to all packages (a package that does not exist yet cannot be selected), tick **Bypass two-factor authentication** so a workflow can use it, and pick the shortest expiry. Add it as the secret `NPM_TOKEN` *on the `npm` environment*, not the repository. Push the tag, approve, then delete the secret and revoke the token; or
   - reject the waiting npm job, run `npm login`, download the tarball from the draft release, check it against `SHA256SUMS`, and run `npm publish ./<file>.tgz --access public` yourself. This version has no provenance.
6. **Trusted publishing.** Add one for each package no more than two days before the next release: a trusted publisher whose first publish does not come within two days expires and has to be recreated. On npmjs.com, open the package's **Settings → Trusted publishing** and add GitHub Actions with owner `anandkaranubc`, repository `gitgoblin`, workflow `release.yml` and environment `npm`. Allow `npm publish`, which the workflow runs; new configurations only allow `npm stage publish` by default. Or from the command line (`npm trust` needs a recent npm; 11.19 has it):

   ```sh
   npm trust github gitgoblin --file release.yml --repo anandkaranubc/gitgoblin --env npm --allow-publish
   ```

   Then set **Publishing access** to "Require two-factor authentication and disallow tokens". From then on, releases need no secret at all.

## When a release is bad

npm does not let you take a version back once others may depend on it, so fix forward:

- **Publish a fixed patch release** as soon as you can.
- **Deprecate the bad version** so installs warn: `npm deprecate gitgoblin@0.2.0 "Broken install on Linux; use 0.2.1"`.
- **If there is no fix yet**, point `latest` back at the previous good version: `npm dist-tag add gitgoblin@0.1.0 latest`.
- **Edit the GitHub release** so it starts with a warning that names the replacement. Do not delete the release or the tag; people link to both.
- **For the MCP server**, run the MCP Registry workflow with `deprecate` set to the bad version.

For a security problem, follow [SECURITY.md](../SECURITY.md): fix it in a private security advisory, release, then publish the advisory with credit to the reporter.
