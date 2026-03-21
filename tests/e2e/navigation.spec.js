import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test.describe('Navigation & Popover Flows', () => {
  test('should open stop popover with correct stop tag', async ({ page }) => {
    await page.goto('/#/blr/stops/08057', { waitUntil: 'load' });
    await expect(page.locator('#stop-popover.expand')).toBeVisible({
      timeout: 20000,
    });
    await expect(page.locator('#stop-popover .stop-tag').first()).toHaveText(
      '08057',
    );
  });

  test('should show arrivals link on stop page', async ({ page }) => {
    await page.goto('/#/blr/stops/08057', { waitUntil: 'load' });
    await expect(page.locator('#stop-popover.expand')).toBeVisible({
      timeout: 20000,
    });
    const arrivalsLink = page.locator('#stop-popover .popover-button.primary');
    await expect(arrivalsLink).toBeVisible();
    const href = await arrivalsLink.getAttribute('href');
    expect(href).toContain('/arrival/');
  });

  test('should close stop popover and return to city root', async ({
    page,
  }) => {
    await page.goto('/#/blr/stops/08057', { waitUntil: 'load' });
    await expect(page.locator('#stop-popover.expand')).toBeVisible({
      timeout: 20000,
    });
    await page.locator('#stop-popover .popover-close').click();
    await expect(page.locator('#stop-popover.expand')).not.toBeVisible({
      timeout: 5000,
    });
    await expect(page).toHaveURL(/\/#\/blr\/?$/);
  });

  test('should open and close service popover', async ({ page }) => {
    await page.goto('/#/blr/services/133', { waitUntil: 'load' });
    await expect(page.locator('#service-popover.expand')).toBeVisible({
      timeout: 20000,
    });
    await page.locator('#service-popover .popover-close').click();
    await expect(page.locator('#service-popover.expand')).not.toBeVisible({
      timeout: 5000,
    });
  });
});
