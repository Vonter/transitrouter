import { test, expect } from '@playwright/test';

const ROUTES = [
  { path: '/', marker: '#map', name: 'Main Page' },
  { path: '/arrival/#08057', marker: '#arrivals', name: 'Arrival Page' },
  { path: '/beta/first-last/', marker: '#firstlast', name: 'First/Last Page' },
  { path: '/diagram/', marker: 'main', name: 'Diagram Page' },
  { path: '/beta/visualization/', marker: '#map', name: 'Visualization Page' },
];

const HASH_ROUTES = [
  { hash: '#/blr/stops/08057', popover: '#stop-popover', name: 'Stop Page' },
  {
    hash: '#/blr/services/133',
    popover: '#service-popover',
    name: 'Service Page',
  },
  {
    hash: '#/blr/services/133~120',
    popover: '#popover-float',
    name: 'Multi-Route Page',
  },
];

test.describe('Route smoke checks – all pages', () => {
  for (const route of ROUTES) {
    test(`loads ${route.name} (${route.path})`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));

      const response = await page.goto(route.path, {
        waitUntil: 'domcontentloaded',
      });

      expect(response, `No response for ${route.path}`).toBeTruthy();
      expect(response.status(), `${route.path} HTTP error`).toBeLessThan(400);

      await expect(page.locator(route.marker).first()).toBeVisible({
        timeout: 15000,
      });

      expect(errors, `Runtime errors on ${route.path}`).toEqual([]);
    });
  }
});

test.describe('Hash route smoke checks', () => {
  for (const route of HASH_ROUTES) {
    test(`loads ${route.name} (${route.hash})`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto(`/${route.hash}`, { waitUntil: 'domcontentloaded' });

      await expect(page.locator('#map')).toBeVisible({ timeout: 15000 });
      await expect(page.locator(route.popover)).toBeAttached({
        timeout: 15000,
      });

      expect(errors, `Runtime errors on ${route.hash}`).toEqual([]);
    });
  }
});
