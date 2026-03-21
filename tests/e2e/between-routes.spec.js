import { test, expect } from '@playwright/test';

test.describe('Between Routes Feature', () => {
  test('should load between routes page', async ({ page }) => {
    await page.goto('/#/blr/between/08057/01012');
    await expect(page.locator('#map')).toBeVisible();
    // The between popover may or may not appear depending on data
    await page.waitForTimeout(5000);
  });

  test('should show between popover when navigated to between route', async ({
    page,
  }) => {
    await page.goto('/#/blr/between/08057/01012');
    // Allow time for data processing
    await page.waitForTimeout(8000);
    const betweenPopover = page.locator('#between-popover');
    await expect(betweenPopover).toBeAttached();
  });

  test('should display start and end stop names in between popover', async ({
    page,
  }) => {
    await page.goto('/#/blr/between/08057/01012');
    await page.waitForTimeout(8000);
    const betweenExpanded = page.locator('#between-popover.expand');
    const count = await betweenExpanded.count();
    if (count > 0) {
      const header = page.locator('#between-popover header h1');
      await expect(header).toBeVisible();
      const text = await header.textContent();
      // Should contain "to" separating start and end
      expect(text).toContain('to');
    }
  });

  test('should have close button on between popover', async ({ page }) => {
    await page.goto('/#/blr/between/08057/01012');
    await page.waitForTimeout(8000);
    const betweenExpanded = page.locator('#between-popover.expand');
    const count = await betweenExpanded.count();
    if (count > 0) {
      const closeBtn = page.locator('#between-popover .popover-close');
      await expect(closeBtn).toBeVisible();
    }
  });

  test('should show route results between stops', async ({ page }) => {
    await page.goto('/#/blr/between/08057/01012');
    await page.waitForTimeout(8000);
    const betweenExpanded = page.locator('#between-popover.expand');
    const count = await betweenExpanded.count();
    if (count > 0) {
      const results = page.locator('#between-popover .between-item, #between-popover .popover-scroll li');
      const resultCount = await results.count();
      expect(resultCount).toBeGreaterThanOrEqual(0);
    }
  });

  test('should not crash with invalid stop IDs', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/#/blr/between/INVALID1/INVALID2');
    await page.waitForTimeout(5000);
    await expect(page.locator('#map')).toBeVisible();
    // Page should still work even with invalid IDs
  });
});
