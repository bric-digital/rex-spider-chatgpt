import { test, expect } from '@playwright/test'

test.describe('shouldCrawl — listing-update-time gate', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/crawl-target.html')
    await page.waitForFunction(() => window.crawlTargetReady === true)
  })

  test('returns true when there is no stored value', async ({ page }) => {
    const result = await page.evaluate(() => window.shouldCrawl(1700000000000, null))
    expect(result).toBe(true)
  })

  test('returns true when listing time is newer than stored', async ({ page }) => {
    const result = await page.evaluate(() => window.shouldCrawl(1700000000000, 1699000000000))
    expect(result).toBe(true)
  })

  test('returns false when listing time is older than stored', async ({ page }) => {
    const result = await page.evaluate(() => window.shouldCrawl(1699000000000, 1700000000000))
    expect(result).toBe(false)
  })

  test('returns false when listing time equals stored (strict greater-than)', async ({ page }) => {
    const result = await page.evaluate(() => window.shouldCrawl(1700000000000, 1700000000000))
    expect(result).toBe(false)
  })
})
