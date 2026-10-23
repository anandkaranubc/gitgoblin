# @gitgoblin/sources

One shared way to talk to GitHub and ecosyste.ms: cached, rate-limit aware,
and polite. Every network call in gitgoblin should go through here so the
whole tool shares one budget and one cache.

```ts
import { createSources } from "@gitgoblin/sources";

const sources = await createSources();          // token + SQLite cache resolved for you
const { github, ecosystems } = sources;

const search = await github.searchRepositories("language:rust good-first-issues:>0", { sort: "updated" });
const repo = await ecosystems.lookupRepository({ host: "github.com", owner: "BurntSushi", name: "ripgrep" });
sources.close();
```

## HttpClient

`HttpClient` wraps `fetch` and is the only thing that touches the network.

| Behaviour | Detail |
| --- | --- |
| Caching | Responses are stored with a per-request TTL. Fresh entries never hit the network. |
| Revalidation | Stale entries are re-requested with `If-None-Match`; a `304` refreshes them for free. |
| Negative caching | `404`s are remembered (shorter TTL) so unknown repositories are not re-asked. |
| Rate limits | `429`, and GitHub's `403` with `x-ratelimit-remaining: 0` or `retry-after`, trigger one wait of up to 30 s, otherwise a `RateLimitError` with `resetAt`. |
| Retries | Network errors and `5xx` retry twice with backoff, then fall back to a stale copy if one exists. |
| Concurrency | At most 4 in-flight requests per host. |
| Body limit | Responses over `maxBodyBytes` (32 MiB) are dropped mid-stream and reported as an `HttpError`, never buffered or cached. |
| Self-healing | A cached body that no longer parses as JSON is discarded and fetched again. |
| Observability | `onEvent` reports hits, misses, revalidations, retries, waits, discarded entries and the cache fallback; `rateLimits()` exposes the latest headers per host and resource. |

Caches implement `HttpCache`. `SqliteCache` uses Node's built-in `node:sqlite`
(no native build), gzips bodies, drops entries that expired more than a week
ago each time it opens, and evicts the oldest entries past `maxBytes`
(512 MiB). A row it cannot decode is treated as a miss and deleted.
`MemoryCache` is for tests and one-off scripts.

The on-disk cache lives at `$GITGOBLIN_CACHE_DIR/http-cache.sqlite`, else
`$XDG_CACHE_HOME/gitgoblin/`, else `~/.cache/gitgoblin/`, created readable by
the current user only (the responses are whatever the token could see). When
that location cannot be opened, `createSources` falls back to a memory cache and
reports a `cache-fallback` event rather than failing. Tokens are never stored.

## GitHubClient

- `rest(path, { params, ttlMs })`: any REST endpoint, parsed as JSON.
- `graphql(query, variables, { ttlMs })`: GraphQL, returns `data` (partial data with errors included), throws `GraphQLError` when nothing came back and `RateLimitError` when the GraphQL budget is exhausted; an errors-only answer is never kept in the cache. Needs a token.
- `searchRepositories(q, { sort, order, perPage, page })` → `RepoFacts[]` plus total.
- `getRepository(ref)` → `RepoFacts | undefined`.
- `repoDetails(refs)`: one GraphQL request per 20 repositories returning contributing guide, code of conduct, templates, open starter issues (with samples), merged pull requests, commit count and last commit, releases. Needs a token.
- `rateLimits()`: `{ core, search, graphql }` with `remaining`, `limit`, `resetAt`.

Tokens come from `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`
(`resolveGitHubToken`). Without one, GitHub allows 60 REST calls per hour and
10 searches per minute, and GraphQL is unavailable.

## EcosystemsClient

[ecosyste.ms](https://ecosyste.ms) indexes repositories across ~100 forges and
every major package registry, with no authentication, at 5000 requests per hour per IP.

- `lookupRepository(ref)`: stars, topics, license, commit statistics (committers, development distribution score), community files found, funding, OpenSSF Scorecard.
- `lookupPackages(ref)`: packages published from the repository with dependents, downloads, keywords and registry rankings.
- `lookupIssueStats(ref)`: issue and pull request counts and average time to close, all-time and past year.

Responses are cached for a day. GitHub and GitLab use the direct host routes;
other forges go through the generic URL lookup.

## Testing

Inject `fetch` and a `MemoryCache`; see `test/helpers.ts` for a recording stub
and a virtual clock. Fixtures under `test/fixtures/` are trimmed real responses.
