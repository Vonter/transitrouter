import { test, expect } from '@playwright/test';

// Run navigation tests serially — they test sequential flows and are
// sensitive to resource contention from parallel data-heavy tests.
test.describe.configure({ mode: 'serial' });

test.describe('Hash-based Navigation & Routing', () => {
  test('should default to home page on empty hash', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' });
    await expect(page.locator('#map')).toBeVisible();
    await expect(page.locator('#search-popover')).toBeAttached({
      timeout: 10000,
    });
  });

  test('should load stop page on direct navigation', async ({ page }) => {
    await page.goto('/#/blr/stops/08057', { waitUntil: 'load' });
    await expect(page.locator('#stop-popover.expand')).toBeVisible({
      timeout: 20000,
    });
    await expect(page.locator('#stop-popover .stop-tag').first()).toHaveText(
      '08057',
    );
  });

  test('should load service page on direct navigation', async ({ page }) => {
    await page.goto('/#/blr/services/133', { waitUntil: 'load' });
    await expect(page.locator('#service-popover.expand')).toBeVisible({
      timeout: 20000,
    });
  });

  test('should close stop popover via close button', async ({ page }) => {
    await page.goto('/#/blr/stops/08057', { waitUntil: 'load' });
    await expect(page.locator('#stop-popover.expand')).toBeVisible({
      timeout: 20000,
    });
    await page.locator('#stop-popover .popover-close').click();
    await expect(page.locator('#stop-popover.expand')).not.toBeVisible({
      timeout: 5000,
    });
  });

  test('should close service popover via close button', async ({ page }) => {
    await page.goto('/#/blr/services/133', { waitUntil: 'load' });
    await expect(page.locator('#service-popover.expand')).toBeVisible({
      timeout: 20000,
    });
    await page.locator('#service-popover .popover-close').click();
    await expect(page.locator('#service-popover.expand')).not.toBeVisible({
      timeout: 5000,
    });
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

  test('should support deep linking to between routes', async ({ page }) => {
    await page.goto('/#/blr/between/08057/01012', { waitUntil: 'load' });
    await expect(page.locator('#map')).toBeVisible();
    await page.waitForTimeout(3000);
  });

  test('should preserve map across page loads', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' });
    await expect(page.locator('#map')).toBeVisible();

    await page.goto('/#/blr/stops/08057', { waitUntil: 'load' });
    await expect(page.locator('#map')).toBeVisible();

    await page.goto('/#/blr/services/133', { waitUntil: 'load' });
    await expect(page.locator('#map')).toBeVisible();
  });

  test('should return to city root after closing popover', async ({ page }) => {
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

  test('should load multi-route page directly', async ({ page }) => {
    await page.goto('/#/blr/services/133~120', { waitUntil: 'load' });
    await expect(page.locator('#map')).toBeVisible();
    await expect(page.locator('#popover-float')).toBeAttached({
      timeout: 15000,
    });
  });
});
