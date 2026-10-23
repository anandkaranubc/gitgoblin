/** Facts the whole site shares. Change the repository here, nowhere else. */
export const repo = {
  owner: "anandkaranubc",
  name: "gitgoblin",
  get url() {
    return `https://github.com/${this.owner}/${this.name}`;
  },
};

export const siteName = "gitgoblin";
export const tagline = "digs up forgotten work. ships it.";

/** Matches the README's own words, so search results and social cards say what the repository says. */
export const description =
  "A free, open-source companion for contributing to other people's software. gitgoblin finds projects worth your time, works out what they really need, and turns that into a pull request a maintainer would be glad to merge. Nothing is published until you say so.";

/** Prefix an absolute site path with the configured base (e.g. /gitgoblin/). */
export function href(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}${path}`;
}
