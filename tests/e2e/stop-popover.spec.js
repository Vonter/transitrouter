import { test, expect } from '@playwright/test';

test.describe('Stop Popover', () => {
  // NOTE: Detailed stop popover interaction tests (open, close, name/code display,
  // services list, arrivals button, dest filter) are in navigation.spec.js which
  // runs in serial mode for reliability.

  test('should update URL hash correctly for stop page', async ({ page }) => {
    await page.goto('/#/blr/stops/08057', { waitUntil: 'load' });
    await expect(page).toHaveURL(/stops\/08057/);
  });

  test('should attach stop popover element on stop page', async ({ page }) => {
    await page.goto('/#/blr/stops/08057', { waitUntil: 'load' });
    await expect(page.locator('#stop-popover')).toBeAttached({
      timeout: 15000,
    });
  });

  test('should show map on stop page', async ({ page }) => {
    await page.goto('/#/blr/stops/08057', { waitUntil: 'load' });
    await expect(page.locator('#map')).toBeVisible({ timeout: 15000 });
  });
});
