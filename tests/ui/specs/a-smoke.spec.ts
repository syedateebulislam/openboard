/**
 * Does the app compile and boot at all?
 *
 * Named to sort first so it runs before everything else. A generated dashboard
 * that fails to parse takes the entire app down behind Vite's error overlay,
 * and every other spec then fails with "element not found" — twenty-eight
 * identical, misleading failures, none naming the cause. This turns that into
 * one test with the actual compiler message.
 *
 * It also records the workspace's own mtimes, because the workspace is a live
 * directory: OpenBoardCLI regenerates dashboards there while it runs, and a suite
 * that photographs a target being rewritten underneath it will produce diffs
 * nobody can reproduce.
 */

import { test, expect } from '../harness/fixtures.js';
import { ScreenAudit } from '../harness/audit.js';
import { dashboardTabs, resolveWorkspace } from '../harness/workspace.js';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

test.describe('smoke', () => {
  test('the generated app compiles and serves', async ({ page }) => {
    await page.goto('/');
    const compileError = await ScreenAudit.compileError(page);
    expect(compileError ?? '', `The generated app does not compile:\n${compileError}`).toBe('');

    // Either the login form or the tab strip — both prove React mounted.
    await expect(page.locator('#username, [role="tab"]').first()).toBeVisible({ timeout: 20_000 });
  });

  test('the workspace is not being rewritten while we look at it', async () => {
    const workspace = resolveWorkspace();
    const components = join(workspace, 'src', 'components');
    test.skip(!existsSync(components), 'no components directory');

    const tabs = dashboardTabs(workspace);
    expect(tabs.length, 'the manifest should declare at least one dashboard').toBeGreaterThan(0);

    // A dashboard rewritten in the last minute means OpenBoardCLI is generating
    // right now; screenshots taken against that are not reproducible.
    const manifest = join(workspace, 'src', 'generated', 'dashboardManifest.tsx');
    const ageMs = Date.now() - statSync(manifest).mtimeMs;
    expect(
      ageMs,
      'The workspace was modified seconds ago — close OpenBoardCLI (or let its fetch finish) before capturing screenshots.',
    ).toBeGreaterThan(60_000);
  });
});
