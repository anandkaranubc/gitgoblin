# Changelog

What changed in each release of the two packages gitgoblin publishes: the `gitgoblin` command
(tags `v<version>`) and the `@gitgoblin/mcp` server (tags `mcp-v<version>`). Newest first. Versions
follow [Semantic Versioning](https://semver.org); before 1.0, a minor version may change behavior.
[docs/releasing.md](docs/releasing.md) says how a release is made.

## gitgoblin 0.1.4 - Unreleased

**Safety**

- The agent's own shell no longer writes to the shared temp directories, where
  a `screen` or `tmux` server keeps the FIFO or socket it takes commands from, or to the one every
  Claude Code session of yours shares (`/tmp/claude-<uid>`). It gets the run's temp directory and a
  short one of its own that is removed when the run ends. This closes the gap 0.1.3 left open.
- `contribute` checks a change for edited test and build configuration, CI workflows, secret files
  and binary files by name, and a renamed file or a name with non-ASCII letters slipped past those
  checks. Moving `tests/helpers.py` to `tests/conftest.py`, or adding `tests/ünï/conftest.py`, let
  the agent's code run on your machine in the verification step; `.github/workflows/rélease.yml`, a
  `.env` made by renaming, or an image named `ïmage.png` went through unflagged. Both names of a
  renamed file are now checked, and every name as it is on disk.

**Other changes**

- `explain`, `--like` and the discovery hints `analyze` and `contribute` use no longer describe
  the GitHub repository with the same owner and name when given a GitLab or Codeberg one: `explain`
  and `--like` say they read GitHub only, and `analyze` goes without hints. Commands `gitgoblin`
  suggests for such a repository keep its host, so they no longer point at GitHub.
- A connection to GitHub or ecosyste.ms that broke off, or hit the 20-second timeout, while a
  response was still arriving failed the request at once. It is now retried like any other network
  failure, and an earlier cached answer is used if the retries fail too. The limit of four requests
  at a time per host also holds again: a request arriving as another finished could go past the queue.
- When GitHub's answer for a batch of repositories left some out (it does this when a query hits
  its resource limits), discovery dropped their starter issues and other details for an hour,
  because the incomplete answer stayed cached. It now asks for each missing repository on its own
  once and does not cache the incomplete answer. A repository's last merge is also the latest
  merge now, not the merge of the pull request someone commented on most recently.
- `contribute` stops for a person when the agent says its change is not finished, instead of
  preparing a pull request because the checks passed and the reviewer approved the half-done work.
- The run's time limit holds: no agent session starts once the run is past it, and an agent
  session that resumes after a dropped connection, or wraps up after running out of turns, gets
  what is left of its time rather than starting the clock again.
- `gitgoblin-engine publish` asks for confirmation with the title publishing sends (the one in
  `delivery.json`), not the one in `pr-title.txt`, which publishing does not read.
- Files the project's install and test commands leave behind that the repository does not ignore,
  such as Python's `__pycache__`, coverage reports or `.tsbuildinfo`, are no longer added to the
  change. Before, a Python project without `__pycache__` in its `.gitignore` stopped a correct fix
  with "adds binary files", and text output could be committed without a word. Checks also run with
  `PYTHONDONTWRITEBYTECODE=1`.
- `gitgoblin-engine publish` no longer refuses with "uncommitted changes: ?? node_modules/" in a
  repository that does not ignore `node_modules`, or over the files above.
- Cleaning a run whose setup failed after cloning (an empty repository, a failed checkout) now
  removes the clone.
- Repository names that start with a dot or an underscore, or end with an underscore (such as
  `microsoft/.github` or `octo/_site`), are accepted. A GitLab project in a subgroup
  (`gitlab.com/group/subgroup/project`) is refused with a clear error. Before, its URL was read as
  the project named after the subgroup, a different repository or none.
- Hosts written as numbers in hex or octal (`0x7f.1`, which is 127.0.0.1) are refused like any
  other IP address, so `analyze` and `contribute` cannot be pointed at your own machine or network
  that way.
