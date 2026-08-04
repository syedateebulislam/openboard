/**
 * Shared fixtures: the session, a logged-in page, and "capture this screen".
 *
 * `capture` is the unit the whole suite is built from — it settles the page,
 * takes the screenshot, runs the audit and files the record. Screens are
 * therefore covered consistently: no spec can capture an image and forget to
 * check it, which is how screenshot suites usually rot into a folder of
 * pictures nobody reads.
 */

import { test as base, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ScreenAudit, type Finding } from './audit.js';
import { recordScreen, UI_OUT } from './report.js';
import { compareToBaseline } from './baseline.js';
import type { DashboardTab } from './workspace.js';

export interface Session {
  baseURL: string;
  username: string;
  password: string;
  workspace: string;
  tabs: DashboardTab[];
}

export function readSession(): Session {
  const file = join(import.meta.dirname, '..', '.artifacts', 'session.json');
  return JSON.parse(readFileSync(file, 'utf-8')) as Session;
}

export interface CaptureOptions {
  /** `flow/name` — becomes the screenshot path and the report key. */
  name: string;
  theme?: 'light' | 'dark';
  /** Extra settling for a screen that animates in. */
  settleMs?: number;
}

/**
 * Hold the page still before photographing it.
 *
 * Without this, charts animate on mount and every screenshot differs from the
 * last for reasons that are not defects.
 */
export async function freeze(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }`,
  });
}

export const test = base.extend<{
  session: Session;
  audit: ScreenAudit;
  capture: (options: CaptureOptions) => Promise<Finding[]>;
}>({
  session: async ({}, use) => { await use(readSession()); },

  audit: async ({ page }, use) => { await use(new ScreenAudit(page)); },

  capture: async ({ page, audit }, use, testInfo) => {
    await use(async ({ name, theme = 'light', settleMs = 900 }: CaptureOptions) => {
      const viewport = page.viewportSize();
      const label = `${viewport?.width ?? 0}x${viewport?.height ?? 0}`;
      const screen = `${name} [${label}, ${theme}]`;

      await freeze(page);
      await page.waitForLoadState('networkidle').catch(() => {});
      // Recharts sizes itself from a ResponsiveContainer measurement that lands
      // a frame or two after the network goes quiet. Photographing before that
      // reports every chart as collapsed — a defect in the harness, not the app.
      await page.waitForFunction(
        () => [...document.querySelectorAll('.recharts-wrapper')]
          .every((el) => el.getBoundingClientRect().height > 24),
        undefined,
        { timeout: 5000 },
      ).catch(() => {});
      await page.waitForTimeout(settleMs);

      const slug = `${name}.${label}.${theme}`;
      const screenshot = join(UI_OUT, `${slug}.png`);
      mkdirSync(dirname(screenshot), { recursive: true });
      const shot = await page.screenshot({ path: screenshot, fullPage: true });

      const findings = await audit.run(screen);
      audit.clear();

      // Drift is a finding like any other, so it lands in the same report and
      // is reviewed the same way rather than only failing a test.
      const baseline = compareToBaseline(screen, slug, shot);
      if (baseline.finding) findings.push(baseline.finding);

      recordScreen({
        screen,
        flow: name.split('/')[0] ?? name,
        viewport: label,
        theme,
        screenshot,
        findings,
      });

      // Attached so a failure in the Playwright report carries its own picture.
      await testInfo.attach(screen, { path: screenshot, contentType: 'image/png' });
      return findings;
    });
  },
});

/** Sign in through the real form, the way a user does. */
export async function login(page: Page, session: Session): Promise<void> {
  await page.goto('/');
  const username = page.locator('#username');
  await username.waitFor({ state: 'visible' });
  await username.fill(session.username);
  await page.locator('#password').fill(session.password);
  await page.locator('button[type="submit"]').first().click();
  // The dashboard nav only exists once authenticated.
  await page.waitForSelector('nav[aria-label="OpenBoard dashboards"]', { timeout: 20_000 });
}

/** CSS-escape an id that came from generated content. */
export const tabSelector = (id: string) => `#tab-${id.replace(/([^a-zA-Z0-9_-])/g, '\\$1')}`;

/**
 * Open a dashboard, whichever way the tab strip is rendering.
 *
 * DashboardTabs has two modes. With no groups it is a strict tablist and every
 * tab is a visible `role="tab"`. As soon as dashboards carry a group — which
 * they do as soon as there are a few — it becomes a disclosure navigation:
 * categories collapse behind `aria-haspopup` dropdowns, the tab buttons are
 * hidden inside them, and `role="tab"`/`aria-selected` are gone entirely.
 *
 * Tests that assumed the flat case silently could not reach 15 of 16 tabs, so
 * this opens the containing group (and, on narrow viewports, the whole strip)
 * before clicking.
 */
export async function openDashboard(page: Page, id: string): Promise<void> {
  const tab = page.locator(tabSelector(id));

  // Narrow viewports collapse the entire strip behind one toggler.
  const toggler = page.locator('.tabs-toggler');
  if (await toggler.isVisible().catch(() => false)) {
    if (await toggler.getAttribute('aria-expanded') !== 'true') await toggler.click();
  }

  if (!(await tab.isVisible().catch(() => false))) {
    // Try each category until the tab we want is revealed.
    const groups = page.locator('nav[aria-label="OpenBoard dashboards"] .tab-group > button');
    for (let index = 0; index < await groups.count(); index++) {
      await groups.nth(index).click();
      if (await tab.isVisible().catch(() => false)) break;
    }
  }

  await tab.waitFor({ state: 'visible', timeout: 10_000 });
  await tab.click();
}

/** The id of the dashboard currently shown, read from the active pill. */
export async function activeDashboardId(page: Page): Promise<string | undefined> {
  const id = await page.locator('.tab-btn.active').first().getAttribute('id').catch(() => null);
  return id?.replace(/^tab-/, '') ?? undefined;
}

export { expect };
