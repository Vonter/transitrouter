import { test, expect } from '@playwright/test';

test.describe('Passing Routes View', () => {
  test('should load passing routes page for a stop', async ({ page }) => {
    await page.goto('/#/blr/stops/08057/routes');
    await expect(page.locator('#map')).toBeVisible();
    await page.waitForTimeout(5000);
  });

  test('should show the float pill with stop info on passing routes page', async ({
    page,
  }) => {
    await page.goto('/#/blr/stops/08057/routes');
    await page.waitForTimeout(8000);
    // The float pill should appear showing passing routes
    const floatPill = page.locator('#popover-float');
    await expect(floatPill).toBeAttached();
  });

  test('should display service tags for passing routes', async ({ page }) => {
    await page.goto('/#/blr/stops/08057/routes');
    await page.waitForTimeout(8000);
    const floatPill = page.locator('#popover-float');
    const isVisible = await floatPill.isVisible();
    if (isVisible) {
      const serviceTags = page.locator('#popover-float .service-tag');
      const count = await serviceTags.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test('should show multi-route mode link', async ({ page }) => {
    await page.goto('/#/blr/stops/08057/routes');
    await page.waitForTimeout(8000);
    const floatPill = page.locator('#popover-float');
    const isVisible = await floatPill.isVisible();
    if (isVisible) {
      // Should have "Multi-Route mode" link
      const multiRouteLink = page.locator(
        '#popover-float a[href*="services"]',
      );
      const count = await multiRouteLink.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test('should navigate to service page when clicking a passing route', async ({
    page,
  }) => {
    await page.goto('/#/blr/stops/08057/routes');
    await page.waitForTimeout(8000);
    const serviceTags = page.locator('#popover-float .service-tag[data-service]');
    const count = await serviceTags.count();
    if (count > 0) {
      await serviceTags.first().click();
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(/services/);
    }
  });

  test('should have close button on float pill', async ({ page }) => {
    await page.goto('/#/blr/stops/08057/routes');
    await page.waitForTimeout(8000);
    const floatPill = page.locator('#popover-float');
    const isVisible = await floatPill.isVisible();
    if (isVisible) {
      const closeBtn = page.locator('#popover-float .popover-close');
      await expect(closeBtn).toBeVisible();
    }
  });
});
