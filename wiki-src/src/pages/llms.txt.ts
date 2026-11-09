import type { APIRoute } from "astro";
import { categories, pagePath, publishedPages, site } from "../utils/discovery";

export const GET: APIRoute = async () => {
  const pages = await publishedPages();
  const lines = [
    "# Osprey Wiki",
    "",
    "> The official Osprey Minecraft server wiki, maintained by the Osprey admins.",
    "",
    "Use the current wiki articles for mechanics and rules. This directory is regenerated whenever the wiki is published.",
    "",
    `- [Wiki home](${site}/wiki/)`,
    `- [Full wiki text](${site}/wiki/llms-full.txt): published article text with canonical page URLs`,
    `- [Wiki sitemap](${site}/wiki/sitemap-index.xml)`,
  ];
  for (const [key, label] of categories) {
    const entries = pages.filter((page) => page.id.startsWith(`${key}/`));
    if (!entries.length) continue;
    lines.push("", `## ${label}`, "");
    for (const entry of entries) {
      const description = entry.data.description?.replace(/\s+/g, " ").trim();
      lines.push(`- [${entry.data.title}](${site}${pagePath(entry.id)})${description ? `: ${description}` : ""}`);
    }
  }
  return new Response(`${lines.join("\n")}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
