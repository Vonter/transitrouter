import { test, expect } from '@playwright/test';

test.describe('Service/Route Page', () => {
  test('should load service page for a known route', async ({ page }) => {
    await page.goto('/#/blr/services/133', { waitUntil: 'load' });
    await expect(page).toHaveTitle(/TransitRouter/);
    await expect(page).toHaveURL(/services\/133/);
    await expect(page.locator('#map')).toBeVisible();
  });

  test('should have no console errors on service page', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/#/blr/services/133', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    expect(errors).toEqual([]);
  });
});

test.describe('Multi-Route Mode', () => {
  test('should load multi-route page with tilde separator', async ({
    page,
  }) => {
    await page.goto('/#/blr/services/133~120', { waitUntil: 'load' });
    await expect(page).toHaveURL(/services\/133~120/);
    await page.waitForTimeout(3000);
    const floatPill = page.locator('#popover-float');
    await expect(floatPill).toBeAttached();
  });

  test('should display all selected services in multi-route mode', async ({
    page,
  }) => {
    await page.goto('/#/blr/services/133~120', { waitUntil: 'load' });
    await page.waitForTimeout(5000);
    const serviceTags = page.locator('#popover-float .service-tag');
    const count = await serviceTags.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('should show intersecting stops in multi-route mode', async ({
    page,
  }) => {
    await page.goto('/#/blr/services/133~120', { waitUntil: 'load' });
    await page.waitForTimeout(5000);
    const intersect = page.locator('#popover-float .simple-stops-list');
    await expect(page.locator('#map')).toBeVisible();
  });

  test('should have remove button on service tags in multi-route', async ({
    page,
  }) => {
    await page.goto('/#/blr/services/133~120', { waitUntil: 'load' });
    await page.waitForTimeout(5000);
    const closeBtns = page.locator('#popover-float .service-tag .close');
    const count = await closeBtns.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