- Discovery for the `revive` goal finds archived projects again. Its searches asked GitHub for
  unarchived repositories only, so archived projects, which revive means to suggest for forking,
  never came back.
- `discover --limit` above 48 shows 48 results and says so. Before, it showed 48 without a word,
  although the help said up to 100. Only the 48 most promising candidates get the full lookups.

## gitgoblin 0.1.3 - 2026-10-29

Upgrade from 0.1.0 and 0.1.1: both let a repository's commands get around the sandbox in the
ways listed under Safety. 0.1.2 was tagged but never published: its release build stopped on a
test that could not load without an OS sandbox. This is the same release.

**Safety**

- On macOS, the repository's commands could leave the sandbox, in strict isolation too, by
  sending a command to a tmux or screen server through its socket or FIFO in `/tmp` or the per-user
  temp directory; those servers run it as you, outside any sandbox. The commands now get a temp
  directory of their own in the run directory (`TMPDIR`), and the shared ones are read-only to
  them, except the store locks pnpm keeps in `/tmp`. Linux already gave them an empty `/tmp`.
- The repository's install and test commands no longer receive a Claude login token set in
  `CLAUDE_CODE_OAUTH_TOKEN`, and cannot read Claude's configuration directory (`~/.claude`, or the
  one `CLAUDE_CONFIG_DIR` names), whose settings can hold keys, or the credential files that
  `GOOGLE_APPLICATION_CREDENTIALS` and the AWS and Azure variables point at. The agent's own shell
  hides the same logins, the macOS keychains among them, and no longer sees Bedrock, Vertex or
  Foundry keys.
- The repository's commands can no longer reach other programs' Unix sockets. Before, code
  in a repository could talk to Docker's daemon (and through it start a container with your disk
  mounted) or to your SSH agent, despite the OS sandbox. Sockets the commands create in their own
  writable places still work, so builds that use tsx or turbo's daemon no longer fail on macOS with
  `listen EPERM`.
- A repository command could swap a folder it may write (a package cache such as `~/.npm`)
  for a link to any other folder, and the next command's sandbox let it write there too, the home
  directory included. Writable folders are now resolved only through links the system owns, so a
  link a command made never widens what the next one may touch. A cache folder you made a link
  yourself is no longer writable to the repository's commands.
- The diff `contribute` shows before you publish, the one its reviewer reads and the one
  scanned for secrets show every changed file's content. Before, a file the repository marks `-diff`
  in `.gitattributes` (often `dist/` and lockfiles), or any file with a NUL byte in it, appeared as
  "Binary files differ" while its full content was committed and pushed. An external diff tool set
  in your git config no longer replaces it either. A change that adds or edits a real binary file
  (an image, an archive) now stops for you before the checks run, instead of going to the reviewer.
- On macOS, the repository's commands can no longer open apps (`open x.command` starts
  Terminal outside the sandbox) or drive them with Apple events.
- Still open: on macOS, the agent's own shell (inside the Claude Agent SDK's sandbox) can still
  write to the shared temp directory, where a `screen` session keeps its FIFO. Until that is fixed,
  close `screen` sessions while `contribute` runs.

**Other changes**

- When a project's tests already fail before the change, `contribute` no longer takes "also fails on
  the base commit" at face value: it reads the test runner's summary (vitest, jest, pytest, mocha,
  web-test-runner, node's test runner and TAP, bun, cargo, go, RSpec, PHPUnit) and treats more failing
  tests, or fewer passing ones, as a regression. The pull request shows both counts. A suite that
  reported results before the change and none after it (a module that no longer loads, a compile
  error) is a regression too, and so is an output too long to keep whole whose kept end already
  shows more failures.
- Each check's whole output is saved in the run directory (`check-baseline-<check>.txt`,
  `check-verify-<n>-<check>.txt`), and the excerpt kept in the run's files and shown to the agent
  now holds the start of the output as well as the end, so the first error survives a long log.
