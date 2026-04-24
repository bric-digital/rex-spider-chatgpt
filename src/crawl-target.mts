export type CrawlTarget = {
  url: string
  listingUpdateMs: number
  conversationId: string
}

export function shouldCrawl(itemUpdateMs: number, storedUpdateMs: number | null): boolean {
  if (storedUpdateMs === null) {
    return true
  }
  return itemUpdateMs > storedUpdateMs
}
