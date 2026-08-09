/**
 * The same dashboard at the sizes people actually open it at, in both themes.
 *
 * Running every tab at every viewport would multiply the suite by six for
 * little extra signal — layout breaks are a property of the shell and the card
 * grid, not of which biller's numbers are inside. So this takes a
 * representative pair of screens across the matrix, and the per-tab spec covers
 * breadth at one size.
 */

import { test, login, openDashboard } from '../harness/fixtures.js';
import { dashboardTabs, resolveWorkspace } from '../harness/workspace.js';
import { expect } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 900 },
];

// Same reason as dashboards.spec: derived from the manifest, not the session.
const sample = [{ id: 'master', label: 'Master' }, ...dashboardTabs(resolveWorkspace()).slice(0, 1)];

for (const viewport of VIEWPORTS) {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`${viewport.name} · ${theme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: theme,
      });

      test('renders without layout breakage', async ({ page, capture, session }) => {
        await login(page, session);

        for (const tab of sample) {
          const button = page.locator(`#tab-${tab.id.replace(/([^a-zA-Z0-9_-])/g, '\\$1')}`);
          if (await button.count() === 0) continue;

          // On mobile the strip collapses behind a toggler, so open it first.
          const toggler = page.locator('.tabs-toggler');
          if (await toggler.isVisible().catch(() => false)) await toggler.click();

          await button.click();
          const findings = await capture({ name: `responsive/${viewport.name}-${tab.id}`, theme });

          const overflow = findings.filter((finding) => finding.rule === 'horizontal-overflow');
          expect(overflow, overflow.map((f) => f.detail).join('\n')).toEqual([]);
        }
      });
    });
  }
}