- `clean` keeps a published run's workspace while it holds changes or commits that were not
  published, such as answers to review comments, and says so; `--force` discards them. Before,
  `clean --finished`, which `runs` suggests, deleted them without asking.
- `discover contribute` gets each repository's GitHub details again (starter issues, contributing
  guide, recent merges). It asked for 20 repositories per request, which GitHub timed out on with
  HTTP 502, and one failed request dropped the details of every candidate. It now asks for 10 at a
  time, splits a request GitHub cannot finish, and keeps what it fetched.
- `analyze` ranks a failing CI workflow that needs the repository's secrets and never runs on pull
  requests (a publish or sync job) as one only maintainers can verify, and says so first, instead
  of putting it at the top. One failed run is reported as a single failure, not as "failing since".
- `analyze --llm` asks about one issue per call, so text in one issue cannot sway the verdict on
  another, and uses a review only when its supporting quote is really in the issue. It stops at the
  first timeout or server error instead of retrying each issue, and the report says how many issues
  went unreviewed.
- On GitLab, `analyze` no longer offers an issue as untouched when GitLab counts merge requests for
  it that could not be read; it says to check them first. Large Gitea and Forgejo repositories get
  the same shallow clone as large GitHub ones.
- `analyze` ranks issues closer to what outsiders actually fix: long discussions and issues open
  for over two years rank lower, documentation issues higher, and comment count no longer adds
  value. In a backtest on 27 repositories the new order put more outsider-fixed issues in each
  repository's top five.
- `contribute` also stops for you before running checks when the change edits build logic beyond
  the main build files: pieces they pull in (`*.mk`, `*.cmake`, `*.gradle`, Bazel `*.bzl` and
  `*.bazelrc`), Gradle's `buildSrc` and `build-logic`, Bazel's `tools/bazel`, Makefiles by other
  names and autotools' `configure` and `Makefile.am`.

## gitgoblin 0.1.1 - 2026-10-24

- `contribute --install-browsers` downloads the browsers a project's Playwright test suite needs,
  with the project's own Playwright, after the install; the run says when the tests need them.
  0.1.0 offered this only through `gitgoblin-engine run --install-browsers`.
- `contribute` warns before its first question when a launcher the project's commands need (`bun`,
  `cargo`, `pnpm` and the like) is not installed, instead of failing at the install after cloning.
- `discover` prints its warnings (a refused search, GitHub details that could not be read) on stderr
  even when progress is hidden, so a ranking in a pipe or script is not silently partial.
- The npm page now opens with how to install and run the command from npm, instead of how to run
  it from a clone of the repository.
- `analyze` gives Bun projects `bun run build` and `bun run test`, not Bun's own bundler and test
  runner, and no longer invents `tsc --noEmit` for a TypeScript project without a root
  `tsconfig.json`. Before, `contribute` could start with two failing checks the project never had.

## @gitgoblin/mcp 0.1.8 - Unreleased

- A connection to GitHub or ecosyste.ms that broke off, or hit the 20-second timeout, while a
  response was still arriving failed the request at once. It is now retried like any other network
  failure, and an earlier cached answer is used if the retries fail too. The limit of four requests
  at a time per host also holds again: a request arriving as another finished could go past the queue.
- When GitHub's answer for a batch of repositories left some out (it does this when a query hits
  its resource limits), discovery dropped their starter issues and other details for an hour,
  because the incomplete answer stayed cached. It now asks for each missing repository on its own
  once and does not cache the incomplete answer. A repository's last merge is also the latest
  merge now, not the merge of the pull request someone commented on most recently.
- Repository names that start with a dot or an underscore, or end with an underscore (such as
  `microsoft/.github` or `octo/_site`), are accepted. A GitLab project in a subgroup
  (`gitlab.com/group/subgroup/project`) is refused with a clear error. Before, its URL was read as
  the project named after the subgroup, a different repository or none.
