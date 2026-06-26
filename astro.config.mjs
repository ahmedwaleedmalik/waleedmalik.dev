import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

import { SITE } from './src/consts';

import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: SITE.url,
  integrations: [mdx(), sitemap()],

  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      wrap: false,
    },
  },

  adapter: cloudflare()
});