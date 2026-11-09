import type { APIRoute } from "astro";
import { pagePath, publishedPages, site } from "../utils/discovery";

export const GET: APIRoute = async () => {
  const pages = await publishedPages();
  const text = [
    "# Osprey Wiki: published article text",
    "",
    "Generated from the current wiki source at publish time. Each article's canonical URL is included below.",
    ...pages.map((entry) => [
      "",
      "---",
      "",
      `# ${entry.data.title}`,
      "",
      `Canonical URL: ${site}${pagePath(entry.id)}`,
      "",
      entry.body ?? "",
    ].join("\n")),
  ].join("\n");
  return new Response(`${text}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