- Discovery for the `revive` goal finds archived projects again. Its searches asked GitHub for
  unarchived repositories only, so archived projects, which revive means to suggest for forking,
  never came back.

- The discover tool gets each repository's GitHub details again (starter issues, contributing guide,
  recent merges). GitHub timed out on its requests for 20 repositories at a time with HTTP 502, and
  one failed request dropped the details of every candidate; it now asks for 10 at a time, splits a
  request GitHub cannot finish, and keeps what it fetched.
- The analyze tool's build and test commands for Bun projects run the project's scripts, and it no
  longer invents a TypeScript check when the repository root has no `tsconfig.json`.
- A failing CI workflow that needs repository secrets forks do not get is no longer ranked as an
  easy fix for outsiders, and a single failed run is not called a failing streak.
- On GitLab, an issue with merge requests that could not be read is no longer offered as untouched,
  and large Gitea and Forgejo repositories are cloned shallowly like large GitHub ones.
- The analyze tool ranks issues closer to what outsiders fix: long discussions and issues open
  for over two years rank lower, documentation issues higher.
- The discover tool's `like` repository goes through the same public-only check as every other
  repository. Before, discovery read it with the person's token, so a private repository's
  description could reach the search queries and its name ecosyste.ms.
- A running analysis stops when the server stops. Before, when the client closed the server or
  it was terminated, an analysis still in progress kept running on its own, with its git, and a
  stuck one kept a CPU core busy until killed by hand.
- Two analyses of the same repository at once, from one server or two, no longer clone into the
  same directory; the second waits for the first. Before, one of them failed with git's "File
  exists" or "destination path already exists" error.
- The discover tool says when its ranking may be partial: refused searches and failed lookups are
  listed after the results and in a `warnings` field. Before, they went only to the server's log.
