import { test, expect, devices } from '@playwright/test';

test.describe('Responsive Design & Accessibility', () => {
  test('should have accessible page title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/TransitRouter/);
  });

  test('should have viewport meta tag for mobile', async ({ page }) => {
    await page.goto('/');
    const viewport = await page.getAttribute(
      'meta[name="viewport"]',
      'content',
    );
    expect(viewport).toContain('width=device-width');
  });

  test('should have PWA manifest link', async ({ page }) => {
    await page.goto('/');
    const manifest = page.locator('link[rel="manifest"]');
    await expect(manifest).toBeAttached();
  });

  test('should have apple-touch-icon', async ({ page }) => {
    await page.goto('/');
    const icon = page.locator('link[rel="apple-touch-icon"]');
    await expect(icon).toBeAttached();
  });

  test('should have apple-mobile-web-app-capable meta', async ({ page }) => {
    await page.goto('/');
    const capable = await page.getAttribute(
      'meta[name="apple-mobile-web-app-capable"]',
      'content',
    );
    expect(capable).toBe('yes');
  });

  test('should have Open Graph meta tags', async ({ page }) => {
    await page.goto('/');
    const ogTitle = await page.getAttribute(
      'meta[property="og:title"]',
      'content',
    );
    expect(ogTitle).toContain('TransitRouter');
    const ogDescription = await page.getAttribute(
      'meta[property="og:description"]',
      'content',
    );
    expect(ogDescription).toBeTruthy();
    const ogImage = await page.getAttribute(
      'meta[property="og:image"]',
      'content',
    );
    expect(ogImage).toBeTruthy();
  });

  test('should have twitter card meta tags', async ({ page }) => {
    await page.goto('/');
    const twitterCard = await page.getAttribute(
      'meta[name="twitter:card"]',
      'content',
    );
    expect(twitterCard).toBe('summary_large_image');
  });

  test('should display noscript message', async ({ page }) => {
    // Noscript content should exist in DOM
    const noscript = page.locator('noscript');
    await page.goto('/');
    await expect(noscript).toBeAttached();
  });

  test('search input should have proper autocomplete attributes', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => document.getElementById('app')?.children.length > 0,
      { timeout: 10000 },
    );
    const search = page.locator('#search-popover input[type="search"]');
    await expect(search).toBeAttached({ timeout: 15000 });
    await expect(search).toHaveAttribute('autocomplete', 'off');
    await expect(search).toHaveAttribute('autocorrect', 'off');
  });

  test('should render popover handle for mobile drag', async ({ page }) => {
    await page.goto('/#/blr/stops/08057');
    await expect(page.locator('#stop-popover')).toBeAttached({
      timeout: 15000,
    });
    const handle = page.locator('#stop-popover .popover-handle');
    await expect(handle).toBeAttached();
  });

  test('logo SVG should have accessible title', async ({ page }) => {
    await page.goto('/');
    const svgTitle = page.locator('#logo svg title');
    await expect(svgTitle).toBeAttached();
    const text = await svgTitle.textContent();
    expect(text).toBe('TransitRouter');
  });
});

test.describe('Desktop Layout', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('should show map and search side by side on desktop', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#map')).toBeVisible();
    await page.waitForFunction(
      () => document.getElementById('app')?.children.length > 0,
      { timeout: 10000 },
    );
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox.width).toBeGreaterThan(400);
  });
});

test.describe('Mobile Layout', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('should show map on mobile viewport', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#map')).toBeVisible();
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox.width).toBeLessThanOrEqual(375);
  });

  test('should show search on mobile viewport', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => document.getElementById('app')?.children.length > 0,
      { timeout: 10000 },
    );
    const search = page.locator('input[type="search"]').first();
    await expect(search).toBeVisible();
  });
});
