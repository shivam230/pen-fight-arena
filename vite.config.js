import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the same build works at a domain root or under a GitHub
  // Pages project sub-path (…/pen-fight-arena/).
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
  },
});
