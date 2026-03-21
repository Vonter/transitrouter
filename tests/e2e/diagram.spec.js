import { test, expect } from '@playwright/test';

test.describe('Transit Route Diagram Page', () => {
  test('should load the diagram page successfully', async ({ page }) => {
    await page.goto('/diagram/');
    await expect(page).toHaveTitle(/Diagram/i);
  });

  test('should render the diagram container', async ({ page }) => {
    await page.goto('/diagram/');
    await expect(page.locator('#diagram')).toBeAttached();
  });

  test('should have no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/diagram/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    expect(errors).toEqual([]);
  });

  test('should have correct HTTP status', async ({ page }) => {
    const response = await page.goto('/diagram/');
    expect(response.status()).toBeLessThan(400);
  });

  test('should load Google Fonts for diagram rendering', async ({ page }) => {
    const fontRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('fonts.googleapis.com') || req.url().includes('fonts.gstatic.com')) {
        fontRequests.push(req.url());
      }
    });
    await page.goto('/diagram/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    expect(fontRequests.length).toBeGreaterThan(0);
  });

  test('should support dark mode', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('theme', 'dark');
    });
    await page.goto('/diagram/');
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(isDark).toBe(true);
  });
});