- The briefing tool finds a stale pull request by its number (`issue_number: 663` for "Revive PR
  #663"). Before, only issue numbers matched.

- The `gitgoblin contribute` command a briefing suggests for a GitLab or Codeberg repository keeps
  its host, so it no longer points at the GitHub repository with the same name.
- The discover tool searches public repositories only and refuses filter words that are GitHub
  search syntax (`is:private`, `user:` and the like). Before, a keyword such as `is:private` ran as
  part of a search made with the person's token, and each private repository it found was looked up
  on ecosyste.ms by name before the public check left it out of the results.

## gitgoblin 0.1.0 - 2026-10-24

The first release of `gitgoblin`: find open-source work worth doing, check the evidence, and prepare
a pull request a maintainer would want to merge.

**Find and understand**

- `discover` ranks public GitHub repositories for a goal (`contribute`, `learn`, `adopt`, `revive`,
  `explore`), filtered by language, topic, stars, license, recency or similarity to a repository you
  name, and says why each one ranked where it did. `explain` shows every signal behind one score,
  including the share of pull requests the project merges (`acceptance`), which in backtests
  predicted whether a newcomer's pull request would be merged better than stars did; `goals` lists
  what each goal weighs. `discover --json` includes the warnings about refused or rate-limited
  searches, so a script can tell a partial ranking from a complete one.
- `analyze` profiles a repository (what it is, how active it is, how it treats outside
  contributors, how to build and test it, its conventions) and lists opportunities, each with
  evidence you can check. It reads GitHub, GitLab and Gitea or Forgejo, Codeberg among them; other
  git hosts get a clone-only analysis, and comments a forge hides without a token count as unknown.
- `analyze` double-checks itself: an issue whose quoted code is gone, or that a later commit cites,
  is marked as possibly fixed; a dependency update an open pull request already makes is skipped;
  generated files and code that only quotes a pattern are not reported. `--llm` adds a second
  opinion from Claude on issue triage; it is off by default, needs an API key and costs money.
- `analyze` reads public repositories only, and runs git without your own git configuration (no
  credential helpers, LFS downloads, hooks or transports other than https), so a repository you
  analyze cannot use your setup. Clones are kept per host, so a same-named repository elsewhere
  cannot stand in for the one you asked for.
- The install command `analyze` reports installs what the project declares for development (PEP 735
  dependency groups or real extras, not an assumed `.[dev]`) and installs from a committed lockfile
  without rewriting it (`npm ci`, `pnpm install --frozen-lockfile`, and the yarn and bun equivalents).

**Contribute (experimental)**

- In a monorepo whose root has no test script, `analyze` reports the test command of the workspace
  packages that have one (`npm test -w packages/x`, or every workspace through the package manager).
- `contribute` has an AI agent investigate, plan, implement and verify one opportunity in a local
  clone, gets an independent review, and prepares a pull request written for the maintainers who
  will read it. It asks before running the agent, before implementing the plan and before
  publishing; nothing is pushed or posted until you type `publish` at that last question, and keys
  pressed before a question appears are discarded, so a `y` typed ahead cannot answer it.
- The opportunity picker marks the ones the engine would refuse (`!`, dependency bumps among them:
  the agent works offline and cannot regenerate a lockfile, so it stops before spending anything)
  and the ones intel doubts (`?`), and Enter skips both. Once one is chosen, `contribute` says which of
  the project's own commands will check the change, and warns when there is no test command. `runs`, `show` and `publish` come back to prepared changes later;
  `publish` can be run again after a partial failure, and `clean` frees the disk a finished run's
  clone takes while keeping its report and diff.
- Files the repository's own install rewrites (a lockfile npm trims, say) are put back as committed
  before anything else runs, so a prepared change never carries that churn; the run report names them.
- Projects that test in real browsers through Playwright: the run says when the tests need
  Playwright's browsers, and `gitgoblin-engine run --install-browsers` downloads them with the
  project's own Playwright, allowing Playwright's download servers for that step only.

**Safety**

- Repository content is treated as untrusted: reads stay inside the clone, link checks reach only
  public addresses, and every parser of issue, README and source text runs in linear time, so a
  crafted file cannot stall it.
  Everything the command prints that came from outside (repository descriptions, issue titles,
  registry data, the agent's progress and messages, run files, errors) has escape sequences and
  invisible control characters removed, so it cannot rewrite the terminal or set the clipboard.
- The repository's own install and test commands run in an OS sandbox (`sandbox-exec` on macOS,
  `bwrap` on Linux when installed): tests run offline, and the install reaches package registries
  only, through your `HTTPS_PROXY` if you use one; `contribute --install-network open` allows any
  host, and a refused host is named with that flag when an install fails. `--check-isolation strict`,
  for repositories you do not trust, also hides your home directory from them.
- On macOS the repository's commands cannot open your terminals, so they cannot type into or read
  from your other tabs; progress lines and prepared pull requests carry no escape sequences or
  invisible characters.

**Everyday use**

- Works without configuration; a GitHub token or a `gh` login raises rate limits and adds
  starter-issue data.
- The response cache, shared with the MCP server, never fails a command: when it is locked by
  another process, full or damaged, the answer comes from the network.
- Errors say what to do next: an unreachable network names the host and the cause, a certificate
  failure points at `NODE_EXTRA_CA_CERTS`, a missing repository is reported as not found, and an
  issue sample GitHub refused is reported instead of silently shortened.

**Requirements and known limits**

Node.js 24 or newer and git. `contribute` also needs the Claude Agent SDK, installed next to the CLI
(`npm install -g gitgoblin @anthropic-ai/claude-agent-sdk`), and an Anthropic API key or Claude Code
login, and runs on macOS or Linux only (on Windows, `discover` and `analyze` work); each run costs
money, capped by `--max-cost`. `discover`, `contribute` and `publish` work with GitHub only.
Opportunity scores are still being calibrated. `contribute` has so far prepared pull requests on one
real repository, on macOS, so treat what it prepares as a draft to review.

## @gitgoblin/mcp 0.1.7 - 2026-10-24

- Reads public repositories only. Each repository is confirmed public with an anonymous request
  to its forge before any work, and `discover_repositories` leaves out results it cannot confirm, so
  a token or credential helper that can see private repositories never exposes them.
- Each analysis runs in a child process with an empty home directory, so your git configuration and
  credential helpers never apply to a repository's clone. A timeout or a cancellation kills the
  child and everything it started, git included. At most two analyses run at once.
- Clones are kept per forge, and the least recently used are deleted beyond 20 per forge. Clones left by
  earlier versions are deleted. A clone that takes more than four minutes gives up with a clear error.
- Every result opens with a reminder that repository text is data, not instructions. Invisible
  format characters, including zero-width and Unicode tag characters, are stripped, and results are
  capped in size.
- Asking for an opportunity id that a recent analysis does not have answers from that analysis
  instead of running a new one.

## @gitgoblin/mcp 0.1.6 - 2026-10-23

- Analysis keeps every text parser linear on hostile input. A crafted README heading, issue or
  document can no longer make `analyze_repository` slow; until now one long heading line could keep
  an analysis busy for minutes. The five-minute limit from 0.1.5 stays as a backstop.

## @gitgoblin/mcp 0.1.5 - 2026-10-23

Replaces the withdrawn 0.1.4.

- Analysis parses issue text in linear time; 0.1.4 could stall for hours on a crafted issue body.
- Each analysis runs in its own worker thread and is stopped after five minutes or as soon as the
  client cancels the request, so a repository that makes analysis slow can no longer freeze the
  other tools.
- Everything 0.1.4 added stays: `analyze_repository` and `get_opportunity` read GitLab and Codeberg
  repositories, and the bundle tool is pinned in the lockfile.
- The bundle is back to about 2 MB: analysis now loads the Anthropic SDK only for its optional model
  review, which the server never turns on, so the SDK is no longer included.

## @gitgoblin/mcp 0.1.4 - 2026-10-23

**Do not install 0.1.4.** Its analysis includes a regular expression that can take minutes or hours on a crafted issue body, freezing `analyze_repository` for any repository with such an issue. Use 0.1.5.

- `analyze_repository` and `get_opportunity` read GitLab and Codeberg repositories again, now that
  analysis reads those forges through their own public APIs. Discovery and `explain_repository` still
  read GitHub only, and other hosts are still refused.
- The bundle is larger, about 3 MB, because analysis now includes the Anthropic SDK for an optional
  model review of issues. The server never turns that review on and makes no model calls.
- The tool that packs the `.mcpb` bundle is pinned in the lockfile instead of downloaded on each build.

## @gitgoblin/mcp 0.1.3 - 2026-10-23

- Reads github.com repositories only. Earlier versions also accepted gitlab.com and codeberg.org,
  but discovery and analysis look repositories up on GitHub by owner and name, so those requests
  were answered about whichever GitHub repository had the same name.
- The server instructions and the opportunity briefing tell the agent to disclose AI assistance in
  the pull request and to follow the project's policy on AI contributions.

## @gitgoblin/mcp 0.1.2 - 2026-10-23

- The package and the `.mcpb` bundle now carry gitgoblin's license and the notices of the
  third-party code they bundle. 0.1.1 shipped without them.

## @gitgoblin/mcp 0.1.1 - 2026-10-23

Security release; upgrade from 0.1.0.

- Treats the repository it analyzes as hostile, since your agent usually picks it: committed
  symlinks are checked out as plain files, git only speaks HTTPS, external links are no longer
  fetched, and repository hosts are limited to public forges.
- Strips control characters from results and tells the agent that repository text is data, not
  instructions.

## @gitgoblin/mcp 0.1.0 - 2026-10-23

First release: gitgoblin as a Model Context Protocol server with four read-only tools,
`discover_repositories`, `explain_repository`, `analyze_repository` and `get_opportunity`, plus an
agent skill and a Claude Code plugin. Do not install this version: `analyze_repository` follows
symlinks committed in the analyzed repository and can reach hosts on your network. Use 0.1.1 or later.
