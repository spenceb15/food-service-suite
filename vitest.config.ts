import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}'],
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // The `server-only` package throws when imported outside Next.js server
      // context. In the Vitest node environment we replace it with a no-op so
      // that data-layer and service modules can be imported in unit tests.
      'server-only': path.resolve(__dirname, 'tests/__mocks__/server-only.ts'),
    },
  },
});
