import { test, expect } from '@playwright/test';

test.describe('Data Loading & API', () => {
  test('should load routes data JSON', async ({ page }) => {
    const response = await page.goto('/data/blr/routes.min.json');
    expect(response.status()).toBe(200);
    const contentType = response.headers()['content-type'];
    expect(contentType).toContain('json');
  });

  test('should load stops data JSON', async ({ page }) => {
    const response = await page.goto('/data/blr/stops.min.json');
    expect(response.status()).toBe(200);
  });

  test('should load services data JSON', async ({ page }) => {
    const response = await page.goto('/data/blr/services.min.json');
    expect(response.status()).toBe(200);
  });

  test('should load firstlast data JSON', async ({ page }) => {
    const response = await page.goto('/data/blr/firstlast.min.json');
    expect(response.status()).toBe(200);
  });

  test('routes JSON should contain valid route data', async ({ page }) => {
    const response = await page.goto('/data/blr/routes.min.json');
    const data = await response.json();
    expect(typeof data).toBe('object');
    const keys = Object.keys(data);
    expect(keys.length).toBeGreaterThan(0);
  });

  test('stops JSON should contain valid stop data', async ({ page }) => {
    const response = await page.goto('/data/blr/stops.min.json');
    const data = await response.json();
    expect(typeof data).toBe('object');
    const keys = Object.keys(data);
    expect(keys.length).toBeGreaterThan(0);
  });

  test('should fetch data files without errors during page load', async ({
    page,
  }) => {
    const failedRequests = [];
    page.on('requestfailed', (req) => {
      // Only track data file failures
      if (req.url().includes('/data/')) {
        failedRequests.push(req.url());
      }
    });
    await page.goto('/');
    await page.waitForTimeout(5000);
    expect(failedRequests).toEqual([]);
  });

  test('should cache data in localStorage after first load', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(8000);
    const storageKeys = await page.evaluate(() => Object.keys(localStorage));
    // lscache should have stored some data
    expect(storageKeys.length).toBeGreaterThan(0);
  });

  test('should load manifest.webmanifest', async ({ page }) => {
    const response = await page.goto('/manifest.webmanifest');
    expect(response.status()).toBe(200);
  });
});

test.describe('Network Requests', () => {
  test('should make requests to data endpoints on main page', async ({
    page,
  }) => {
    const dataRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('.min.json') || req.url().includes('/data/')) {
        dataRequests.push(req.url());
      }
    });
    await page.goto('/');
    await page.waitForTimeout(8000);
    expect(dataRequests.length).toBeGreaterThan(0);
  });

  test('should not have CORS errors loading data files', async ({ page }) => {
    const corsErrors = [];
    page.on('pageerror', (err) => {
      if (err.message.toLowerCase().includes('cors')) {
        corsErrors.push(err.message);
      }
    });
    await page.goto('/');
    await page.waitForTimeout(5000);
    expect(corsErrors).toEqual([]);
  });
});
