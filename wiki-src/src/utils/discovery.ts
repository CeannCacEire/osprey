import { getCollection } from "astro:content";

export const site = "https://osprey.build";
export const categories = [
  ["getting-started", "Getting started"],
  ["items", "Items and blocks"],
  ["points-of-interest", "Points of interest"],
  ["enchantments", "Enchantments"],
] as const;

export function pagePath(id: string) {
  return id === "" || id === "index" ? "/wiki/" : `/wiki/${id.replace(/\/index$/, "")}/`;
}

export async function publishedPages() {
  return (await getCollection("docs"))
    .filter((entry) => !entry.data.draft)
    .sort((a, b) => {
      const group = (id: string) => categories.findIndex(([key]) => id.startsWith(`${key}/`));
      return group(a.id) - group(b.id)
        || (a.data.sidebar?.order ?? Infinity) - (b.data.sidebar?.order ?? Infinity)
        || a.data.title.localeCompare(b.data.title);
    });
}
