import fs from 'node:fs';
import path from 'node:path';
import { expect, request, test } from '@playwright/test';

const school = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../.state/school.json'), 'utf8')) as {
  slug: string;
  email: string;
  password: string;
};

// Negative control (see package.json "test:negative"): drops the browser's logout request, i.e. a logout that never reaches the server
// and never clears the cookie. The assertions below MUST then fail. Nothing in the application is modified.
const BROKEN_LOGOUT = process.env.E2E_SIMULATE_BROKEN_LOGOUT === '1';

test('school-slug login → lapsed-subscription banner → logout → old session cookie is rejected', async ({ page, context, baseURL }) => {
  await context.addInitScript(() => localStorage.setItem('lang', 'en'));
  if (BROKEN_LOGOUT) await page.route('**/api/auth/logout', (route) => route.abort());

  await page.goto('/');
  await page.getByLabel(/School ID/).fill(school.slug);
  await page.getByLabel('Email').fill(school.email);
  await page.getByLabel('Password').fill(school.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The provisioned first admin still has the generated password: the app must insist on replacing it before anything else.
  await expect(page.getByText(/password was set by an administrator/i), 'forced first-login password change must be shown').toBeVisible();
  await page.getByLabel('Current password').fill(school.password);
  await page.getByLabel(/New password/).fill(`${school.password}-changed-by-e2e`);
  await page.getByRole('button', { name: 'Save' }).click();

  // Logged in, and the grace-period warning is shown (the subscription ended 3 days ago).
  const banner = page.getByRole('status').filter({ hasText: /subscription has ended/i });
  await expect(banner, 'grace-period renewal banner must be visible').toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  const before = (await context.cookies()).find((c) => c.name === 'sid');
  expect(before, 'a session cookie must exist after login').toBeTruthy();
  expect(before!.httpOnly).toBe(true);
  const oldCookie = `sid=${before!.value}`;
  const origin = baseURL!;

  // The captured cookie works before logout (proves the replay check below is meaningful).
  const api = await request.newContext({ baseURL: origin, extraHTTPHeaders: { origin } });
  expect((await api.get('/api/auth/me', { headers: { cookie: oldCookie } })).status(), 'captured cookie must be valid before logout').toBe(200);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' }), 'login form must be shown after logout').toBeVisible();

  // Booleans only: a failing assertion must never print the session token.
  const stillHasCookie = (await context.cookies()).some((c) => c.name === 'sid');
  expect.soft(stillHasCookie, 'browser session cookie must be cleared by logout').toBe(false);
  const replay = await api.get('/api/auth/me', { headers: { cookie: oldCookie } });
  expect.soft(replay.status(), 'old session cookie must be rejected after logout').toBe(401);
  await api.dispose();
});
