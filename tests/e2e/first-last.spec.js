import { test, expect } from '@playwright/test';

test.describe('First & Last Arrival Times Page', () => {
  test('should load the first-last page successfully', async ({ page }) => {
    await page.goto('/first-last/');
    await expect(page).toHaveTitle(/first.*last/i);
  });

  test('should render the firstlast container', async ({ page }) => {
    await page.goto('/first-last/');
    await expect(page.locator('#firstlast')).toBeVisible();
  });

  test('should display a table with data', async ({ page }) => {
    await page.goto('/first-last/');
    // Wait for the table to appear with data
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15000 });
  });

  test('should have no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/first-last/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    expect(errors).toEqual([]);
  });

  test('should display table rows for stop/service data', async ({ page }) => {
    await page.goto('/first-last/');
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15000 });
    const rows = page.locator('table tr, table tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should support dark mode', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('theme', 'dark');
    });
    await page.goto('/first-last/');
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(isDark).toBe(true);
  });

  test('should have correct HTTP status', async ({ page }) => {
    const response = await page.goto('/first-last/');
    expect(response.status()).toBeLessThan(400);
  });
});
