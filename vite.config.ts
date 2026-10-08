import { defineConfig, type Plugin } from 'vitest/config'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

// Base path for GitHub Pages. Override with VITE_BASE at build time.
const base = process.env.VITE_BASE ?? '/'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * Label OCR runs fully offline, so Tesseract's worker, its wasm core and the
 * English data are served from the app itself -- never from a CDN, which is
 * where the library looks by default. Copied from node_modules into
 * public/tesseract (gitignored) before dev or build, then precached.
 *
 * One core build: SIMD with the LSTM engine only, which every browser that
 * can run the rest of the app supports.
 */
function bundleOcrAssets(): Plugin {
  const files: [string, string][] = [
    ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
    [
      'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
      'tesseract-core-simd-lstm.wasm.js',
    ],
    // The integer-quantised LSTM model: a third of the size, same accuracy class.
    ['node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
  ]
  const copy = (): void => {
    const out = join(root, 'public', 'tesseract')
    mkdirSync(out, { recursive: true })
    for (const [from, to] of files) {
      const src = join(root, from)
      const dest = join(out, to)
      if (!existsSync(src)) {
        throw new Error(`OCR asset missing: ${from}. Run npm install.`)
      }
      if (!existsSync(dest) || statSync(dest).size !== statSync(src).size) copyFileSync(src, dest)
    }
  }
  return { name: 'bundle-ocr-assets', buildStart: copy, configureServer: copy }
}

export default defineConfig({
  base,
  plugins: [
    bundleOcrAssets(),
    preact(),
    VitePWA({
      registerType: 'prompt',
      // Precache everything: the app must work with no signal at all --
      // the bundled food index and the OCR engine included.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,json,bin,gz}'],
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        // No runtime caching of third parties. Network results go into
        // IndexedDB, and the on-device model into its own private storage.
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
  worker: { format: 'es' },
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
