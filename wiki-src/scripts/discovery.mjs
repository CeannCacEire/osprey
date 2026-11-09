// No article edits: add genuine Git modification dates and check generated discovery files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const origin = "https://osprey.build";
const sitemapPath = join(dist, "sitemap-0.xml");
let sitemap = readFileSync(sitemapPath, "utf8");
let dates = 0;
sitemap = sitemap.replace(/<url><loc>([^<]+)<\/loc>[\s\S]*?<\/url>/g, (block, url) => {
  const path = new URL(url).pathname;
  assert(path.startsWith("/wiki/"));
  const slug = decodeURIComponent(path.slice(6).replace(/\/$/, "")) || "index";
  const source = `src/content/docs/${slug}.md`;
  assert(existsSync(join(root, source)), `Sitemap entry has no article: ${url}`);
  const modified = execFileSync("git", ["log", "-1", "--format=%cI", "--", source], { cwd: root, encoding: "utf8" }).trim();
  if (!modified) return block; // Uncommitted new articles must not receive an invented date.
  assert(Number.isFinite(Date.parse(modified)), `Invalid Git date for ${source}`);
  dates++;
  return `<url><loc>${url}</loc><lastmod>${modified}</lastmod></url>`;
});
writeFileSync(sitemapPath, sitemap);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const pages = walk(dist).filter((path) => path.endsWith(".html") && !path.includes("/admin/") && !path.endsWith("/404.html"));
const directory = readFileSync(join(dist, "index.html"), "utf8");
const llms = readFileSync(join(dist, "llms.txt"), "utf8");
const full = readFileSync(join(dist, "llms-full.txt"), "utf8");
const titles = new Set();
for (const path of pages) {
  const html = readFileSync(path, "utf8");
  const canonicals = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)];
  assert.equal(canonicals.length, 1, `Expected one canonical: ${path}`);
  const url = canonicals[0][1];
  assert(url.startsWith(`${origin}/wiki/`) && url.endsWith("/"), `Bad canonical: ${url}`);
  assert(sitemap.includes(`<loc>${url}</loc>`), `Page missing from sitemap: ${url}`);
  assert(/<meta name="description" content="[^"]+"/.test(html), `Missing description: ${url}`);
  assert(/<meta name="robots" content="index, follow/.test(html), `Page not indexable: ${url}`);
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  assert(title && !titles.has(title), `Missing or duplicate title: ${url}`);
  titles.add(title);
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] || "null");
  assert(graph?.["@graph"]?.some((node) => node.url === url), `Invalid structured data: ${url}`);
  assert(full.includes(`Canonical URL: ${url}`), `Missing full-text article: ${url}`);
  assert(llms.includes(`](${url})`), `Missing AI-directory entry: ${url}`);
  if (url !== `${origin}/wiki/`) {
    assert(directory.includes(`href="${new URL(url).pathname}"`), `Missing home directory link: ${url}`);
  }
  // Both wiki-relative assets and root-site assets must exist before publishing.
  for (const match of html.matchAll(/(?:href|src)="(\/[^"#?]*)(?:[^"]*)"/g)) {
    const href = decodeURIComponent(match[1]);
    if (href.startsWith("//")) continue;
    let target = href.startsWith("/wiki/") ? join(dist, href.slice(6)) : join(root, "..", href.slice(1));
    if (href.endsWith("/")) target = join(target, "index.html");
    assert(existsSync(target), `Broken internal link or asset: ${url} -> ${href}`);
  }
}
assert(/noindex/.test(readFileSync(join(dist, "404.html"), "utf8")), "404 should not be indexed");
assert(/noindex/.test(readFileSync(join(dist, "admin/index.html"), "utf8")), "Admin should not be indexed");
assert.equal([...sitemap.matchAll(/<url>/g)].length, pages.length, "Sitemap contains unexpected pages");
console.log(`SEO checks passed: ${pages.length} wiki pages; ${dates} genuine Git modification dates; canonical URLs, descriptions, structured data, internal assets and discovery coverage verified.`);
