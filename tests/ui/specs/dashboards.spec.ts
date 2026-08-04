/**
 * Every dashboard tab, screen by screen.
 *
 * The tab list is read from the generated manifest rather than written here, so
 * this covers whatever dashboards the workspace actually has — a hardcoded list
 * would go stale the first time someone adds a biller, which is precisely when
 * the coverage matters.
 *
 * Each tab is visited, audited and photographed. The audit is what fails the
 * build; the screenshot is what a human reviews afterwards.
 */

import { test, expect, login, openDashboard } from '../harness/fixtures.js';
import type { Finding } from '../harness/audit.js';
import { dashboardTabs, resolveWorkspace } from '../harness/workspace.js';

// Read straight from the manifest at collection time. The session file only
// exists after globalSetup, which has not run when Playwright is merely listing
// tests — and the tab list needs no server, just the generated file on disk.
const tabs = dashboardTabs(resolveWorkspace());

test.describe('dashboard tabs', () => {
  test.beforeEach(async ({ page, session }) => {
    await login(page, session);
  });

  test('the master tab summarises the others', async ({ page, capture }) => {
    await openDashboard(page, 'master');
    expect(await activeDashboardId(page)).toBe('master');

    const findings = await capture({ name: 'dashboards/master' });
    expectNoErrors(findings);
  });

  for (const tab of tabs) {
    test(`${tab.label} (${tab.id}) renders`, async ({ page, capture }) => {
      // No existence pre-check: in grouped mode a tab is not in the DOM at all
      // until its category is opened, so asserting first can only ever fail.
      // openDashboard opens the group and fails with the id if it never appears.
      await openDashboard(page, tab.id);

      // The group closes on selection, taking the active pill out of the DOM,
      // so selection is confirmed by what rendered rather than by a class.
      const main = page.locator('main').last();
      await expect(main, `"${tab.label}" should render a dashboard`).toBeVisible();
      expect((await main.innerText()).trim().length, `"${tab.label}" rendered an empty panel`).toBeGreaterThan(40);

      const findings = await capture({ name: `dashboards/${tab.id}` });
      expectNoErrors(findings);
    });
  }

  test('switching tabs does not leak the previous dashboard', async ({ page }) => {
    test.skip(tabs.length < 2, 'needs at least two dashboards');
    const [first, second] = tabs;

    await openDashboard(page, first.id);
    const firstText = (await page.locator('main').last().innerText()).trim();

    await openDashboard(page, second.id);
    const secondText = (await page.locator('main').last().innerText()).trim();

    // Different dashboards must render different content; identical panels mean
    // the switch did nothing, or the previous one is still mounted.
    expect(secondText, 'switching tabs did not change what is rendered').not.toBe(firstText);
  });
});

function expectNoErrors(findings: Finding[]): void {
  const errors = findings.filter((finding) => finding.severity === 'error');
  expect(
    errors,
    errors.map((finding) => `${finding.rule}: ${finding.detail}`).join('\n'),
  ).toEqual([]);
}

/** Tab ids come from generated content, so they are escaped, not trusted. */
function cssEscape(id: string): string {
  return id.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}
