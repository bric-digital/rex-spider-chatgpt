import { Conversation, Turn, DateString, Citation, Search, Result } from '@bric/rex-types/types'

import rexCorePlugin, { EventPayload, dispatchEvent } from '@bric/rex-core/service-worker'
import rexSpiderPlugin, { REXSpider } from '@bric/rex-spider/service-worker'

export class REXChatGPTSpider extends REXSpider {
  sleepDelayMs:number = 10000
  lookbackDays:number = 30
  maxIndexPages:number = 50
  syncing:boolean = false
  lastSync:number = 0
  syncPeriod:number = 300000
  accessToken:string|null = null

  constructor() {
    super()

    // Override sleepDelayMs / lookbackDays / maxIndexPages from server config if provided.
    rexCorePlugin.fetchConfiguration()
      .then((config) => {
        const spiderConfig = (config as Record<string, any>)?.spider?.chatgpt // eslint-disable-line @typescript-eslint/no-explicit-any
        const configuredDelay = spiderConfig?.sleep_delay_ms
        if (typeof configuredDelay === 'number') {
          this.sleepDelayMs = configuredDelay
        }
        const configuredLookback = spiderConfig?.lookback_days
        if (typeof configuredLookback === 'number') {
          this.lookbackDays = configuredLookback
        }
        const configuredMaxPages = spiderConfig?.max_index_pages
        if (typeof configuredMaxPages === 'number') {
          this.maxIndexPages = configuredMaxPages
        }
      })
      .catch((err) => console.warn('[rex-spider-chatgpt] Failed to read spider config:', err))
  }

  private dispatchCompletionEvent(crawledCount: number): void {
    // Delay mirrors the rex-history completion pattern: waits for PDK's
    // persist debounce to expire so queued events flush before the signal.
    setTimeout(() => {
      dispatchEvent({
        name: 'pdk-app-event',
        event_name: 'rex-spider-chatgpt-complete',
        event_details: {
          crawled_count: crawledCount,
          date: Date.now()
        }
      })
    }, 1100)
  }

  fetchUrls(): string[] {
    return ['https://www.perplexity.ai/library']
  }

  name(): string {
    return 'ChatGPT'
  }

  loginUrl(): string {
    return 'https://chatgpt.com/'
  }

  fetchInitialUrls(): string[] {
    return ['https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false']
  }

