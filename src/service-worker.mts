import check from 'check-types'

import { Conversation, Turn, DateString, Citation, Search } from '@bric/rex-types/types'

import { EventPayload, dispatchEvent } from '@bric/rex-core/service-worker'
import rexSpiderPlugin, { REXSpider, REXSpiderCrawlResult, REXSpiderCrawlInspection } from '@bric/rex-spider/service-worker'

export class REXChatGPTSpider extends REXSpider {
  accessToken: string | null = null
  pageSize:number = 28

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
      const indexUrl = 'https://chatgpt.com/'

      fetch(indexUrl)
        .then((response: Response) => {
          if (response.ok) {
            response.text().then((rawHtml) => {
              const lines = rawHtml.match(/[^\r\n]+/g)

              if (lines !== null) {
                for (const line of lines) {
                  if (line.includes('"accessToken"')) {
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

  allowedUrls():string[] {
    return [
      '^https://chatgpt.com/$',
      '^https://chatgpt.com/backend-api/conversations\\?.*',
      '^https://chatgpt.com/backend-api/conversation/.*',
      '^https://chatgpt.com/backend-api/gizmos/.*/conversations\\?.*',
      '^https://chatgpt.com/backend-api/gizmos/snorlax/sidebar\\?.*',
    ]
  }

  parseConversation(conversationJson: any): Promise<any | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return new Promise((resolve, reject) => {
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

      const turnIds = ['client-created-root']

      while (turnIds.length > 0) {
        const turnId = turnIds.shift()

        if (turnId !== undefined) {
          const turnJson = conversationJson['mapping'][turnId]

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
              turnIds.push(childId)
            }
          } else {
            reject(`Invalid turn structure for ${conversation.identifier}. Offending turn: ${turnId}.`)
            
            return
          }
        }
      }

      conversation.ended = new DateString(latestDate)

      const payload: EventPayload = {
        name: 'rex-conversation',
        date: firstWhen,
        ...conversation
      }

      resolve(payload)
    })
  }

  fetchConversationRecords(): Promise<REXSpiderCrawlInspection[]> {
    return new Promise<REXSpiderCrawlInspection[]>((resolve, reject) => {
      const inspectionRecords:REXSpiderCrawlInspection[] = []

      const fetchPage = (offset:number) => {
        const indexUrl = `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${this.pageSize}&order=updated&is_archived=false&is_starred=false`

        fetch(indexUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.accessToken}` }
        })
          .then((response) => {
            if (!response.ok) {
              console.log(`[rex-spider-chatgpt] Index offset ${offset} failed (status ${response.status}).`)

              reject(`Index offset ${offset} failed (status ${response.status})`)
            } else {
              response.json().then((body) => {
                if (body.items !== undefined) {
                  const toProcess:any = [] // eslint-disable-line @typescript-eslint/no-explicit-any

                  if (check.array(body.items) && body.items.length === 0) {
                    resolve(inspectionRecords)
                  } else {
                    toProcess.push(...body.items)

                    let inCrawlWindowCount = 0

                    const processNextItem = () => {
                      if (toProcess.length == 0) {
                        if (inCrawlWindowCount > 0) {
                          setTimeout(() => {
                            fetchPage(offset + this.pageSize)
                          }, this.fetchCrawlDelay())
                        } else {
                          resolve(inspectionRecords)
                        }
                      } else {
                        const item = toProcess.pop()

                        if (item !== undefined) {
                          if (item['update_time'] !== undefined) {
                            try {
                              const updated = new DateString(item['update_time'])
                              const created = new DateString(item['create_time'])

                              const title:string = item.title

                              if (item.id !== undefined) {
                                this.crawlWindowContains(updated.timestamp())
                                  .then((isContained:boolean) => {
                                    if (isContained) {
                                      inCrawlWindowCount += 1

                                      this.checkIfAlreadyTransmitted(item.id, updated).then((transmitted:boolean) => {
                                        if (transmitted === false) {
                                          inspectionRecords.push({
                                              id: item.id,
                                              refresh: true,
                                              title,
                                              lookupDate: updated,
                                              startDate: created
                                          })
                                        } else {
                                          inspectionRecords.push({
                                              id: item.id,
                                              title,
                                              refresh: false,
                                              lookupDate: updated,
                                              startDate: created
                                          })
                                        }

                                        processNextItem()
                                      })
                                    } else {
                                      processNextItem()
                                    }
                                  })
                              } else {
                                processNextItem()
                              }
                            } catch(err) {
                              console.log(`[rex-spider-chatgpt] Unable to parse update_time ${item['update_time']} (${typeof item['update_time']}): ${err}`)

                              reject(`Unable to parse update_time ${item['update_time']} (${typeof item['update_time']}): ${err}`)
                            }
                          } else {
                            processNextItem()
                          }
                        }
                      }
                    }

                    processNextItem()
                  }
                } else {
                  console.log(`[rex-spider-chatgpt] Received invalid body.items: ${body.items} (${typeof body.items}).`)

                  reject(`Received invalid body.items: ${body.items} (${typeof body.items}).`)
                }
              })
              .catch((err) => {
                console.log(`[spider-chat-gpt] Unable to parse body into JSON at ${indexUrl}: ${err}`)

                reject(`Unable to parse body into JSON at ${indexUrl}: ${err}`)
              })
            }
          })
          .catch((err) => {
            console.log(`[spider-chat-gpt] Error fetching ${indexUrl}: ${err}`)

            reject(`Error fetching ${indexUrl}: ${err}`)
          })
      }

      fetchPage(0)
    })
  }

  fetchConversationRecordsForProject(projectId: string) : Promise<REXSpiderCrawlInspection[] | null> {
    return new Promise<REXSpiderCrawlInspection[] | null>((resolve, reject) => {
      const inspectionRecords:REXSpiderCrawlInspection[] = []

      const fetchProjectConversationsForPage = (cursorToken: string | null = '0') => {
        if (cursorToken === undefined || cursorToken === null) { // Finished?
          resolve(inspectionRecords)
        } else {
          const projectUrlBase:string = `https://chatgpt.com/backend-api/gizmos/${projectId}/conversations`

          const parsedUrl = URL.parse(projectUrlBase)

          if (parsedUrl !== null) {
            parsedUrl.searchParams.set('cursor', cursorToken)
            
            fetch(parsedUrl.href, {
              method: 'GET',
              headers: { 'Authorization': `Bearer ${this.accessToken}` }
            })
              .then((response) => {
                if (response.ok) {
                  response.json()
                    .then((body) => {
                      if (check.array(body.items)) {
                        if (body.items.length === 0) {
                          resolve(inspectionRecords)
                        } else {
                          const toCheck:any[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
                          toCheck.push(...body.items)

                          const checkNextItem = () => {
                            if (toCheck.length == 0) {
                              setTimeout(() => {
                                fetchProjectConversationsForPage(body.cursor)
                              }, this.fetchCrawlDelay())
                            } else {
                              const item = toCheck.pop()

                              if (check.string(item.id) && inspectionRecords.includes(item.id) === false) {
                                const updated = Date.parse(item.update_time)
                                const started = Date.parse(item.create_time)
                                const title:string = item.title

                                if (Number.isNaN(updated)) {
                                  console.log(`[rex-spider-chatgpt] Received an invalid timestamp for date: ${item.update_time}.`)

                                  checkNextItem()
                                } else {
                                  this.crawlWindowContains(updated).then((include) => {
                                    if (include) {
                                      const updatedString = new DateString(updated / 1000)
                                      const startedString = new DateString(started / 1000)

                                      this.checkIfAlreadyTransmitted(item.id, updatedString).then((transmitted:boolean) => {
                                        if (transmitted === false) {
                                          inspectionRecords.push({
                                            id: item.id,
                                            refresh: true,
                                            lookupDate: updatedString,
                                            startDate: startedString,
                                            title
                                          })
                                        } else {
                                          inspectionRecords.push({
                                            id: item.id,
                                            refresh: false,
                                            lookupDate: updatedString,
                                            startDate: startedString,
                                            title
                                          })
                                        }

                                        checkNextItem()
                                      })
                                    } else {
                                      checkNextItem()
                                    }
                                  })
                                }
                              } else {
                                checkNextItem()
                              }
                            }
                          }

                          checkNextItem()                            
                        }
                      } else {
                        console.log(`[rex-spider-chatgpt] Received invalid body.items: ${body.items} (${typeof body.items}).`)
                        
                        reject(`Received invalid body.items: ${body.items} (${typeof body.items}).`)
                      }
                    })
                    .catch((err) => {
                      console.log(`[rex-spider-chatgpt] Unable to parse JSON body: ${response.body}: ${err}.`)
                      
                      reject(`Unable to parse JSON body: ${response.body}: ${err}`)
                    })
                } else {
                  console.log(`[rex-spider-chatgpt] Invalid HTTP return code: ${response.status} for ${parsedUrl.href}.`)
                  
                  reject(`Invalid HTTP return code: ${response.status} for ${parsedUrl.href}.`)
                }
              })
              .catch((err) => {
                console.log(`[rex-spider-chatgpt] Error encountered retrieving ${parsedUrl.href}: ${err}`)
                
                reject(`Error encountered retrieving ${parsedUrl.href}: ${err}`)
              })
          } else {
              console.log(`[rex-spider-chatgpt] Unable to parse URL ${projectUrlBase}.`)
              
              reject(`Unable to parse URL ${projectUrlBase}.`)
          }
        }
      }

      setTimeout(() => {
        fetchProjectConversationsForPage()
      }, this.fetchCrawlDelay())
    })
  }

  fetchProjectRecords(): Promise<REXSpiderCrawlInspection[]> {
    return new Promise<REXSpiderCrawlInspection[]>((resolve, reject) => {
      const conversationRecords: REXSpiderCrawlInspection[] = []

      const fetchSidebarIds = (cursorToken: string | null = null) => {
        const sidebarUrlBase:string = `https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=${this.pageSize}`

        const parsedUrl = URL.parse(sidebarUrlBase)

        if (parsedUrl !== null) {
          if (cursorToken !== null && parsedUrl !== null) {
            parsedUrl.searchParams.set('cursor', cursorToken)
          }

          fetch(parsedUrl.href, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
          })
            .then((response) => {
              if (response.ok) {
                response.json()
                  .then((body) => {
                    if (body.items !== undefined) {
                      const toCheck:any[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any

                      toCheck.push(...body.items)

                      const checkNextProject = () => {
                        if (toCheck.length === 0) {
                          resolve(conversationRecords)
                        } else {
                          const item = toCheck.pop()

                          const gizmoId = item.gizmo.gizmo.id

                          if (check.string(gizmoId) && gizmoId.startsWith('g-p-')) {
                            this.fetchConversationRecordsForProject(gizmoId)
                              .then((projectRecords) => {
                                if (check.array(projectRecords)) {
                                  for (const conversationRecord of projectRecords) {
                                    if (conversationRecords.includes(conversationRecord) === false) {
                                      conversationRecords.push(conversationRecord)
                                    }
                                  }
                                }

                                setTimeout(() => {
                                  checkNextProject()
                                }, this.fetchCrawlDelay())
                              })
                              .catch((err) => {
                                console.log(`[rex-spider-gpt] Received error fetching conversations for project ID: ${gizmoId}: ${err}`)

                                setTimeout(() => {
                                  checkNextProject()
                                }, this.fetchCrawlDelay())
                              })
                          } else {
                            console.log(`[rex-spider-gpt] Received invalid project ID: ${gizmoId} (${typeof gizmoId})`)

                            setTimeout(() => {
                              checkNextProject()
                            }, this.fetchCrawlDelay())
                          }
                        }
                      }

                      checkNextProject()
                    } else {
                      console.log(`[rex-spider-chatgpt] Received invalid body.items: ${body.items} (${typeof body.items})`)
                  
                      reject(`Received invalid body.items: ${body.items} (${typeof body.items})`)
                    }
                  })
                  .catch((err) => {
                    console.log(`[rex-spider-chatgpt] Unable to parse JSON body: ${response.body}: ${err}`)
                
                    reject(`Unable to parse JSON body: ${response.body}: ${err}`)
                  })
              } else {
                console.log(`[rex-spider-chatgpt] Invalid response ${response.status} for ${parsedUrl.href}`)
            
                reject(`Invalid response ${response.status} for ${parsedUrl.href}`)
              }
            })
            .catch((err) => {
              console.log(`[rex-spider-chatgpt] Error encountered fetching ${parsedUrl.href}: ${err}`)
          
              reject(`Error encountered fetching ${parsedUrl.href}: ${err}`)
            })
        } else {
          console.log(`[rex-spider-chatgpt] Unable to parse URL from ${sidebarUrlBase}.`)
      
          reject(`Unable to parse URL from ${sidebarUrlBase}.`)
        }
      }

      fetchSidebarIds()
    })
  }

  doBackgroundCrawl():Promise<REXSpiderCrawlResult> {
    return new Promise<REXSpiderCrawlResult>((resolve) => {
      super.doBackgroundCrawl().then((crawlResult:REXSpiderCrawlResult) => {
        const crawledIds: string[] = []

        const homeUrl = 'https://chatgpt.com/'

        let dispatched = 0

        fetch(homeUrl)
          .then((response: Response) => {
            if (!response.ok) {
              this.signalCrawlComplete(-1, crawledIds, `Homepage fetch failed (status ${response.status}).`)

              crawlResult.issues.push({
                  url: this.loginUrl(),
                  message: `Unable to fetch ${homeUrl}. Status code = ${response.status}.`
                })

              resolve(crawlResult)
            } else {
              response.text().then((rawHtml) => {
                const lines = rawHtml.match(/[^\r\n]+/g)

                if (lines !== null) {
                  for (const line of lines) {
                    if (line.includes('"accessToken"')) {
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
                  this.signalCrawlComplete(-1, crawledIds, 'No access token — user is not logged in.')

                  crawlResult.issues.push({
                    url: this.loginUrl(),
                    message: `User not logged in.`
                  })

                  resolve(crawlResult)
                } else {
                  const toCrawl:REXSpiderCrawlInspection[] = []

                  const fetchNextConversation = () => {
                    if (toCrawl.length === 0) {
                      console.log(`[rex-spider-chatgpt] Conversations crawled successfully`)

                      this.signalCrawlComplete(dispatched, crawledIds, `Conversations crawled successfully.`)

                      resolve(crawlResult)
                    } else {
                      const convoRecord: REXSpiderCrawlInspection | undefined = toCrawl.pop()

                      if (convoRecord !== undefined) {
                        if (crawledIds.includes(convoRecord.id) === false) {
                          crawledIds.push(convoRecord.id)
                        }

                        if (convoRecord.refresh) {
                          if (this.justSummarize()) {
                            this.checkIfAlreadyTransmitted(convoRecord.id, convoRecord.lookupDate).then((transmitted:boolean) => {
                              const conversation: Conversation = {
                                turns: [],
                                platform: 'chatgpt',
                                identifier: convoRecord.id,
                                started: convoRecord.startDate,
                                ended: convoRecord.lookupDate,
                              }

                              const payload: EventPayload = {
                                name: 'rex-conversation',
                                'is_summary': true,
                                date: convoRecord.lookupDate.value?.epochMilliseconds,
                                ...conversation
                              }

                              dispatchEvent(payload)

                              dispatched += 1

                              this.logTransmitted(convoRecord.id, convoRecord.lookupDate).then(() => {
                                fetchNextConversation()
                              })
                            })
                          } else {
                            const convoUrl = `https://chatgpt.com/backend-api/conversation/${convoRecord.id}`

                            fetch(convoUrl, {
                              method: 'GET',
                              headers: {
                                'Authorization': `Bearer ${this.accessToken}`
                              }
                            })
                            .then((convoResponse: Response) => {
                              if (convoResponse.ok) {
                                convoResponse.json().then((result) => {
                                  this.parseConversation(result).then((conversation) => {
                                    if (conversation !== null) {
                                      this.checkIfAlreadyTransmitted(convoRecord.id, convoRecord.lookupDate).then((transmitted:boolean) => {
                                        if (transmitted === false) {
                                          const payload: EventPayload = {
                                            name: 'rex-conversation',
                                            date: conversation.started.value.epochMilliseconds,
                                            ...conversation
                                          }

                                          dispatchEvent(payload)

                                          dispatched += 1

                                          this.logTransmitted(convoRecord.id, convoRecord.lookupDate).then(() => {
                                            setTimeout(() => {
                                              fetchNextConversation()
                                            }, this.fetchCrawlDelay())
                                          })
                                        } else {
                                          setTimeout(() => {
                                            fetchNextConversation()
                                          }, this.fetchCrawlDelay())
                                        }
                                      })
                                      .catch((err) => {
                                        crawlResult.issues.push({
                                          url: convoUrl,
                                          message: `Error encountered checking prior conversation transmission: ${err}`
                                        })

                                        if (this.continueAfterError()) {
                                          this.signalCrawlComplete(-1, crawledIds, `Error encountered checking prior conversation transmission: ${err}`, false)

                                          setTimeout(() => {
                                            fetchNextConversation()
                                          }, this.fetchCrawlDelay())
                                        } else {
                                          this.signalCrawlComplete(-1, crawledIds, `Error encountered checking prior conversation transmission: ${err}`)

                                          resolve(crawlResult)
                                        }
                                      })
                                    } else {
                                      setTimeout(() => {
                                        fetchNextConversation()
                                      }, this.fetchCrawlDelay())
                                    }
                                  }).catch((err) => {
                                    crawlResult.issues.push({
                                      url: convoUrl,
                                      message: `Error encountered parsing conversation: ${err}`
                                    })

                                    if (this.continueAfterError()) {
                                      this.signalCrawlComplete(-1, crawledIds, `Error encountered parsing conversation: ${err}`, false)

                                      setTimeout(() => {
                                        fetchNextConversation()
                                      }, this.fetchCrawlDelay())
                                    } else {
                                      this.signalCrawlComplete(-1, crawledIds, `Error encountered parsing conversation: ${err}`)

                                      resolve(crawlResult)
                                    }
                                  })
                                })
                                .catch((err) => {
                                  crawlResult.issues.push({
                                    url: convoUrl,
                                    message: `Unable to parse conversation JSON: ${err}.`
                                  })

                                  if (this.continueAfterError()) {
                                    this.signalCrawlComplete(-1, crawledIds, `Unable to parse conversation list JSON: ${err}.`, false)

                                    setTimeout(() => {
                                      fetchNextConversation()
                                    }, this.fetchCrawlDelay())
                                  } else {
                                    this.signalCrawlComplete(-1, crawledIds, `Unable to parse conversation list JSON: ${err}.`)

                                    resolve(crawlResult)
                                  }
                                })
                              } else {
                                crawlResult.issues.push({
                                  url: convoUrl,
                                  message: `Unable to fetch ${convoUrl}. Status code = ${convoResponse.status}.`
                                })

                                if (this.continueAfterError()) {
                                  this.signalCrawlComplete(-1, crawledIds, `Unable to fetch ${convoUrl}. Status code = ${convoResponse.status}.`, false)

                                  setTimeout(() => {
                                    fetchNextConversation()
                                  }, this.fetchCrawlDelay())
                                } else {
                                  this.signalCrawlComplete(-1, crawledIds, `Unable to fetch ${convoUrl}. Status code = ${convoResponse.status}.`)

                                  resolve(crawlResult)
                                }
                              }
                            })
                            .catch((err) => {
                              crawlResult.issues.push({
                                url: convoUrl,
                                message: `Error retrieving conversation: ${err}.`
                              })

                              if (this.continueAfterError()) {
                                this.signalCrawlComplete(-1, crawledIds, `Error retrieving conversation: ${err}.`, false)

                                setTimeout(() => {
                                  fetchNextConversation()
                                }, this.fetchCrawlDelay())
                              } else {
                                this.signalCrawlComplete(-1, crawledIds, `Error retrieving conversation: ${err}.`)

                                resolve(crawlResult)
                              }
                            })
                          }
                        } else {
                          fetchNextConversation()
                        }
                      }
                    }
                  }

                  setTimeout(() => {
                    this.fetchConversationRecords()
                      .then((convoIds:REXSpiderCrawlInspection[]) => {
                        for (const convoId of convoIds) {
                          if (toCrawl.includes(convoId) === false) {
                            toCrawl.push(convoId)
                          }
                        }

                        setTimeout(() => {
                          this.fetchProjectRecords()
                            .then((projectRecords:REXSpiderCrawlInspection[]) => {
                              for (const convoRecord of projectRecords) {
                                if (toCrawl.includes(convoRecord) === false) {
                                  toCrawl.push(convoRecord)
                                }
                              }

                              fetchNextConversation()
                            })
                            .catch((err) => {
                              crawlResult.issues.push({
                                  url: this.loginUrl(),
                                  message: `Unable to fetch project URLs: ${err}.`
                              })

                              if (this.continueAfterError()) {
                                this.signalCrawlComplete(-1, crawledIds, `Unable to fetch project URLs: ${err}.`, false)

                                setTimeout(() => {
                                  fetchNextConversation()
                                }, this.fetchCrawlDelay())
                              } else {
                                this.signalCrawlComplete(-1, crawledIds, `Unable to fetch project URLs: ${err}.`)
                                
                                resolve(crawlResult)
                              }
                            })
                        }, this.fetchCrawlDelay())
                      })
                      .catch((err) => {
                        this.signalCrawlComplete(-1, crawledIds, `Unable to fetch conversation IDs: ${err}.`)

                        crawlResult.issues.push({
                          url: this.loginUrl(),
                          message: `Unable to fetch conversation Ids: ${err}.`
                        })

                        resolve(crawlResult)
                      })
                  }, this.fetchCrawlDelay())
                }
              })
              .catch((err) => {
                this.signalCrawlComplete(-1, crawledIds, `Unable to read homepage body: ${err}.`)

                crawlResult.issues.push({
                  url: this.loginUrl(),
                  message: `Unable to read homepage body: ${err}.`
                })

                resolve(crawlResult)
              })
            }
          })
          .catch((err) => {
            console.log(`[rex-spider-chatgpt] Unexpected error during sync:`, err)
            this.signalCrawlComplete(-1, crawledIds, `Error fetching conversations: ${err}.`)

            crawlResult.issues.push({
              url: this.loginUrl(),
              message: `Error fetching conversations: ${err}.`
            })

            resolve(crawlResult)
          })


      })
    })
  }
}

const chatGPTSpider = new REXChatGPTSpider()

rexSpiderPlugin.registerSpider(chatGPTSpider)

export default chatGPTSpider