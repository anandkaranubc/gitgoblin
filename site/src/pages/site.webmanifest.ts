import type { APIRoute } from "astro";
import { href, siteName, description } from "../lib/site";

export const GET: APIRoute = () => {
  const manifest = {
    name: siteName,
    short_name: siteName,
    description,
    start_url: href("/"),
    display: "browser",
    background_color: "#f4f1e6",
    theme_color: "#10140f",
    icons: [
      { src: href("/icon-192.png"), sizes: "192x192", type: "image/png" },
      { src: href("/icon-512.png"), sizes: "512x512", type: "image/png" },
    ],
  };
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: { "Content-Type": "application/manifest+json" },
  });
};
