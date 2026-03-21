import { test, expect } from '@playwright/test';

test.describe('Search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => document.getElementById('app')?.children.length > 0,
      { timeout: 10000 },
    );
    await expect(page.locator('input[type="search"]').first()).toBeEnabled({
      timeout: 15000,
    });
  });

  test('should expand popover on focus and show results for a service number', async ({
    page,
  }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await expect(page.locator('#search-popover.expand')).toBeVisible({
      timeout: 5000,
    });
    await search.fill('133');
    await expect(
      page.locator('#search-popover .popover-list li a').first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test('should find stops by name', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.fill('majestic');
    await expect(
      page.locator('#search-popover .popover-list li .stop-tag').first(),
    ).toBeVisible({ timeout: 10000 });
  });

  test('should show no-results for gibberish', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.fill('zzzzxyznonexistent99999');
    await expect(page.locator('#search-popover .nada')).toBeVisible({
      timeout: 5000,
    });
  });

  test('should navigate to stop page on result click', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.fill('08057');
    const firstResult = page
      .locator('#search-popover .popover-list li a')
      .first();
    await expect(firstResult).toBeVisible({ timeout: 5000 });
    await firstResult.click();
    await expect(page).toHaveURL(/stops|services/, { timeout: 5000 });
  });
});
