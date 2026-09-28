import { defineConfig } from 'vite'
// The built UI is committed inside the sprawler binary (crates/sprawler/web_dist) so installs
// need no Node. Rebuild with `npm run build` after changing web/src; a test fails if it is stale.
export default defineConfig({
  server: { port: 5199, proxy: { '/api': 'http://127.0.0.1:8766' } },
  build: { outDir: '../crates/sprawler/web_dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
})
