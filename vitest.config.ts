import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Real install/build lifecycle tests are integration-only:
    // run them with `npm run test:integration` (vitest.integration.config.ts).
    // tests/ui/** is the Playwright suite (`npm run test:ui`). It drives a real
    // browser against a served app, so it must never be picked up by the unit
    // run — two runners collecting the same files fight over ports and fixtures.
    exclude: [...configDefaults.exclude, 'tests/integration/**', 'tests/ui/**'],
    // Scaffold/FS-heavy tests copy the whole dashboard template; CI disks are
    // slow enough to blow the 5s default. Long-running install/build tests
    // still set their own larger per-test timeouts.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.tsx', 'src/App.tsx', 'src/screens/**', 'src/components/**'],
    },
  },
});
