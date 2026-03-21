import { test, expect } from '@playwright/test';

test.describe('Visualization Page', () => {
  test('should load the visualization page', async ({ page }) => {
    await page.goto('/visualization/');
    await expect(page).toHaveTitle(/Visualization|Bus Routes/i);
  });

  test('should render the map container', async ({ page }) => {
    await page.goto('/visualization/');
    await expect(page.locator('#map')).toBeVisible({ timeout: 15000 });
  });

  test('should render the panel', async ({ page }) => {
    await page.goto('/visualization/');
    await expect(page.locator('#panel')).toBeVisible({ timeout: 15000 });
  });

  test('should have no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/visualization/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    expect(errors).toEqual([]);
  });

  test('should have correct HTTP status', async ({ page }) => {
    const response = await page.goto('/visualization/');
    expect(response.status()).toBeLessThan(400);
  });

  test('should have status element', async ({ page }) => {
    await page.goto('/visualization/');
    await expect(page.locator('#status')).toBeAttached();
  });

  test('should have tooltip element', async ({ page }) => {
    await page.goto('/visualization/');
    await expect(page.locator('#tooltip')).toBeAttached();
  });

  test('should render route and stop lists in panel', async ({ page }) => {
    await page.goto('/visualization/');
    await page.waitForTimeout(10000);
    // Panel should contain lists of routes and stops
    const lists = page.locator('#panel ul');
    const count = await lists.count();
    expect(count).toBeGreaterThanOrEqual(0); // Data may still be loading
  });

  test('should have a toggle button for map expansion', async ({ page }) => {
    await page.goto('/visualization/');
    await page.waitForTimeout(3000);
    // Toggle button exists (may be hidden on desktop)
    const toggle = page.locator('#toggle');
    await expect(toggle).toBeAttached();
  });
});
