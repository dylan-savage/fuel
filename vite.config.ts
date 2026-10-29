import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  root: 'src/client',
  publicDir: '../../public',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    target: 'safari16',
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8787', '/healthz': 'http://127.0.0.1:8787' },
  },
  plugins: [
    preact(),
    VitePWA({
      strategies: 'generateSW',
      registerType: 'prompt',
      injectRegister: false,
      includeManifestIcons: false,
      manifest: {
        name: 'fuel',
        short_name: 'fuel',
        description: 'Calories and macros, logged from the Home Screen.',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        theme_color: '#000000',
        background_color: '#000000',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The shell and the barcode wasm only. Data never goes through the service worker.
        globPatterns: ['**/*.{html,js,css,wasm,png,webmanifest}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
