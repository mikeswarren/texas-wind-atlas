import { defineConfig } from 'vite'

export default defineConfig({
  // Served from the domain root at map.hitky.com.
  base: '/',
  build: {
    outDir: 'dist',
    // The turbine GeoJSON must stay a fetchable file, never inlined into JS.
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // mapbox-gl is ~90% of the bundle and changes only when the dependency
        // does. Splitting it means app edits don't re-download 530 KB.
        manualChunks: { mapbox: ['mapbox-gl'] },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
  },
})
