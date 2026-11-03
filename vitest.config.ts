import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __FUEL_BUILD__: JSON.stringify('test') },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
