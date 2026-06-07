/**
 * ============================================================================
 * TEST SETUP & GLOBAL CONFIGURATION
 * ============================================================================
 *
 * This file initializes the test environment for the entire OpenBoard test suite.
 * It runs before any test file and provides:
 *
 * 1. Global mocks for external services (GitHub API, Vercel API, LLM providers)
 * 2. Temporary directory management for generated project output
 * 3. Environment variable setup for test mode
 * 4. Shared utilities available to all test files
 *
 * USAGE:
 *   - Automatically loaded via vitest.config.ts `setupFiles` option
 *   - All tests inherit the mocked environment
 *   - Each test gets a fresh temp directory via `createTestDir()`
 *
 * IMPORTANT:
 *   - Never call real external APIs in unit tests
 *   - Use the `fixtures/` directory for sample data files
 *   - Clean up temp directories in afterEach/afterAll hooks
 * ============================================================================
 */

import { vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Global test directories tracker (auto-cleanup)
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];

/**
 * Creates a fresh temporary directory for a test to use as project output.
 * Automatically tracked for cleanup after all tests complete.
 *
 * @returns Absolute path to the temp directory
 *
 * @example
 *   const dir = await createTestDir();
 *   // Use `dir` as outputDir for TemplateService, BuildService, etc.
 */
export async function createTestDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openboard-test-'));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------
beforeAll(() => {
  // Prevent any accidental real API calls during tests
  process.env.OPENBOARD_TEST_MODE = 'true';

  // Ensure config operations don't touch the real ~/.openboard/
  process.env.OPENBOARD_CONFIG_DIR = join(tmpdir(), '.openboard-test');
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
afterEach(() => {
  // Reset all mocks between tests to prevent cross-test contamination
  vi.restoreAllMocks();
});

afterAll(async () => {
  // Remove all temp directories created during tests
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});
