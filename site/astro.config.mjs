import { defineConfig } from 'astro/config';

export default defineConfig({
  base: process.env.SITE_BASE || '/',
  output: 'static',
  integrations: [{
    name: 'goodcorp-local-preview',
    hooks: {
      'astro:config:setup'({ command, updateConfig }) {
        updateConfig({
          vite: { define: { 'import.meta.env.GOODCORP_DEV_SERVER': command === 'dev' } },
        });
      },
    },
  }],
});
