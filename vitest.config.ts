import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@tool-boundary/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@tool-boundary/config': fileURLToPath(new URL('./packages/config/src/index.ts', import.meta.url)),
      'tool-boundary-gateway': fileURLToPath(new URL('./apps/gateway/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    globals: false,
    pool: 'forks'
  }
});
