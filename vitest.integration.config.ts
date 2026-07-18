import { defineConfig } from 'vitest/config';

/**
 * Integration suite: real npm installs, vite builds, and dev servers.
 * Run with `npm run test:integration` — once per OS in CI, not on every push.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
