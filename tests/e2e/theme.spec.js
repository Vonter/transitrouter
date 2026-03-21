import { test, expect } from '@playwright/test';

test.describe('Theme / Dark Mode', () => {
  test('should apply dark mode from localStorage', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await page.goto('/');
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(isDark).toBe(true);
  });

  test('should apply light mode from localStorage', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.goto('/');
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(isDark).toBe(false);
  });

  test('should persist dark mode across pages', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    for (const url of ['/', '/arrival/#08057', '/first-last/']) {
      await page.goto(url);
      const isDark = await page.evaluate(() =>
        document.documentElement.classList.contains('dark'),
      );
      expect(isDark, `dark class missing on ${url}`).toBe(true);
    }
  });

  test('should have color-scheme and theme-color meta tags', async ({
    page,
  }) => {
    await page.goto('/');
    const colorScheme = await page.getAttribute(
      'meta[name="color-scheme"]',
      'content',
    );
    expect(colorScheme).toContain('light');
    expect(colorScheme).toContain('dark');
    expect(
      await page.getAttribute(
        'meta[name="theme-color"][media="(prefers-color-scheme: light)"]',
        'content',
      ),
    ).toBeTruthy();
    expect(
      await page.getAttribute(
        'meta[name="theme-color"][media="(prefers-color-scheme: dark)"]',
        'content',
      ),
    ).toBeTruthy();
  });

  test('should toggle theme from city drawer', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => document.getElementById('app')?.children.length > 0,
      { timeout: 10000 },
    );
    await page.locator('#logo').click();
    await expect(page.locator('#city-drawer-overlay.open')).toBeVisible({
      timeout: 3000,
    });
    const wasDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    await page.locator('.theme-toggle-track').click();
    const theme = await page.evaluate(() => localStorage.getItem('theme'));
    expect(theme).toBe(wasDark ? 'light' : 'dark');
  });
});
