import { Conversation, Turn, DateString, Citation, Search } from '@bric/rex-types/types'

import rexCorePlugin, { EventPayload, dispatchEvent } from '@bric/rex-core/service-worker'
import rexSpiderPlugin, { REXSpider, REXSpiderCrawlResult } from '@bric/rex-spider/service-worker'

import { CrawlTarget, shouldCrawl } from './crawl-target.mjs'

export class REXChatGPTSpider extends REXSpider {
  sleepDelayMs: number = 10000
  lookbackDays: number = 30
  maxIndexPages: number = 50
  syncing: boolean = false
  lastSync: number = 0
  syncPeriod: number = 300000
  accessToken: string | null = null
  // Whether routine per-run *-complete events are emitted (config
  // spider.chatgpt.emit_run_complete). Watchdog-recovered completions are
  // always emitted regardless.
  emitRunComplete: boolean = true
  // Guards dispatchCompletionEvent against double-fire from the watchdog
  // racing a natural-path terminal branch. Reset at the top of each
  // checkNeedsUpdate run.
  private completed: boolean = false

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
        const configuredEmitRunComplete = spiderConfig?.emit_run_complete
        if (typeof configuredEmitRunComplete === 'boolean') {
          this.emitRunComplete = configuredEmitRunComplete
        }
      })
      .catch((err) => console.warn('[rex-spider-chatgpt] Failed to read spider config:', err))
  }

  private dispatchCompletionEvent(crawledCount: number, crawledIds:string[] = [], accountCompleteReason: 'date-floor' | 'exhausted' | null = null, recovered: boolean = false): void {
    if (this.completed) return
    this.completed = true
    // Delay mirrors the rex-history completion pattern: waits for PDK's
    // persist debounce to expire so queued events flush before the signal.
    setTimeout(() => {
      // The per-run event fires on every exit path including errors and
      // skips; deployments that only consume account-complete can silence it
      // via config spider.chatgpt.emit_run_complete: false. A completion the
      // watchdog recovered is always emitted, marked recovered_via so
      // consumers (e.g. Keystone offboarding) can treat it as terminal.
      if (recovered || this.emitRunComplete) {
        dispatchEvent({
          name: 'pdk-app-event',
          event_name: 'rex-spider-chatgpt-complete',
          event_details: {
            crawled_count: crawledCount,
            crawled_ids: crawledIds,
            date: Date.now(),
            ...(recovered ? { recovered_via: 'watchdog' } : {})
          }
        })
      }

      // Account-complete only accompanies runs that enumerated the full
      // account (index paging ended at the cutoff or ran out of items, and
      // every queued conversation was captured).
      if (accountCompleteReason !== null) {
        this.signalAccountComplete({
          reason: accountCompleteReason,
          crawled_count: crawledCount
        })
      }
    }, 1100)
  }

  fetchUrls(): string[] {
    return ['https://www.chatgpt.com/']
  }

  name(): string {
    return 'ChatGPT'
  }

  identifier(): string {
    return 'chatgpt'
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

              if (lines !== null) {
                for (const line of lines) {
                  if (line.includes('"accessToken"')) {
                    console.log(`[rex-spider-chatgpt] accessToken present.`)

                    resolve(true)
                  }
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
      // Reset completion-idempotency flag at the top of every entry so the
      // "too soon to sync" short-circuit and full runs can each fire exactly
      // one *-complete event for that round.
      this.completed = false

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

          // Arm the rex-spider watchdog. If the run wedges (hung fetch,
          // parser exception that escapes the catch chain, etc.), the
          // watchdog runs onTimeout below to clear `syncing`, dispatch
          // *-complete, and let offboarding proceed. The completed flag
          // on dispatchCompletionEvent prevents a double-fire if a
          // delayed natural-path branch later runs to completion.
          this.beginRun(() => {
            this.syncing = false
            // recovered=true: marked recovered_via 'watchdog' and emitted even
            // when routine per-run completes are silenced — offboarding needs it.
            this.dispatchCompletionEvent(0, [], null, true) // crawled count unknown from here
            resolve(true)
          })

          const homeUrl = 'https://chatgpt.com/'

          fetch(homeUrl)
            .then((response: Response) => {
              if (!response.ok) {
                console.log(`[rex-spider-chatgpt] Homepage fetch failed (status ${response.status}).`)
                this.syncing = false
                this.endRun()
                this.dispatchCompletionEvent(0)
                resolve(true) // Error - fall back to DOM scraping...
                return
              }

              response.text().then((rawHtml) => {
                const lines = rawHtml.match(/[^\r\n]+/g)

                if (lines !== null) {
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
                }

                if (this.accessToken === null) {
                  console.log(`[rex-spider-chatgpt] No access token — user is not logged in.`)
                  this.syncing = false
                  this.endRun()
                  this.dispatchCompletionEvent(0)
                  resolve(true) // Not logged in — fall back to DOM scraping...
                  return
                }

                console.log(`[rex-spider-chatgpt] USING ACCESS TOKEN: ${this.accessToken}`)

                this.pagingCutoff().then((cutoff) => {
                  if (this.accessToken !== null) {
                    this.pageIndex(this.accessToken, cutoff).then(async (pagingResult) => {
                      if (pagingResult.firstPageFailed) {
                        this.syncing = false
                        this.endRun()
                        this.dispatchCompletionEvent(0)
                        resolve(true) // Error - fall back to DOM scraping...
                        return
                      }

                      const toCrawl = pagingResult.toCrawl

                      // Non-null only while this run is still on track to have
                      // enumerated the entire account (loose conversations AND
                      // projects). Any cap, page failure, or crawl failure
                      // clears it, suppressing the account-complete signal.
                      let accountEndReason = pagingResult.endReason

                      if (this.accessToken !== null) {
                        // Also page conversations that live inside Projects (gizmos).
                        // A partial failure here is non-fatal: whatever project URLs we did
                        // collect are still appended, and loose conversations already crawled.
                        const projectResult = await this.pageProjectIndex(this.accessToken, cutoff, toCrawl)

                        if (projectResult.partialFailure) {
                          console.log(`[rex-spider-chatgpt] Project enumeration hit a partial failure — using whatever was collected.`)
                        }

                        if (projectResult.complete === false) {
                          accountEndReason = null
                        }

                        for (const target of projectResult.toCrawl) {
                          if (!toCrawl.some((t) => t.conversationId === target.conversationId)) {
                            toCrawl.push(target)
                          }
                        }

                      }


                      let crawledCount = 0

                      console.log(`[rex-spider-chatgpt] Crawl list:`)
                      console.log(toCrawl)

                      if (toCrawl.length === 0) {
                        this.syncing = false
                        this.endRun()
                        this.dispatchCompletionEvent(0, accountEndReason)
                        resolve(false)
                        return
                      }

                      const fetchConvo = () => {
                        if (toCrawl.length == 0) {
                          this.syncing = false
                          this.endRun()
                          this.dispatchCompletionEvent(crawledCount, accountEndReason)
                          resolve(false)
                          return
                        }

                        self.setTimeout(() => {
                          const next = toCrawl.shift()!
                          console.log(`[rex-spider-chatgpt] Crawl: ${next.url}`)

                          fetch(next.url, {
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
                                      this.noteProgress()
                                      this.storeLastUpdate(next.conversationId, next.listingUpdateMs)
                                        .catch((err) => console.log(`[rex-spider-chatgpt] storeLastUpdate failed for ${next.conversationId}:`, err))
                                        .finally(() => fetchConvo())
                                      return
                                    }

                                    accountEndReason = null // conversation yielded no payload — account not fully captured
                                    fetchConvo()
                                  })
                                })
                              } else {
                                console.log(`[rex-spider-chatgpt] Crawl failed ${next.url}. Response:`)
                                console.log(convoResponse)

                                this.syncing = false
                                this.endRun()
                                this.dispatchCompletionEvent(crawledCount)
                                resolve(true) // Error - fall back to DOM scraping...
                              }
                            })
                            .catch((err) => {
                              // Any throw inside the fetch/json/parse chain (bad payload,
                              // DateString rejection, etc.) must not leave syncing=true,
                              // or every subsequent round prints "Still syncing..." and
                              // the spider is wedged until the service worker restarts.
                              // Log this conversation as failed and continue with the rest.
                              console.log(`[rex-spider-chatgpt] Crawl errored for ${next.url}:`, err)
                              accountEndReason = null // this conversation was not captured; retried next run
                              fetchConvo()
                            })
                        }, this.sleepDelayMs)
                      }

                      fetchConvo()
                    })

                  }
                })
              })
            })
            .catch((err) => {
              console.log(`[rex-spider-chatgpt] Unexpected error during sync:`, err)
              this.syncing = false
              this.endRun()
              this.dispatchCompletionEvent(0)
              resolve(true) // Error - fall back to DOM scraping...
            })
        })
      })
    })
  }

  whitelistedUrls():string[] {
    return [
      '|https://chatgpt.com/|',
      '|https://chatgpt.com/backend-api/conversations?*',
      '|https://chatgpt.com/backend-api/conversation/*',
      '|https://chatgpt.com/backend-api/gizmos/*/conversations/*',
      '|https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?*',
    ]
  }

  doBackgroundCrawl():Promise<REXSpiderCrawlResult> {
    return new Promise<REXSpiderCrawlResult>((resolve) => {
      this.completed = false

      const fetchLastSync = {
        messageType: 'fetchValue',
        key: 'rex-spider-chatgpt-last-sync'
      }

      const crawledIds:string[] = []

      rexCorePlugin.handleMessage(fetchLastSync, this, (response) => {
        let lastSynchTs = 0

        if (response !== null) {
          lastSynchTs = response
        }

        const when:Date = new Date(lastSynchTs)

        if (this.syncing) {
          console.log(`[rex-spider-chatgpt] Still syncing. Skipping this round...`)

          resolve({
            sitesCrawled: [this.identifier()],
            issues: [{
              url: this.loginUrl(),
              message: `Still synching since ${when}.`
            }]
          })
        } else if (Date.now() < lastSynchTs + this.syncPeriod) {
          console.log(`[rex-spider-chatgpt] Too soon to sync again. Skipping this round...`)
          this.dispatchCompletionEvent(0, crawledIds)

          resolve({
            sitesCrawled: [this.identifier()],
            issues: [{
              url: this.loginUrl(),
              message: `Too soon to synch since ${when} (period = ${this.syncPeriod}).`
            }]
          })
        } else {
          const storeMessage = {
            messageType: 'storeValue',
            key: 'rex-spider-chatgpt-last-sync',
            value: Date.now()
          }

          rexCorePlugin.handleMessage(storeMessage, this, (response) => { // eslint-disable-line @typescript-eslint/no-unused-vars
            this.syncing = true

            // Arm the rex-spider watchdog. If the run wedges (hung fetch,
            // parser exception that escapes the catch chain, etc.), the
            // watchdog runs onTimeout below to clear `syncing`, dispatch
            // *-complete, and let offboarding proceed. The completed flag
            // on dispatchCompletionEvent prevents a double-fire if a
            // delayed natural-path branch later runs to completion.
            this.beginRun(() => {
              this.syncing = false
              // recovered=true: marked recovered_via 'watchdog' and emitted even
              // when routine per-run completes are silenced — offboarding needs it.
              this.dispatchCompletionEvent(0, crawledIds, null, true) // crawled count unknown from here

              resolve({
                sitesCrawled: [this.identifier()],
                issues: [{
                  url: this.loginUrl(),
                  message: `Watchdog timer expired.`
                }]
              })
            })

            const homeUrl = 'https://chatgpt.com/'

            fetch(homeUrl)
              .then((response: Response) => {
                if (!response.ok) {
                  console.log(`[rex-spider-chatgpt] Homepage fetch failed (status ${response.status}).`)
                  this.syncing = false
                  this.endRun()
                  this.dispatchCompletionEvent(0, crawledIds)

                  resolve({
                    sitesCrawled: [this.identifier()],
                    issues: [{
                      url: this.loginUrl(),
                      message: `Unable to fetch ${homeUrl}. Status code = ${response.status}.`
                    }]
                  })
                } else {
                  response.text().then((rawHtml) => {
                    const lines = rawHtml.match(/[^\r\n]+/g)

                    if (lines !== null) {
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
                    }

                    if (this.accessToken === null) {
                      console.log(`[rex-spider-chatgpt] No access token — user is not logged in.`)
                      this.syncing = false
                      this.endRun()
                      this.dispatchCompletionEvent(0, crawledIds)

                      resolve({
                        sitesCrawled: [this.identifier()],
                        issues: [{
                          url: this.loginUrl(),
                          message: `User not logged in.`
                        }]
                      })
                    } else {
                      console.log(`[rex-spider-chatgpt] USING ACCESS TOKEN: ${this.accessToken}`)

                      this.pagingCutoff().then((cutoff) => {
                        if (this.accessToken !== null) {
                          this.pageIndex(this.accessToken, cutoff).then(async (pagingResult) => {
                            if (pagingResult.firstPageFailed) {
                              this.syncing = false
                              this.endRun()
                              this.dispatchCompletionEvent(0, crawledIds)

                              resolve({
                                sitesCrawled: [this.identifier()],
                                issues: [{
                                  url: this.loginUrl(),
                                  message: `Unable to fetch first page of results.`
                                }]
                              })
                            } else if (this.accessToken !== null) {
                              const toCrawl = pagingResult.toCrawl

                              // Non-null only while this run is still on track to have
                              // enumerated the entire account (loose conversations AND
                              // projects). Any cap, page failure, or crawl failure
                              // clears it, suppressing the account-complete signal.
                              let accountEndReason = pagingResult.endReason

                              // Also page conversations that live inside Projects (gizmos).
                              // A partial failure here is non-fatal: whatever project URLs we did
                              // collect are still appended, and loose conversations already crawled.
                              const projectResult = await this.pageProjectIndex(this.accessToken, cutoff, toCrawl)

                              if (projectResult.partialFailure) {
                                console.log(`[rex-spider-chatgpt] Project enumeration hit a partial failure — using whatever was collected.`)
                              }

                              if (projectResult.complete === false) {
                                accountEndReason = null
                              }

                              for (const target of projectResult.toCrawl) {
                                if (!toCrawl.some((t) => t.conversationId === target.conversationId)) {
                                  toCrawl.push(target)
                                }
                              }

                              let crawledCount = 0

                              console.log(`[rex-spider-chatgpt] Crawl list:`)
                              console.log(toCrawl)

                              if (toCrawl.length === 0) {
                                this.syncing = false
                                this.endRun()
                                this.dispatchCompletionEvent(0, crawledIds, accountEndReason)

                                resolve({
                                  sitesCrawled: [this.identifier()],
                                  issues: [{
                                    url: this.loginUrl(),
                                    message: `No conversations to crawl: ${accountEndReason}.`
                                  }]
                                })
                              } else {
                                const fetchConvo = () => {
                                  if (toCrawl.length == 0) {
                                    this.syncing = false
                                    this.endRun()
                                    this.dispatchCompletionEvent(crawledCount, crawledIds, accountEndReason)

                                    resolve({
                                      sitesCrawled: [this.identifier()],
                                      issues: []
                                    })
                                  } else {
                                    self.setTimeout(() => {
                                      const next = toCrawl.shift()!
                                      console.log(`[rex-spider-chatgpt] Crawl: ${next.url}`)

                                      fetch(next.url, {
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

                                                  crawledIds.push(next.conversationId)
                                                  
                                                  crawledCount += 1
                                                  this.noteProgress()
                                                  this.storeLastUpdate(next.conversationId, next.listingUpdateMs)
                                                    .catch((err) => console.log(`[rex-spider-chatgpt] storeLastUpdate failed for ${next.conversationId}:`, err))
                                                    .finally(() => fetchConvo())
                                                } else {
                                                  accountEndReason = null // conversation yielded no payload — account not fully captured
                                                  fetchConvo()
                                                }
                                              })
                                            })
                                          } else {
                                            console.log(`[rex-spider-chatgpt] Crawl failed ${next.url}. Response:`)
                                            console.log(convoResponse)

                                            this.syncing = false
                                            this.endRun()
                                            this.dispatchCompletionEvent(crawledCount, crawledIds)

                                            resolve({
                                              sitesCrawled: [this.identifier()],
                                              issues: [{
                                                url: next.url,
                                                message: `Unable to fetch ${next.url}. Status code = ${convoResponse.status}.`
                                              }]
                                            })
                                          }
                                        })
                                        .catch((err) => {
                                          // Any throw inside the fetch/json/parse chain (bad payload,
                                          // DateString rejection, etc.) must not leave syncing=true,
                                          // or every subsequent round prints "Still syncing..." and
                                          // the spider is wedged until the service worker restarts.
                                          // Log this conversation as failed and continue with the rest.
                                          console.log(`[rex-spider-chatgpt] Crawl errored for ${next.url}:`, err)
                                          accountEndReason = null // this conversation was not captured; retried next run
                                          fetchConvo()
                                        })
                                    }, this.sleepDelayMs)
                                  }
                                }

                                fetchConvo()
                              }
                            }
                          })
                       }
                      })
                    }
                  })
                }
              })
              .catch((err) => {
                console.log(`[rex-spider-chatgpt] Unexpected error during sync:`, err)
                this.syncing = false
                this.endRun()
                this.dispatchCompletionEvent(0, crawledIds)

                resolve({
                  sitesCrawled: [this.identifier()],
                  issues: [{
                    url: this.loginUrl(),
                    message: `Error fetching conversations: ${err}.`
                  }]
                })
              })
          })
        }
      })
    })
  }

  private fetchLastUpdate(conversationId: string): Promise<number | null> {
    return new Promise((resolve) => {
      const key = `chatgpt-${conversationId}-last-update`
      rexCorePlugin.handleMessage({ messageType: 'fetchValue', key }, this, (response) => {
        if (typeof response === 'number') {
          resolve(response)
        } else {
          resolve(null)
        }
      })
    })
  }

  private storeLastUpdate(conversationId: string, listingUpdateMs: number): Promise<void> {
    return new Promise((resolve) => {
      const key = `chatgpt-${conversationId}-last-update`
      rexCorePlugin.handleMessage(
        { messageType: 'storeValue', key, value: listingUpdateMs },
        this,
        () => resolve()
      )
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

  private async pageIndex(accessToken: string, cutoff: number): Promise<{ toCrawl: CrawlTarget[], firstPageFailed: boolean, endReason: 'date-floor' | 'exhausted' | null }> {
    const pageSize = 28
    const toCrawl: CrawlTarget[] = []

    let offset = 0
    let pageIndex = 0
    let stop = false

    // Why paging ended: 'date-floor' (crossed the cutoff) or 'exhausted'
    // (no more items) both mean the whole account was enumerated. null means
    // it ended early — maxIndexPages cap or a failed page — so completion of
    // this run does NOT imply the account is fully collected.
    let endReason: 'date-floor' | 'exhausted' | null = null

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
          return { toCrawl: [], firstPageFailed: true, endReason: null }
        }
        break
      }

      const body = await response.json()
      const items = body?.items ?? []

      // Each fetched index page is progress: long paging phases (dozens of
      // pages x sleep_delay_ms) must not trip the stuck-run watchdog.
      this.noteProgress()

      for (const item of items) {
        const itemUpdateMs = this.updateTimeMs(item?.update_time)
        if (itemUpdateMs === null) continue
        if (itemUpdateMs >= cutoff) {
          if (item.id !== undefined) {
            const stored = await this.fetchLastUpdate(item.id)
            if (!shouldCrawl(itemUpdateMs, stored)) {
              console.log(`[rex-spider-chatgpt] Skipping ${item.id} — listing update_time (${itemUpdateMs}) not newer than stored (${stored})`)
              continue
            }
            const fullUrl = `https://chatgpt.com/backend-api/conversation/${item.id}`
            if (!toCrawl.some((t) => t.conversationId === item.id)) {
              toCrawl.push({ url: fullUrl, listingUpdateMs: itemUpdateMs, conversationId: item.id })
            }
          }
        } else {
          stop = true
          endReason = 'date-floor'
          break
        }
      }

      if (items.length < pageSize) {
        if (endReason === null) {
          endReason = 'exhausted'
        }
        break
      }
      offset += pageSize
      pageIndex += 1
      if (!stop && pageIndex < this.maxIndexPages) {
        await new Promise((r) => self.setTimeout(r, this.sleepDelayMs))
      }
    }

    return { toCrawl, firstPageFailed: false, endReason }
  }

  private async pageProjectIndex(
    accessToken: string,
    cutoff: number,
    existingTargets: CrawlTarget[]
  ): Promise<{ toCrawl: CrawlTarget[], partialFailure: boolean, complete: boolean }> {
    const toCrawl: CrawlTarget[] = []

    // False whenever any project (or the sidebar listing itself) was cut
    // short — by a failed page or the maxIndexPages cap — meaning some
    // project conversations may not have been enumerated this run.
    let complete = true

    try {
      // Step 1: list projects via the gizmos sidebar.
      // conversations_per_gizmo=0 so we don't waste payload — we page each project explicitly below.
      // limit must be ≤20; the server returns 422 for higher values. Paginate via the response's
      // `cursor` field for users with more than 20 projects.
      const gizmoIds: string[] = []
      let sidebarCursor: string | null = null
      let sidebarPageIndex = 0

      while (sidebarPageIndex === 0 || (sidebarCursor !== null && sidebarPageIndex < this.maxIndexPages)) {
        const cursorQs:string = sidebarCursor === null ? '' : `&cursor=${encodeURIComponent(sidebarCursor)}`
        const sidebarUrl:string = `https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=20${cursorQs}`
        console.log(`[rex-spider-chatgpt] Project sidebar page ${sidebarPageIndex}: ${sidebarUrl}`)

        const sidebarResp:Response = await fetch(sidebarUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${accessToken}` }
        })

        if (!sidebarResp.ok) {
          console.log(`[rex-spider-chatgpt] Project sidebar page ${sidebarPageIndex} failed (status ${sidebarResp.status}).`)
          // First-page failure is the only case that blocks enumeration. Later-page failures
          // just stop pagination early and we use what we have so far.
          if (sidebarPageIndex === 0) {
            return { toCrawl, partialFailure: true, complete: false }
          }
          complete = false
          break
        }

        const sidebarBody:any = await sidebarResp.json() // eslint-disable-line @typescript-eslint/no-explicit-any

        this.noteProgress() // sidebar page fetched — reset the stuck-run watchdog clock

        // The sidebar response nests the gizmo ID at items[].gizmo.gizmo.id. Fall back to
        // items[].gizmo.id and items[].id so a future API reshape doesn't silently break us.
        const sidebarItems = sidebarBody?.items ?? []
        for (const entry of sidebarItems) {
          const candidate = entry?.gizmo?.gizmo?.id ?? entry?.gizmo?.id ?? entry?.id
          if (typeof candidate === 'string' && candidate.startsWith('g-p-')) {
            gizmoIds.push(candidate)
          }
        }

        const nextCursor:string|null = sidebarBody?.cursor
        sidebarCursor = typeof nextCursor === 'string' && nextCursor.length > 0 ? nextCursor : null
        sidebarPageIndex += 1

        if (sidebarCursor !== null && sidebarPageIndex < this.maxIndexPages) {
          await new Promise((r) => self.setTimeout(r, this.sleepDelayMs))
        }
      }
      if (sidebarCursor !== null) {
        complete = false // maxIndexPages cap hit with more sidebar pages remaining
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
            complete = false
            break
          }

          const body = await response.json()
          const items = body?.items ?? []

          this.noteProgress() // project page fetched — reset the stuck-run watchdog clock

          for (const item of items) {
            const itemUpdateMs = this.updateTimeMs(item?.update_time)
            if (itemUpdateMs === null) continue
            if (itemUpdateMs >= cutoff) {
              if (item.id !== undefined) {
                const stored = await this.fetchLastUpdate(item.id)
                if (!shouldCrawl(itemUpdateMs, stored)) {
                  console.log(`[rex-spider-chatgpt] Skipping project convo ${item.id} — listing update_time (${itemUpdateMs}) not newer than stored (${stored})`)
                  continue
                }
                const fullUrl = `https://chatgpt.com/backend-api/conversation/${item.id}`
                const alreadyQueued =
                  existingTargets.some((t) => t.conversationId === item.id) ||
                  toCrawl.some((t) => t.conversationId === item.id)
                if (!alreadyQueued) {
                  toCrawl.push({ url: fullUrl, listingUpdateMs: itemUpdateMs, conversationId: item.id })
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

        if (!stop && cursor !== null) {
          complete = false // maxIndexPages cap hit with more project pages remaining
        }
      }

      return { toCrawl, partialFailure: false, complete }
    } catch (err) {
      console.log(`[rex-spider-chatgpt] pageProjectIndex threw unexpectedly:`, err)
      return { toCrawl, partialFailure: true, complete: false }
    }
  }

  parseConversation(conversationJson: any): Promise<any | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return new Promise((resolve) => {
      console.log(`[rex-spider-chatgpt] parseConversation:`)
      console.log(conversationJson)

      const firstWhen = new Date(conversationJson['create_time'] * 1000)

      let latestDate = firstWhen

      const firstWhenString: DateString = new DateString(conversationJson['create_time'])

      const conversation: Conversation = {
        turns: [],
        platform: 'chatgpt',
        identifier: conversationJson['conversation_id'],
        started: firstWhenString,
        ended: firstWhenString,
        metadata: conversationJson // TODO: Pull out so only populated on debug=true
      }

      const convoIds = ['client-created-root']

      while (convoIds.length > 0) {
        const convoId = convoIds.shift()

        if (convoId !== undefined) {
          const turnJson = conversationJson['mapping'][convoId]

          if (turnJson !== undefined) {
            let createTime = firstWhenString

            if (turnJson.message !== null) {
              const messageCreateTime = turnJson.message.create_time
              if (messageCreateTime !== null && messageCreateTime !== undefined) {
                createTime = new DateString(messageCreateTime)
                const turnDate = new Date(messageCreateTime * 1000)
                if (turnDate > latestDate) {
                  latestDate = turnDate
                  conversation.ended = createTime
                }
              }

              const turn: Turn = {
                speaker: turnJson.message.author.role,
                when: createTime,
                identifier: turnJson.message.id,
                'content*': '',
                'metadata*': turnJson,
                'parent': turnJson.parent,
              }

              if (turnJson.message.content.parts !== undefined) {
                turn['content*'] = turnJson.message.content.parts.join('\n')
              } else if (turnJson.message.content.text !== undefined) {
                turn['content*'] = turnJson.message.content.text
              } else if (turnJson.message.content.content_type === 'reasoning_recap' && typeof turnJson.message.content.content === 'string') {
                turn['content*'] = turnJson.message.content.content
              } else if (turnJson.message.content.content_type === 'thoughts' && Array.isArray(turnJson.message.content.thoughts)) {
                turn['content*'] = turnJson.message.content.thoughts
                  .map((thought: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
                    const summary = typeof thought?.summary === 'string' ? thought.summary : ''
                    const content = typeof thought?.content === 'string' ? thought.content : ''
                    return [summary, content].filter((s) => s.length > 0).join('\n')
                  })
                  .filter((s: string) => s.length > 0)
                  .join('\n\n')
              } else if (turnJson.message.content.content_type === 'model_editable_context' && typeof turnJson.message.content.model_set_context === 'string') {
                turn['content*'] = turnJson.message.content.model_set_context
              }

              // Deep Research connector renders the final report inside a widget_state blob
              // rather than the turn's own content.parts. Recover it when present and the
              // turn's surface content is empty or just the tool-call envelope.
              const widgetStateRaw = turnJson.message.metadata?.chatgpt_sdk?.widget_state
              const surfaceContent = turn['content*']
              const looksLikeToolCall = surfaceContent.startsWith('{"path"')
              if (typeof widgetStateRaw === 'string' && (surfaceContent === '' || looksLikeToolCall)) {
                try {
                  const widgetState = JSON.parse(widgetStateRaw)
                  const reportParts = widgetState?.report_message?.content?.parts
                  if (Array.isArray(reportParts) && reportParts.length > 0) {
                    turn['content*'] = reportParts.join('\n')
                  }
                } catch (err) {
                  console.warn('[rex-spider-chatgpt] Failed to parse widget_state:', err)
                }
              }

              if (turnJson.metadata !== undefined) {
                if (turnJson.metadata['search_result_groups'] !== undefined) {
                  const search: Search = {
                    platform: 'chatgpt',
                    'query*': '?',
                    type: 'web',
                    results: []
                  }

                  for (const searchGroup of turnJson.metadata['search_result_groups']) {
                    for (const entry of (searchGroup.entries as any[])) { // eslint-disable-line @typescript-eslint/no-explicit-any
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
                      const citation: Citation = {
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

              const isHidden = turnJson.message.metadata?.is_visually_hidden_from_conversation === true
              if (!(isHidden && turn['content*'] === '')) {
                conversation.turns.push(turn)
              }
            }

            for (const childId of turnJson.children) {
              convoIds.push(childId)
            }

          }

        }

      }

      const payload: EventPayload = {
        name: 'rex-conversation',
        date: firstWhen,
        ...conversation
      }

      resolve(payload)
    })
  }
}

const chatGPTSpider = new REXChatGPTSpider()

rexSpiderPlugin.registerSpider(chatGPTSpider)

export default chatGPTSpider