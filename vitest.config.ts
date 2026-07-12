import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
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
