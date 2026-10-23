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

The repository's Pages source is "GitHub Actions" and its social preview is `brand/social/preview.png`, uploaded by hand in Settings, General, because GitHub has no API for it. Upload it again whenever that image changes.

For a custom domain, add `public/CNAME` with the domain and set it in Settings, Pages; the workflow picks up the new origin and base path automatically.

## Keeping it honest

The site describes the design and marks what exists. When what works changes, update `src/content/docs/status.md`, the front page's "Try it today" and FAQ, and `src/pages/llms.txt.ts` in the same change as the README's "What works today" table.
