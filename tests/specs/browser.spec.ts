import { test, expect } from './fixtures.js';

/**
 * Comprehensive test suite for webmunk-core list utilities
 * Tests IndexedDB operations, CRUD, pattern matching, and bulk operations
 */

test.describe('Webmunk - REX Spider ChatGPT - Browser', () => {
  test.setTimeout(60_000)  

  test('Validate page loaded.', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/index.html`);

    await expect(page).toHaveTitle(/REX Spider ChatGPT Testing Extension/);
  });
});
