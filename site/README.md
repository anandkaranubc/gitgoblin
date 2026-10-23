# gitgoblin website

The public site for gitgoblin, served at <https://anandkaranubc.github.io/gitgoblin/>. A standalone [Astro](https://astro.build) app: plain HTML and CSS, one variable typeface, and a few lines of JavaScript for the theme toggle, the star count and the hero walkthrough.

```sh
npm install
npm run dev      # http://localhost:4321/gitgoblin/
npm run build    # writes dist/
npm test         # checks links, anchors and page metadata in dist/
npm run check    # type-checks components
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/pages/index.astro` | The front page |
| `src/content/docs/*.md` | Docs pages; `order` in the frontmatter sets the sidebar position |
| `src/components/Terminal.astro` | The scripted engine walkthrough in the hero |
| `src/lib/site.ts` | Repository owner and name, tagline, description, the `href()` base-path helper |
| `src/styles/global.css` | Design tokens, light and dark themes, type scale |
| `scripts/sync-brand.mjs` | Copies favicons and the social image from `../brand` into `public/` before dev and build |
| `scripts/check-dist.mjs` | The `npm test` checks |

Internal links go through `href()` so the site works under the `/gitgoblin` base path on GitHub Pages and at the root of a custom domain.

## Deploying

`.github/workflows/site.yml` builds and deploys on every push to `main` that touches `site/` or `brand/`, and builds without deploying on pull requests. It takes the public origin and base path from `actions/configure-pages`, so the same build works at `<owner>.github.io/<repo>` and behind a custom domain.

### Going live the first time

From the repository root, after the first commit exists:

```sh
gh repo create anandkaranubc/gitgoblin --public --source=. --remote=origin --push \
  --description "Finds open-source projects worth your time and turns what they need into a pull request a maintainer would be glad to merge" \
  --homepage https://anandkaranubc.github.io/gitgoblin/
gh api -X POST repos/anandkaranubc/gitgoblin/pages -f build_type=workflow   # Pages source: GitHub Actions
gh repo edit anandkaranubc/gitgoblin --add-topic open-source --add-topic contributions --add-topic developer-tools --add-topic ai-agents
gh run watch                                                                # the push already started the Website workflow
```

Then, in Settings, General, Social preview, upload `brand/social/preview.png`; GitHub has no API for it. The nav's star count appears on its own once the repository is public.

For a custom domain, add `public/CNAME` with the domain and set it in Settings, Pages; the workflow picks up the new origin and base path automatically.

## Keeping it honest

The site describes the design and marks what exists. When a package becomes usable, update `src/content/docs/status.md` and the front page's "Try it today" section in the same change.
