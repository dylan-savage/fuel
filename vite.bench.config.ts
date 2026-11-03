import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

/**
 * Temporary, with src/client/bench.tsx. Its own pass after the app's, so a second entry cannot
 * split the shell into shared chunks, and the service worker is generated before it exists.
 */
export default defineConfig({
  define: { __FUEL_BUILD__: JSON.stringify('bench') },
  root: 'src/client',
  publicDir: false,
  build: {
    outDir: '../../dist/client',
    emptyOutDir: false,
    target: 'safari16',
    rolldownOptions: { input: 'src/client/bench.html' },
  },
  plugins: [preact()],
});
