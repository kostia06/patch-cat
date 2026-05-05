import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://patch-cat.com",

  integrations: [
    starlight({
      title: "Patch",
      description: "An MCP server that lets your AI assistant build and remember its own tools.",
      logo: {
        src: "./src/assets/cat-mark.svg",
        replacesTitle: false,
      },
      social: {
        github: "https://github.com/patch-cat/patch-cat",
      },
      // Starlight handles /docs/* routes; custom Astro pages handle / and /blog/*.
      // We mount Starlight under the root but supply a custom homepage via
      // src/pages/index.astro which takes precedence.
      sidebar: [
        {
          label: "Get started",
          items: [
            { label: "Quickstart", link: "/quickstart" },
            { label: "Architecture", link: "/architecture" },
          ],
        },
        {
          label: "Security",
          items: [{ label: "Threat model", link: "/threat-model" }],
        },
        {
          label: "Reference",
          items: [
            { label: "Manifest format", link: "/manifest" },
            { label: "Registry API", link: "/registry-api" },
          ],
        },
        {
          label: "Blog",
          link: "/blog",
        },
      ],
      customCss: ["./src/styles/global.css"],
      pagination: false,
      lastUpdated: true,
      head: [
        {
          tag: "meta",
          attrs: { property: "og:image", content: "/og-default.png" },
        },
        {
          tag: "meta",
          attrs: { name: "twitter:card", content: "summary_large_image" },
        },
      ],
    }),
  ],
});