  checkLogin(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      console.log(`[rex-spider-chatgpt] checkLogin`)
      const indexUrl = 'https://chatgpt.com/'

      fetch(indexUrl)
        .then((response: Response) => {
          if (response.ok) {
            response.text().then((rawHtml) => {
              const lines = rawHtml.match(/[^\r\n]+/g)

              for (const line of lines) {
                if (line.includes('"accessToken"')) {
                  console.log(`[rex-spider-chatgpt] accessToken present.`)

                  resolve(true)
                }
              }

              resolve(false)
            })
          } else {
            resolve(false)
          }
        })
    })
  }

  checkNeedsUpdate(): Promise<boolean> {
    console.log(`[rex-spider-chatgpt] checkNeedsUpdate`)

    return new Promise<boolean>((resolve) => {
      if (this.syncing) {
        console.log(`[rex-spider-chatgpt] Still syncing. Skipping this round...`)
        resolve(true)

        return
      }

      const fetchLastSync = {
        messageType: 'fetchValue',
        key: 'rex-spider-chatgpt-last-sync'
      }

      rexCorePlugin.handleMessage(fetchLastSync, this, (response) => {
        let timestamp = 0

        if (response !== null) {
          timestamp = response
        }

        if (Date.now() < timestamp + this.syncPeriod) {
          console.log(`[rex-spider-chatgpt] Too soon to sync again. Skipping this round...`)
          this.dispatchCompletionEvent(0)
          resolve(true)

          return
        }

        const storeMessage = {
          messageType: 'storeValue',
          key: 'rex-spider-chatgpt-last-sync',
          value: Date.now()
        }

        rexCorePlugin.handleMessage(storeMessage, this, (response) => { // eslint-disable-line @typescript-eslint/no-unused-vars
          this.syncing = true

          const homeUrl = 'https://chatgpt.com/'

          fetch(homeUrl)
            .then((response: Response) => {
              if (!response.ok) {
                console.log(`[rex-spider-chatgpt] Homepage fetch failed (status ${response.status}).`)
                this.syncing = false
                this.dispatchCompletionEvent(0)
                resolve(true) // Error - fall back to DOM scraping...
                return
              }

              response.text().then((rawHtml) => {
                  const lines = rawHtml.match(/[^\r\n]+/g)

                  for (const line of lines) {
                    if (line.includes('"accessToken"')) {
                      console.log(`[rex-spider-chatgpt] accessToken present.`)

                      const startIndex = line.indexOf('"accessToken":"')

                      if (startIndex !== -1) {
                        const prefixStripped = line.substring(startIndex)

                        const tokens = prefixStripped.split('"')

                        if (tokens.length > 3) {
                          this.accessToken = tokens[3]
                        }
                      }
                    }
                  }

                  if (this.accessToken === null) {
                    console.log(`[rex-spider-chatgpt] No access token — user is not logged in.`)
                    this.syncing = false
                    this.dispatchCompletionEvent(0)
                    resolve(true) // Not logged in — fall back to DOM scraping...
                    return
                  }

                  console.log(`[rex-spider-chatgpt] USING ACCESS TOKEN: ${this.accessToken}`)

                    this.pagingCutoff().then((cutoff) => {
                      this.pageIndex(this.accessToken, cutoff).then(async (pagingResult) => {
                      if (pagingResult.firstPageFailed) {
                        this.syncing = false
                        this.dispatchCompletionEvent(0)
                        resolve(true) // Error - fall back to DOM scraping...
                        return
                      }

                      const toCrawl = pagingResult.toCrawl

                      // Also page conversations that live inside Projects (gizmos).
                      // A sidebar failure here is non-fatal: we still crawl the loose
                      // conversations we already have.
                      const projectResult = await this.pageProjectIndex(this.accessToken, cutoff, toCrawl)
                      if (projectResult.sidebarFailed) {
                        console.log(`[rex-spider-chatgpt] Project enumeration failed — continuing with loose conversations only.`)
                      }
                      for (const url of projectResult.toCrawl) {
                        if (!toCrawl.includes(url)) toCrawl.push(url)
                      }

                      let crawledCount = 0

                      console.log(`[rex-spider-chatgpt] Crawl list:`)
                      console.log(toCrawl)

                      if (toCrawl.length === 0) {
                        this.syncing = false
                        this.dispatchCompletionEvent(0)
                        resolve(false)
                        return
                      }

                      const fetchConvo = () => {
                              if (toCrawl.length == 0) {
                                this.syncing = false

                                this.dispatchCompletionEvent(crawledCount)
                                resolve(false)
                              } else {
                                self.setTimeout(() => {
                                  const nextUrl = toCrawl.shift()

                                  console.log(`[rex-spider-chatgpt] Crawl: ${nextUrl}`)

                                  fetch(nextUrl, {
                                    method: 'GET',
                                    headers: {
                                      'Authorization': `Bearer ${this.accessToken}`
                                    }
                                  })
                                    .then((convoResponse: Response) => {
                                      if (convoResponse.ok) {
                                        convoResponse.json().then((result) => {
                                          this.parseConversation(result).then((payload) => {
                                            console.log(`[rex-spider-chatgpt] log:`)
                                            console.log(payload)

                                            if (payload !== null) {
                                              dispatchEvent(payload)
                                              crawledCount += 1
                                            }

                                            fetchConvo()
                                          })
                                        })
                                      } else {
                                        console.log(`[rex-spider-chatgpt] Crawl failed ${nextUrl}. Response:`)
                                        console.log(convoResponse)

                                        this.syncing = false

                                        this.dispatchCompletionEvent(crawledCount)
                                        resolve(true) // Error - fall back to DOM scraping...
                                      }
                                    })
                                }, this.sleepDelayMs)
                              }
                            }

                      fetchConvo()
                    })
                    })
                })
            })
            .catch((err) => {
              console.log(`[rex-spider-chatgpt] Unexpected error during sync:`, err)
              this.syncing = false
              this.dispatchCompletionEvent(0)
              resolve(true) // Error - fall back to DOM scraping...
            })
        })
      })
    })
  }

  private updateTimeMs(raw: unknown): number | null {
    if (typeof raw === 'number') {
      // /backend-api/conversations uses Unix epoch seconds (fractional allowed).
      return raw * 1000
    }
    if (typeof raw === 'string') {
      // /backend-api/gizmos/{id}/conversations uses ISO-8601 strings.
      const parsed = Date.parse(raw)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
    return null
  }

  private async pagingCutoff(): Promise<number> {
    let installTime: number | null = null
    try {
      const response = await chrome.runtime.sendMessage({ messageType: 'getInstallTime' })
      if (typeof response === 'number') {
        installTime = response
      }
    } catch (err) {
      console.log(`[rex-spider-chatgpt] getInstallTime unavailable:`, err)
    }
    // Anchor the lookback window at install time so that as the study runs, the
    // pre-study buffer stays fixed at (install - lookback_days). Conversations
    // updated between install and now are always included. Fall back to
    // (now - lookback_days) when install time isn't known (e.g. rex-dev-extension).
    const anchor = installTime !== null ? installTime : Date.now()
    const cutoff = anchor - this.lookbackDays * 86_400_000
    console.log(`[rex-spider-chatgpt] Paging cutoff: ${new Date(cutoff).toISOString()} (lookbackDays=${this.lookbackDays}, installTime=${installTime})`)
    return cutoff
  }

  private async pageIndex(accessToken: string, cutoff: number): Promise<{ toCrawl: string[], firstPageFailed: boolean }> {
    const pageSize = 28
    const toCrawl: string[] = []

    let offset = 0
    let pageIndex = 0
    let stop = false

    while (!stop && pageIndex < this.maxIndexPages) {
      const indexUrl = `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${pageSize}&order=updated&is_archived=false&is_starred=false`
      console.log(`[rex-spider-chatgpt] Index page ${pageIndex} (offset=${offset}): ${indexUrl}`)

      const response = await fetch(indexUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` }
      })

      if (!response.ok) {
        console.log(`[rex-spider-chatgpt] Index page ${pageIndex} failed (status ${response.status}).`)
        if (pageIndex === 0) {
          return { toCrawl: [], firstPageFailed: true }
        }
        break
      }

      const body = await response.json()
      const items = body?.items ?? []

      for (const item of items) {
        const itemUpdateMs = this.updateTimeMs(item?.update_time)
        if (itemUpdateMs === null) continue
        if (itemUpdateMs >= cutoff) {
          if (item.id !== undefined) {
            const fullUrl = `https://chatgpt.com/backend-api/conversation/${item.id}`
            if (!toCrawl.includes(fullUrl)) toCrawl.push(fullUrl)
          }
        } else {
          stop = true
          break
        }
      }

      if (items.length < pageSize) break
      offset += pageSize
      pageIndex += 1
      if (!stop && pageIndex < this.maxIndexPages) {
        await new Promise((r) => self.setTimeout(r, this.sleepDelayMs))
      }
    }

    return { toCrawl, firstPageFailed: false }
  }

  private async pageProjectIndex(
    accessToken: string,
    cutoff: number,
    existingUrls: string[]
  ): Promise<{ toCrawl: string[], sidebarFailed: boolean }> {
    const toCrawl: string[] = []

    try {
      // Step 1: list projects via the gizmos sidebar.
      // conversations_per_gizmo=0 so we don't waste payload — we page each project explicitly below.
      // limit must be ≤20; the server returns 422 for higher values. Paginate via the response's
      // `cursor` field for users with more than 20 projects.
      const gizmoIds: string[] = []
      let sidebarCursor: string | null = null
      let sidebarPageIndex = 0

      while (sidebarPageIndex === 0 || (sidebarCursor !== null && sidebarPageIndex < this.maxIndexPages)) {
        const cursorQs = sidebarCursor === null ? '' : `&cursor=${encodeURIComponent(sidebarCursor)}`
        const sidebarUrl = `https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=20${cursorQs}`
        console.log(`[rex-spider-chatgpt] Project sidebar page ${sidebarPageIndex}: ${sidebarUrl}`)

        const sidebarResp = await fetch(sidebarUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${accessToken}` }
        })

        if (!sidebarResp.ok) {
          console.log(`[rex-spider-chatgpt] Project sidebar page ${sidebarPageIndex} failed (status ${sidebarResp.status}).`)
          // First-page failure is the only case that blocks enumeration. Later-page failures
          // just stop pagination early and we use what we have so far.
          if (sidebarPageIndex === 0) {
            return { toCrawl, sidebarFailed: true }
          }
          break
        }

        const sidebarBody = await sidebarResp.json()

        // The sidebar response nests the gizmo ID at items[].gizmo.gizmo.id. Fall back to
        // items[].gizmo.id and items[].id so a future API reshape doesn't silently break us.
        const sidebarItems = sidebarBody?.items ?? []
        for (const entry of sidebarItems) {
          const candidate = entry?.gizmo?.gizmo?.id ?? entry?.gizmo?.id ?? entry?.id
          if (typeof candidate === 'string' && candidate.startsWith('g-p-')) {
            gizmoIds.push(candidate)
          }
        }

        const nextCursor = sidebarBody?.cursor
        sidebarCursor = typeof nextCursor === 'string' && nextCursor.length > 0 ? nextCursor : null
        sidebarPageIndex += 1

        if (sidebarCursor !== null && sidebarPageIndex < this.maxIndexPages) {
          await new Promise((r) => self.setTimeout(r, this.sleepDelayMs))
        }
      }
      console.log(`[rex-spider-chatgpt] Projects found: ${gizmoIds.length}`)

      // Step 2: for each project, page its conversations with cursor pagination.
      for (const gizmoId of gizmoIds) {
        // Initial cursor is '0' to match the captured Network tab request. The cursor field is
        // opaque — on subsequent requests we pass through whatever the API returned verbatim.
        let cursor: string | null = '0'
        let projectPageIndex = 0
        let stop = false

        while (!stop && cursor !== null && projectPageIndex < this.maxIndexPages) {
          const cursorQs = encodeURIComponent(cursor)
          const indexUrl = `https://chatgpt.com/backend-api/gizmos/${gizmoId}/conversations?cursor=${cursorQs}`
          console.log(`[rex-spider-chatgpt] Project ${gizmoId} page ${projectPageIndex}: ${indexUrl}`)

          const response = await fetch(indexUrl, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${accessToken}` }
          })

          if (!response.ok) {
            console.log(`[rex-spider-chatgpt] Project ${gizmoId} page ${projectPageIndex} failed (status ${response.status}).`)
            break
          }

          const body = await response.json()
          const items = body?.items ?? []

          for (const item of items) {
            const itemUpdateMs = this.updateTimeMs(item?.update_time)
            if (itemUpdateMs === null) continue
            if (itemUpdateMs >= cutoff) {
              if (item.id !== undefined) {
                const fullUrl = `https://chatgpt.com/backend-api/conversation/${item.id}`
                if (!toCrawl.includes(fullUrl) && !existingUrls.includes(fullUrl)) {
                  toCrawl.push(fullUrl)
                }
              }
            } else {
              stop = true
              break
            }
          }

          const nextCursor = body?.cursor
          cursor = typeof nextCursor === 'string' && nextCursor.length > 0 ? nextCursor : null
          projectPageIndex += 1

          if (!stop && cursor !== null && projectPageIndex < this.maxIndexPages) {
            await new Promise((r) => self.setTimeout(r, this.sleepDelayMs))
          }
        }
      }

      return { toCrawl, sidebarFailed: false }
    } catch (err) {
      console.log(`[rex-spider-chatgpt] pageProjectIndex threw unexpectedly:`, err)
      return { toCrawl, sidebarFailed: true }
    }
  }

  parseConversation(conversationJson):Promise<any|null> {
    return new Promise((resolve) => {
      console.log(`[rex-spider-chatgpt] parseConversation:`)
      console.log(conversationJson)

      let firstWhen = new Date(conversationJson['create_time'] * 1000)

      let latestDate = firstWhen

      let firstWhenString:DateString = new DateString(conversationJson['create_time'])

      const conversation:Conversation = {
        turns:[],
        platform: 'chatgpt',
        identifier: conversationJson['conversation_id'],
        started: firstWhenString,
        ended:firstWhenString,
        metadata: conversationJson // TODO: Pull out so only populated on debug=true
      }

      const convoIds = ['client-created-root']

      while (convoIds.length > 0) {
        const convoId = convoIds.shift()

        const turnJson = conversationJson['mapping'][convoId]

        if (turnJson !== undefined) {
          let createTime = firstWhenString

          if (turnJson.message !== null) {
            if (turnJson['create_time'] !== null) {
              createTime = new DateString(`${turnJson['create_time'] * 1000}`)
            }

            const turn:Turn = {
              speaker: turnJson.message.author.role,
              when: createTime,
              identifier: turnJson.message.id,
              'content*': null,
              'metadata*': turnJson,
              'parent': turnJson.parent,
            }

            if (turnJson.message.content.parts !== undefined) {
              turn['content*'] = turnJson.message.content.parts.join('\n')
            } else if (turnJson.message.content.text !== undefined) {
              turn['content*'] = turnJson.message.content.text
            }

            if (turnJson.metadata !== undefined) {
              if (turnJson.metadata['search_result_groups'] !== undefined) {
                const search:Search = {
                    platform: 'chatgpt',
                    'query*': '?',
                    type: 'web',
                    results: []
                }

                for (const searchGroup of turnJson.metadata['search_result_groups']) {
                  for (const entry in searchGroup.entries) {
                    search.results.push({
                      title: entry['title'],
                      url: entry['url'],
                      preview: entry['snippet'],
                      index: entry['ref_id']['ref_index'],
                      metadata: entry,
                    })
                  }
                }

                turn.search = search
              }

              if (turnJson.metadata['content_references'] !== undefined) {
                turn.citations = []

                for (const contentReference of turnJson.metadata['content_references']) {
                  for (const item of contentReference['items']) {
                    const citation:Citation = {
                      title: item.title,
                      url: item.url,
                      source: item.attribution
                    }

                    if (item.attributions !== null) {
                      citation.source = item.attributions.join(', ')
                    }

                    turn.citations.push(citation)
                  }
                }
              }
            }

            conversation.turns.push(turn)
          }

          for (const childId of turnJson.children) {
            convoIds.push(childId)
          }

        }
      }

      const lastUpdateKey = `${conversation.platform}-${conversation.identifier}-last-update`

      const message = {
        messageType: 'fetchValue',
        key: lastUpdateKey
      }

      rexCorePlugin.handleMessage(message, this, (response) => {
        let timestamp = 0

        if (response !== null) {
          timestamp = response
        }

        console.log(`[rex-spider-chatgpt] TS TEST ${timestamp} <? ${latestDate.valueOf()}`)

        if (timestamp < latestDate.valueOf()) {
          const payload:EventPayload = {
            name: 'rex-conversation',
            date: firstWhen,
            ...conversation
          }

          console.log(`[rex-spider-chatgpt] log:`)
          console.log(payload)

          const storeMessage = {
            messageType: 'storeValue',
            key: lastUpdateKey,
            value: latestDate.valueOf()
          }

          rexCorePlugin.handleMessage(storeMessage, this, (response) => { // eslint-disable-line @typescript-eslint/no-unused-vars
            console.log(`[rex-spider-chatgpt] ${lastUpdateKey} = ${latestDate.valueOf()}`)

            resolve(payload)
          })

          return
        } else {
          resolve(null)
        }
      })
    })
  }
}

const chatGPTSpider = new REXChatGPTSpider()

rexSpiderPlugin.registerSpider(chatGPTSpider)

export default chatGPTSpider