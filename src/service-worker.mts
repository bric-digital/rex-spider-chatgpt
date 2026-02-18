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
                                          this.parseConversation(result).then((payload) => {
                                            console.log(`[rex-spider-chatgpt] log:`)
                                            console.log(payload)

                                            if (payload !== null) {

                                              dispatchEvent(payload)
                                            }

                                            fetchConvo()
                                          })
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

      let firstWhen = new Date(conversationJson['create_time'] * 1000)

      let latestDate = firstWhen

      let firstWhenString:DateString = new DateString(conversationJson['create_time'])

      const conversation:Conversation = {
        turns:[],
        platform: 'chatgpt',
        identifier: conversationJson['conversation_id'],
        started: firstWhenString,
        ended:firstWhenString,
        metadata: null
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