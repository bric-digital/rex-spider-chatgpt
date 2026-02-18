import { Conversation, Turn, DateString, Citation, Search, Result } from '@bric/rex-types/types'

import rexCorePlugin, { EventPayload, dispatchEvent } from '@bric/rex-core/service-worker'
import rexSpiderPlugin, { REXSpider } from '@bric/rex-spider/service-worker'

export class REXChatGPTSpider extends REXSpider {
  sleepDelayMs:number = 10000
  syncing:boolean = false
  lastSync:number = 0
  syncPeriod:number = 300000
  accessToken:string|null = null

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
              if (response.ok) {
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

                  if (this.accessToken !== null) {
                    console.log(`[rex-spider-chatgpt] USING ACCESS TOKEN: ${this.accessToken}`)

                    const indexUrl = 'https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false'

                    fetch(indexUrl, {
                      method: 'GET',
                      headers: {
                        'Authorization': `Bearer ${this.accessToken}`
                      }
                    })
                      .then((response: Response) => {
                        if (response.ok) {
                          const toCrawl = []

                          response.json().then((convoList) => {
                            console.log(`[rex-spider-chatgpt] Index content:`)
                            console.log(convoList)

                            for (const convo of convoList.items) {
                              if (convo.id !== undefined) {
                                const fullUrl = `https://chatgpt.com/backend-api/conversation/${convo.id}`

                                if (toCrawl.includes(fullUrl) === false) {
                                  toCrawl.push(fullUrl)
                                }
                              }
                            }

                            console.log(`[rex-spider-chatgpt] Crawl list:`)
                            console.log(toCrawl)

                            const fetchConvo = () => {
                              if (toCrawl.length == 0) {
                                this.syncing = false

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
                                          if (result.status === 'success') {
                                            this.parseConversation(result).then((payload) => {
                                              console.log(`[rex-spider-chatgpt] log:`)
                                              console.log(payload)

                                              if (payload !== null) {

                                                dispatchEvent(payload)
                                              }

                                              fetchConvo()
                                            })
                                          } else {
                                            console.log(`[rex-spider-chatgpt] Crawl failed ${nextUrl}. Content:`)
                                            console.log(convoResponse)

                                            this.syncing = false

                                            resolve(true) // Error - fall back to DOM scraping...
                                          }
                                        })
                                      } else {
                                        console.log(`[rex-spider-chatgpt] Crawl failed ${nextUrl}. Response:`)
                                        console.log(convoResponse)

                                        this.syncing = false

                                        resolve(true) // Error - fall back to DOM scraping...
                                      }
                                    })
                                }, this.sleepDelayMs)
                              }
                            }

