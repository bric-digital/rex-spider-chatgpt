import $ from 'jquery'

import webmunkSpiderManager, { WebmunkContentSpider } from '@bric/webmunk-spider/spider'

export class WebmunkChatGPTContentSpider extends WebmunkContentSpider {
  toString():string {
    return 'WebmunkChatGPTContentSpider'
  }

  name():string {
    return 'ChatGPT'
  }

  urlMatches(url:string): boolean {
    if (window.location.href.toLowerCase() === 'https://chatgpt.com/#checkLogin') {
      return true // Login check page
    }

    if (window.location.href.toLowerCase() === 'https://chatgpt.com/') {
      return true // Library page
    }

    if (window.location.href.toLowerCase().startsWith('https://chatgpt.com')) {
      return true // Conversation page
    }

    return false
  }

  fetchResults() {
    // const response = {
    //   spiderName: 'ChatGPT',
    //   results: [],
    //   urls: [],
    //   loggedIn: false
    // }

    window.setTimeout(() => {
      console.log(`[${this.name()}]: fetchResults... ${window.location.href.toLowerCase()}`)

      if (window.location.href.toLowerCase() === 'https://chatgpt.com/#checkLogin') {
        console.log(`[${this.name()}]: CHECKING LOGIN...`)

        if ($('button[data-testid="login-button"]').length > 0) { // Logged in...
          console.log(`[${this.name()}]: Sending needs login...`)
          chrome.runtime.sendMessage({
            messageType: 'spiderLoginResults',
            spiderName: this.name(),
            loggedIn: false
          })
        } else {
          console.log(`[${this.name()}]: Sending needs NO login...`)
          chrome.runtime.sendMessage({
            messageType: 'spiderLoginResults',
            spiderName: this.name(),
            loggedIn: true
          })
        }
        return
      } else if (window.location.href.toLowerCase() === 'https://chatgpt.com/') {
        let urls = []

        $('div#history a').each((index, item) => {
          const href = $(item).attr('href')

          if (href.startsWith('/c/')) {
            urls.push(`https://chatgpt.com${href}`)
          }
        })

        chrome.runtime.sendMessage({
          messageType: 'spiderSources',
          spiderName: this.name(),
          urls
        })

        return
      }

    }, 1000)

    // } else if (window.location.href.toLowerCase().startsWith('https://chatgpt.com/')) {
    //   // Conversation page
    // } else if (window.location.href.toLowerCase() === 'https://chatgpt.com/') {
    //   if ($('div.group/sidebar button div:trimmedTextEquals("Account")').length > 0) {
    //     response.loggedIn = true
    //   }
    // }
  }
}

const spider = new WebmunkChatGPTContentSpider()
webmunkSpiderManager.registerSpider(spider)

export default spider
