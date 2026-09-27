import { defineConfig } from 'vite';

// Relative base so the production build can be dropped on any static host / sub-path.
export default defineConfig({
  base: './',
  server: { port: 5178, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