                            fetchConvo()
                          })
                        } else {
                          this.syncing = false

                          resolve(true) // Error - fall back to DOM scraping...
                        }
                      })
                  }
                })
              }
            })
        })
      })
    })
  }

  parseConversation(conversationJson):Promise<any|null> {
    return new Promise((resolve) => {
      console.log(`[rex-spider-chatgpt] parseConversation:`)
      console.log(conversationJson)

      // let firstWhen = new Date(conversationJson.entries[0]['entry_updated_datetime'])

      // let latestDate = firstWhen

      // let firstWhenString:DateString = new DateString(conversationJson.entries[0]['entry_updated_datetime'])

      // const conversation:Conversation = {
      //   turns:[],
      //   platform: 'perplexity',
      //   identifier: conversationJson.entries[0]['thread_url_slug'],
      //   started:firstWhenString,
      //   ended:firstWhenString,
      //   metadata: null
      // }

      // const entryIndex = 0

      // for (const entry of conversationJson.entries) { // Each entry is a question and answer pair
      //   let when = new Date(entry.entry_updated_datetime)

      //   if (entry.updated_us !== undefined) {
      //     when = new Date(entry.updated_us / 1000)
      //   }

      //   const whenString = new DateString(when.toISOString())

      //   if (entryIndex === 0) {
      //     firstWhen = when
      //     firstWhenString = whenString

      //     conversation['started'] = whenString
      //   }

      //   if (when > latestDate) {
      //     latestDate = when
      //   }

      //   conversation['ended'] = whenString

      //   const responseMetadata = {}

      //   const citations:Citation[] = []

      //   const search:Search = {
      //     platform: 'perplexity',
      //     'query*': '',
      //     type: '',
      //     results: [],
      //   }

      //   if (entry.text !== undefined) {
      //     const stepsContent = JSON.parse(entry.text) as []

      //     for (const step of stepsContent) {
      //       if (step['step_type'] === 'INITIAL_QUERY') {
      //         const turn:Turn = {
      //           speaker: entry['author_username'],
      //           when: whenString,
      //           'content*': step['content']['query'],
      //           identifier: 'uuid:',
      //           'metadata*': {
      //             INITIAL_QUERY: step
      //           }
      //         }

      //         conversation.turns.push(turn)
      //       } else if (step['step_type'] === 'SEARCH_WEB') {
      //         for (const query of step['content']['queries'] as []) {
      //           if (search['query*'] !== '') {
      //             search['query*'] += '; '
      //           }

      //           search['query*'] += query['query']

      //           if (search['type'] !== '') {
      //             search['type'] += '; '
      //           }

      //           search['type'] += query['engine']
      //         }

      //         responseMetadata['SEARCH_WEB'] = step
      //       } else if (step['step_type'] === 'SEARCH_RESULTS') {
      //         let index = 0

      //         for (const webResult of step['content']['web_results'] as []) {
      //           const result:Result = {
      //             title: webResult['name'],
      //             url: webResult['url'],
      //             preview: webResult['snippet'],
      //             index,
      //             metadata: webResult
      //           }

      //           search.results.push(result)

      //           let citationDomainName:string|undefined = webResult['meta_data']['citation_domain_name']

      //           if (citationDomainName === undefined) { // TODO - write test
      //             citationDomainName = 'perplexity.unknown:citation_domain_name'
      //           }

      //           const citation:Citation = {
      //             title: webResult['name'],
      //             url: webResult['url'],
      //             source: citationDomainName,
      //           }

      //           citations.push(citation)

      //           index += 1
      //         }

      //         responseMetadata['SEARCH_RESULTS'] = step

      //       } else if (step['step_type'] === 'FINAL') {
      //         responseMetadata['FINAL'] = step

      //         const answer = JSON.parse(step['content']['answer'])

      //         const turn:Turn = {
      //           speaker: `perplexity:${entry['author_username']}`,
      //           when: whenString,
      //           'content*': answer['answer'],
      //           identifier: 'uuid:',
      //           'metadata*': responseMetadata,
      //         }

      //         if (search['query*'] !== '') {
      //           turn['search'] =  search
      //         }

      //         if (citations.length > 0) {
      //           turn['citations'] =  citations
      //         }

      //         conversation.turns.push(turn)
      //       }
      //     }
      //   } else if (entry['step_type'] !== undefined) {
      //     const turn:Turn = {
      //       speaker: entry['author_username'],
      //       when: whenString,
      //       'content*': entry['query_str'],
      //       identifier: `uuid:${entry['uuid']}`,
      //       'metadata*': entry
      //     }

      //     conversation.turns.push(turn)

      //     for (const block of entry.blocks) {
      //       if (block['intended_usage'] === 'sources_answer_mode') {
      //         let index = 0

      //         for (const webResult of block['sources_mode_block']['web_results']) {
      //           const result:Result = {
      //             title: webResult['name'],
      //             url: webResult['url'],
      //             preview: webResult['snippet'],
      //             index,
      //             metadata: webResult
      //           }

      //           search.results.push(result)

      //           const citation:Citation = {
      //             title: webResult['name'],
      //             url: webResult['url'],
      //             source: webResult['meta_data']['citation_domain_name']
      //           }

      //           citations.push(citation)

      //           index += 1
      //         }
      //       } else if (block['intended_usage'] === 'pro_search_steps') {
      //         for (const searchStep of block['plan_block']['steps']) {
      //           if (searchStep['step_type'] === 'SEARCH_WEB') {
      //             for (const searchQuery of searchStep['search_web_content']['queries']) {
      //               if (search['query*'] !== '') {
      //                 search['query*'] += '; '
      //               }

      //               search['query*'] += searchQuery['query']

      //               if (search['type'].includes(searchQuery['engine']) === false) {
      //                 if (search['type'] !== '') {
      //                   search['type'] += '; '
      //                 }

      //                 search['type'] += searchQuery['engine']
      //               }
      //             }
      //           }
      //         }
      //       } else if (block['intended_usage'] === 'ask_text') {
      //         const response:Turn = {
      //           speaker: `perplexity:${entry['user_selected_model']}`,
      //           when: whenString,
      //           'content*': block['markdown_block']['answer'],
      //           identifier: `uuid:${entry['uuid']}`,
      //           'metadata*': block
      //         }

      //         conversation.turns.push(response)
      //       }
      //     }

      //     if (search['query*'] !== '') {
      //       conversation.turns[conversation.turns.length - 1]['search'] = search
      //     }

      //     if (citations.length > 0) {
      //       conversation.turns[conversation.turns.length - 1]['citations'] = citations
      //     }
      //   }

      //   if (when > latestDate) {
      //     latestDate = when
      //   }
      // }

      // const lastUpdateKey = `${conversation.platform}-${conversation.identifier}-last-update`

      // const message = {
      //   messageType: 'fetchValue',
      //   key: lastUpdateKey
      // }

      // rexCorePlugin.handleMessage(message, this, (response) => {
      //   let timestamp = 0

      //   if (response !== null) {
      //     timestamp = response
      //   }

      //   console.log(`[rex-spider-perplexity] TS TEST ${timestamp} <? ${latestDate.valueOf()}`)

      //   if (timestamp < latestDate.valueOf()) {
      //     const payload:EventPayload = {
      //       name: 'rex-conversation',
      //       date: firstWhen,
      //       ...conversation
      //     }

      //     console.log(`[rex-spider-perplexity] log:`)
      //     console.log(payload)

      //     const storeMessage = {
      //       messageType: 'storeValue',
      //       key: lastUpdateKey,
      //       value: latestDate.valueOf()
      //     }

      //     rexCorePlugin.handleMessage(storeMessage, this, (response) => { // eslint-disable-line @typescript-eslint/no-unused-vars
      //       console.log(`[rex-spider-perplexity] ${lastUpdateKey} = ${latestDate.valueOf()}`)

      //       resolve(payload)
      //     })

      //     return
      //   }
      // })

      resolve(null)
    })
  }
}

const chatGPTSpider = new REXChatGPTSpider()

rexSpiderPlugin.registerSpider(chatGPTSpider)

export default chatGPTSpider