import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// Base path for GitHub Pages. Override with VITE_BASE at build time.
const base = process.env.VITE_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [
    preact(),
    VitePWA({
      registerType: 'prompt',
      // Precache everything: the app must work with no signal at all.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,json,bin}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        // No runtime caching of third parties. The only network call in the
        // app is the user-initiated barcode lookup, and it is never cached
        // by the service worker -- results go into IndexedDB instead.
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'Macro Tracker',
        short_name: 'Macros',
        description: 'Weighed food logging with composite meals. Device-only.',
        theme_color: '#12151a',
        background_color: '#12151a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    // No CDN references anywhere; everything is repo-resident.
    rollupOptions: { output: { manualChunks: { uplot: ['uplot'], dexie: ['dexie'] } } },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
  },
})
