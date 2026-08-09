/**
 * The gate every other screen sits behind.
 *
 * Worth its own spec because a broken login is indistinguishable from a broken
 * dashboard when you only look at screenshots: both are "the app shows nothing
 * useful". Failing here first makes the rest of the report unambiguous.
 */

import { test, expect, login } from '../harness/fixtures.js';

test.describe('authentication', () => {
  test('shows the login form to an anonymous visitor', async ({ page, capture }) => {
    await page.goto('/');
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toHaveAttribute('type', 'password');

    const findings = await capture({ name: 'auth/login' });
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  test('refuses a wrong password and says so', async ({ page, capture, session }) => {
    await page.goto('/');
    await page.locator('#username').fill(session.username);
    await page.locator('#password').fill('definitely-not-the-password');
    await page.locator('button[type="submit"]').first().click();

    // role="alert" so the failure reaches a screen reader, not just the eye.
    const error = page.locator('#login-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');

    await capture({ name: 'auth/login-rejected' });
  });

  test('signs in and reaches the dashboards', async ({ page, capture, session }) => {
    await login(page, session);
    await expect(page.locator('nav[aria-label="OpenBoard dashboards"]')).toBeVisible();

    const findings = await capture({ name: 'auth/signed-in' });
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  test('keeps the session across a reload', async ({ page, session }) => {
    // The cookie is HttpOnly; a reload that bounced back to login would mean
    // every dashboard deep-link is broken.
    await login(page, session);
    await page.reload();
    await expect(page.locator('nav[aria-label="OpenBoard dashboards"]')).toBeVisible();
    await expect(page.locator('#username')).toHaveCount(0);
  });
});
