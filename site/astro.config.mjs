// @ts-check
import { defineConfig, fontProviders } from "astro/config";
import sitemap from "@astrojs/sitemap";

// The Pages workflow sets SITE_URL and BASE_PATH from actions/configure-pages,
// so one build serves both <owner>.github.io/<repo> and a custom domain.
const site = process.env.SITE_URL ?? "https://anandkaranubc.github.io";
// configure-pages gives an empty base path for custom domains.
const base = process.env.BASE_PATH === undefined ? "/gitgoblin" : process.env.BASE_PATH || "/";

const fontsource = "./node_modules/@fontsource-variable";

// Typefaces per brand/README.md: Bricolage Grotesque for headings, Recursive
// Sans Linear for body text, Recursive Mono for code. Self-hosted, latin subset.
export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  integrations: [sitemap()],
  fonts: [
    {
      name: "Bricolage Grotesque",
      cssVariable: "--font-display",
      provider: fontProviders.local(),
      options: {
        variants: [
          {
            src: [`${fontsource}/bricolage-grotesque/files/bricolage-grotesque-latin-opsz-normal.woff2`],
            weight: "200 800",
            style: "normal",
          },
        ],
      },
      fallbacks: ["Helvetica Neue", "Arial", "sans-serif"],
    },
    {
      name: "Recursive",
      cssVariable: "--font-sans",
      provider: fontProviders.local(),
      options: {
        variants: [
          { src: [`${fontsource}/recursive/files/recursive-latin-wght-normal.woff2`], weight: "300 1000", style: "normal" },
        ],
      },
      fallbacks: ["system-ui", "sans-serif"],
    },
    {
      name: "Recursive Mono",
      cssVariable: "--font-mono",
      provider: fontProviders.local(),
      options: {
        variants: [
          { src: [`${fontsource}/recursive/files/recursive-latin-mono-normal.woff2`], weight: "300 1000", style: "normal" },
        ],
      },
      fallbacks: ["ui-monospace", "Menlo", "monospace"],
    },
  ],
});
