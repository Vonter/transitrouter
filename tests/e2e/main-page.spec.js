import { test, expect } from '@playwright/test';

test.describe('Main Page', () => {
  test('should load the root page successfully', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/TransitRouter/);
    await expect(page.locator('#logo')).toBeVisible();
    await expect(page.locator('#map')).toBeVisible();
  });

  test('should render the app container with content', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => {
        const app = document.getElementById('app');
        return app && app.children.length > 0;
      },
      { timeout: 10000 },
    );
    const app = page.locator('#app');
    await expect(app).not.toBeEmpty();
  });

  test('should display the search input', async ({ page }) => {
    await page.goto('/');
    const search = page.locator('input[type="search"]').first();
    await expect(search).toBeVisible();
    await expect(search).toBeEnabled({ timeout: 10000 });
  });

  test('should have the map container visible', async ({ page }) => {
    await page.goto('/');
    const map = page.locator('#map');
    await expect(map).toBeVisible();
    const box = await map.boundingBox();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(100);
  });

  test('should have correct meta tags', async ({ page }) => {
    await page.goto('/');
    const description = await page.getAttribute(
      'meta[name="description"]',
      'content',
    );
    expect(description).toContain('transit');
  });

  test('should show the search popover element', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => document.getElementById('search-popover'),
      { timeout: 10000 },
    );
    await expect(page.locator('#search-popover')).toBeAttached();
  });

  test('should load route service list', async ({ page }) => {
    await page.goto('/');
    // Wait for services to load (placeholder items or real ones)
    await expect(
      page.locator('#search-popover .popover-list li').first(),
    ).toBeVisible({ timeout: 15000 });
  });

  test('should have no console errors on load', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    expect(errors).toEqual([]);
  });

  test('should have a tooltip element', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#tooltip')).toBeAttached();
  });
});
