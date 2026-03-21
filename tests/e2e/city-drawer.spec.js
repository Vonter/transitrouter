import { test, expect } from '@playwright/test';

test.describe('City Drawer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => document.getElementById('app')?.children.length > 0,
      { timeout: 10000 },
    );
  });

  test('should have the city drawer overlay in the DOM', async ({ page }) => {
    await expect(page.locator('#city-drawer-overlay')).toBeAttached();
  });

  test('should have the city drawer element', async ({ page }) => {
    await expect(page.locator('#city-drawer')).toBeAttached();
  });

  test('should open city drawer when logo is clicked', async ({ page }) => {
    await page.locator('#logo').click();
    await expect(page.locator('#city-drawer-overlay.open')).toBeVisible({
      timeout: 3000,
    });
  });

  test('should display city list in the drawer', async ({ page }) => {
    await page.locator('#logo').click();
    await expect(page.locator('#city-drawer-overlay.open')).toBeVisible({
      timeout: 3000,
    });
    const cityItems = page.locator('.drawer-city-item');
    const count = await cityItems.count();
    expect(count).toBeGreaterThan(1);
  });

  test('should display city names with flags', async ({ page }) => {
    await page.locator('#logo').click();
    await expect(page.locator('#city-drawer-overlay.open')).toBeVisible({
      timeout: 3000,
    });
    const flags = page.locator('.drawer-city-flag');
    const count = await flags.count();
    expect(count).toBeGreaterThan(1);
    const names = page.locator('.drawer-city-name');
    const nameCount = await names.count();
    expect(nameCount).toBeGreaterThan(1);
  });

  test('should close city drawer when clicking overlay', async ({ page }) => {
    await page.locator('#logo').click();
    await expect(page.locator('#city-drawer-overlay.open')).toBeVisible({
      timeout: 3000,
    });
    // Click on the overlay (right side, outside the drawer)
    const box = await page.locator('#city-drawer-overlay').boundingBox();
    await page.locator('#city-drawer-overlay').click({
      position: { x: box.width - 20, y: box.height / 2 },
    });
    await expect(page.locator('#city-drawer-overlay.open')).not.toBeVisible({
      timeout: 3000,
    });
  });

  test('should close city drawer with Escape key', async ({ page }) => {
    await page.locator('#logo').click();
    await expect(page.locator('#city-drawer-overlay.open')).toBeVisible({
      timeout: 3000,
    });
    await page.keyboard.press('Escape');
    await expect(page.locator('#city-drawer-overlay.open')).not.toBeVisible({
      timeout: 3000,
    });
  });

  test('should show theme toggle in drawer', async ({ page }) => {
    await page.locator('#logo').click();
    await expect(page.locator('#city-drawer-overlay.open')).toBeVisible({
      timeout: 3000,
    });
    const themeToggle = page.locator('.theme-toggle-track');
    await expect(themeToggle).toBeVisible();
  });

  test('should toggle theme when clicking theme toggle', async ({ page }) => {
    await page.locator('#logo').click();
    await expect(page.locator('#city-drawer-overlay.open')).toBeVisible({
      timeout: 3000,
    });
    const wasDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    await page.locator('.theme-toggle-track').click();
    const isNowDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(isNowDark).not.toBe(wasDark);
  });

  test('should display drawer intro text', async ({ page }) => {
    await page.locator('#logo').click();
    await expect(page.locator('#city-drawer-overlay.open')).toBeVisible({
      timeout: 3000,
    });
    const intro = page.locator('.drawer-intro');
    await expect(intro).toBeVisible();
    const text = await intro.textContent();
    expect(text).toContain('TransitRouter');
  });

  test('should have GitHub link in drawer', async ({ page }) => {
    await page.locator('#logo').click();
    await expect(page.locator('#city-drawer-overlay.open')).toBeVisible({
      timeout: 3000,
    });
    const githubLink = page.locator('.drawer-intro a[href*="github"]');
    await expect(githubLink).toBeVisible();
  });
});
