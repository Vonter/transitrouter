import { test, expect } from '@playwright/test';

test.describe('Bus Arrival Page', () => {
  test('should load arrival page with correct title', async ({ page }) => {
    await page.goto('/arrival/#08057');
    await expect(page).toHaveTitle(/Transit arrival times|arrival/i);
  });

  test('should show arrivals container', async ({ page }) => {
    await page.goto('/arrival/#08057');
    await expect(page.locator('#arrivals')).toBeVisible();
  });

  test('should have correct URL hash', async ({ page }) => {
    await page.goto('/arrival/#08057');
    await expect(page).toHaveURL(/\/arrival\/#08057/);
  });

  test('should render arrival content after loading', async ({ page }) => {
    await page.goto('/arrival/#08057');
    await page.waitForTimeout(5000);
    const arrivalsContent = page.locator('#arrivals');
    await expect(arrivalsContent).toBeVisible();
    const textContent = await arrivalsContent.textContent();
    expect(textContent.length).toBeGreaterThan(0);
  });

  test('should have no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/arrival/#08057', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    expect(errors).toEqual([]);
  });

  test('should load arrival page for city-prefixed stop', async ({ page }) => {
    await page.goto('/arrival/#blr/08057');
    await expect(page.locator('#arrivals')).toBeVisible();
    await page.waitForTimeout(3000);
    const textContent = await page.locator('#arrivals').textContent();
    expect(textContent.length).toBeGreaterThan(0);
  });

  test('should display stop name or information', async ({ page }) => {
    await page.goto('/arrival/#08057');
    await page.waitForTimeout(5000);
    // The arrival page should display something about the stop
    const text = await page.locator('#arrivals').textContent();
    expect(text).toBeTruthy();
  });

  test('should support dark mode via localStorage', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('theme', 'dark');
    });
    await page.goto('/arrival/#08057');
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(isDark).toBe(true);
  });

  test('should be responsive with proper viewport meta', async ({ page }) => {
    await page.goto('/arrival/#08057');
    const viewport = await page.getAttribute(
      'meta[name="viewport"]',
      'content',
    );
    expect(viewport).toContain('width=device-width');
  });
});
