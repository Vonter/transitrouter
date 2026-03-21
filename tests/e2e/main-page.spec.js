import { test, expect } from '@playwright/test';

test.describe('Main Page', () => {
  test('should load with title, logo, map, and search', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/TransitRouter/);
    await expect(page.locator('#logo')).toBeVisible();
    await expect(page.locator('#map')).toBeVisible();
    const search = page.locator('input[type="search"]').first();
    await expect(search).toBeVisible();
    await expect(search).toBeEnabled({ timeout: 10000 });
  });

  test('should render app and load service list', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => document.getElementById('app')?.children.length > 0,
      { timeout: 10000 },
    );
    await expect(
      page.locator('#search-popover .popover-list li').first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
