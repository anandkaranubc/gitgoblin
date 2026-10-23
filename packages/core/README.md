# @gitgoblin/core

Shared contracts for every gitgoblin component. No runtime dependencies.

If two packages need to agree on a shape, it lives here. Everything else
(HTTP clients, scoring, CLIs) lives in the package that owns the behaviour.

## Repository identity

```ts
import { parseRepoRef, repoId, repoUrl, type RepoRef } from "@gitgoblin/core";

const ref: RepoRef = { host: "github.com", owner: "BurntSushi", name: "ripgrep" };
repoId(ref);  // "github.com/burntsushi/ripgrep"  (lowercase, use as a map key)
repoUrl(ref); // "https://github.com/BurntSushi/ripgrep"

parseRepoRef("rails/rails");                                  // github.com by default
parseRepoRef("https://gitlab.com/inkscape/inkscape/-/issues"); // URLs, with or without .git
parseRepoRef("git@codeberg.org:forgejo/forgejo.git");          // ssh remotes
parseRepoRef("not a repo");                                    // undefined
```

`host` is always a hostname, never an enum, so self-hosted forges work without
code changes. `normalizeHost` expands shorthand like `"github"`.

`RepoFacts` extends `RepoRef` with what a host reports: description, topics,
language, license (SPDX), stars, forks, open issues, timestamps, archived and
fork flags. Optional fields mean *unknown*, not *absent*.

## Discovery contract

- `Goal`: `contribute`, `learn`, `adopt`, `revive`, `explore`. `GOAL_DESCRIPTIONS` says what each optimizes for.
- `Signals`: normalized 0..1 values named in `SIGNAL_NAMES` (`activity`, `responsiveness`, `busFactor`, `newcomerFriendliness`, `docs`, `maturity`, `popularity`, `usage`, `momentum`, `license`). A missing signal is unknown, never zero.
- `Evidence`: the raw facts behind the signals (days since push, contributor count, dependents, starter issues...), kept so every result can be audited.
- `Reason`: `{ signal, weight, detail }`. Positive weight helped the score, negative hurt it, zero means observed but not weighted for this goal.
- `DiscoveryQuery` and `DiscoveryResult`: the input and output of discovery.
- `Discoverer`: the one-method interface (`discover(query)`) that CLIs, web apps and agents depend on instead of a concrete engine.

Other components should consume `DiscoveryResult` and pass `toRepoRef(result.repo)`
downstream. Producer-owned types (repository profiles, contribution
opportunities, run results) belong to the packages that produce them.

## Stability

These types are pre-1.0. Additive changes (new optional fields, new signals)
are expected; renames and removals will be called out in the changelog.
