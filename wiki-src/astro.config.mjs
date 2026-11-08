// Osprey wiki (Starlight). Built by .github/workflows/pages.yml and served at
// https://osprey.build/wiki/. Pages live in src/content/docs/ and are edited by
// admins through Sveltia CMS at https://osprey.build/wiki/admin/.
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://osprey.build",
  base: "/wiki",
  trailingSlash: "always",
  markdown: { syntaxHighlight: false },
  integrations: [
    starlight({
      title: "Osprey Wiki",
      description:
        "The official Osprey wiki: how the server works, Falcon, and every custom block and item.",
      favicon: "/favicon.png",
      expressiveCode: false,
      social: [
        { icon: "discord", label: "Osprey Discord", href: "https://discord.gg/4EnjKHUG4S" },
      ],
      customCss: ["./src/styles/osprey.css"],
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        Head: "./src/components/Head.astro",
      },
      head: [
        { tag: "meta", attrs: { property: "og:image", content: "https://osprey.build/assets/brand/og-image.png" } },
        { tag: "meta", attrs: { name: "theme-color", content: "#0b0b0c" } },
      ],
      sidebar: [
        { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
        { label: "Items and blocks", items: [{ autogenerate: { directory: "items" } }] },
        { label: "Points of interest", items: [{ autogenerate: { directory: "points-of-interest" } }] },
        { label: "Enchantments", items: [{ autogenerate: { directory: "enchantments" } }] },
        { label: "Back to osprey.build", link: "https://osprey.build/", attrs: { class: "sl-back-home" } },
      ],
      lastUpdated: false,
      pagination: true,
    }),
  ],
});
