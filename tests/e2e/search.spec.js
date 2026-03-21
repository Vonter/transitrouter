import { test, expect } from '@playwright/test';

test.describe('Search Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => {
        const app = document.getElementById('app');
        return app && app.children.length > 0;
      },
      { timeout: 10000 },
    );
    await expect(page.locator('input[type="search"]').first()).toBeEnabled({
      timeout: 15000,
    });
  });

  test('should focus search input on click', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await expect(search).toBeFocused();
  });

  test('should expand search popover when focused', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await expect(page.locator('#search-popover.expand')).toBeVisible({
      timeout: 5000,
    });
  });

  test('should show results when searching for a number', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.fill('133');
    await page.waitForTimeout(1000);
    // Should show matching results (services or stops containing '133')
    const results = page.locator('#search-popover .popover-list li a');
    await expect(results.first()).toBeVisible({ timeout: 5000 });
  });

  test('should search for a stop by name', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.fill('majestic');
    await page.waitForTimeout(2000);
    // Should show stop results with stop tags
    const stopResults = page.locator(
      '#search-popover .popover-list li .stop-tag',
    );
    await expect(stopResults.first()).toBeVisible({ timeout: 10000 });
  });

  test('should search for a stop by code', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.fill('08057');
    await page.waitForTimeout(1000);
    const stopResults = page.locator(
      '#search-popover .popover-list li .stop-tag',
    );
    await expect(stopResults.first()).toBeVisible({ timeout: 5000 });
  });

  test('should show no results for gibberish', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.fill('zzzzxyznonexistent99999');
    await page.waitForTimeout(1000);
    await expect(page.locator('#search-popover .nada')).toBeVisible({
      timeout: 5000,
    });
  });

  test('should close search with cancel button', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.fill('majestic');
    await page.waitForTimeout(500);
    const cancelBtn = page.locator('#search-popover .cancel-btn');
    await cancelBtn.click();
    await expect(page.locator('#search-popover.expand')).not.toBeVisible({
      timeout: 3000,
    });
  });

  test('should navigate when clicking a search result', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.fill('08057');
    await page.waitForTimeout(1000);
    const firstResult = page
      .locator('#search-popover .popover-list li a')
      .first();
    await expect(firstResult).toBeVisible({ timeout: 5000 });
    await firstResult.click();
    // URL should change to a stop or service route
    await expect(page).toHaveURL(/stops|services/, { timeout: 5000 });
  });

  test('should navigate to stop page when clicking a stop result', async ({
    page,
  }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.fill('majestic');
    await page.waitForTimeout(1000);
    const stopLink = page
      .locator('#search-popover .popover-list li a')
      .first();
    await expect(stopLink).toBeVisible({ timeout: 5000 });
    await stopLink.click();
    await expect(page).toHaveURL(/stops/, { timeout: 5000 });
  });

  test('should clear search when input is cleared', async ({ page }) => {
    const search = page.locator('input[type="search"]').first();
    await search.click();
    await search.fill('majestic');
    await page.waitForTimeout(500);
    await search.fill('');
    await page.waitForTimeout(500);
    await expect(page.locator('#search-popover .nada')).not.toBeVisible();
  });
});
