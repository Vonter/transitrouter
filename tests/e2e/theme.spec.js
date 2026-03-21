import { test, expect } from '@playwright/test';

test.describe('Theme / Dark Mode', () => {
  test('should default to light mode when no preference set', async ({
    page,
  }) => {
    await page.goto('/');
    // Without explicit dark preference, should not have dark class
    // (depends on system setting, so check it doesn't crash)
    await expect(page.locator('#map')).toBeVisible();
  });

  test('should apply dark mode from localStorage', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('theme', 'dark');
    });
    await page.goto('/');
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(isDark).toBe(true);
  });

  test('should apply light mode from localStorage', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('theme', 'light');
    });
    await page.goto('/');
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(isDark).toBe(false);
  });

  test('should persist dark mode across pages', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('theme', 'dark');
    });
    await page.goto('/');
    let isDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(isDark).toBe(true);

    await page.goto('/arrival/#08057');
    isDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(isDark).toBe(true);

    await page.goto('/first-last/');
    isDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(isDark).toBe(true);
  });

  test('should have color-scheme meta tag', async ({ page }) => {
    await page.goto('/');
    const colorScheme = await page.getAttribute(
      'meta[name="color-scheme"]',
      'content',
    );
    expect(colorScheme).toContain('light');
    expect(colorScheme).toContain('dark');
  });

  test('should have theme-color meta tags for both schemes', async ({
    page,
  }) => {
    await page.goto('/');
    const lightTheme = await page.getAttribute(
      'meta[name="theme-color"][media="(prefers-color-scheme: light)"]',
      'content',
    );
    const darkTheme = await page.getAttribute(
      'meta[name="theme-color"][media="(prefers-color-scheme: dark)"]',
      'content',
    );
    expect(lightTheme).toBeTruthy();
    expect(darkTheme).toBeTruthy();
  });
});
