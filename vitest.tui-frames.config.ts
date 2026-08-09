/**
 * Config for the TUI frame capture (`npm run test:ui:tui`).
 *
 * Separate from the unit run because this writes artefacts: capturing frames as
 * a side effect of the normal suite would leave every `npm test` with a dirty
 * working tree, and the frames are a review surface, not an assertion.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/ui/tui/**/*.test.tsx'],
    testTimeout: 30_000,
  },
});
