import corePlugin, { dispatchEvent } from '@bric/rex-core/service-worker'
import rexSpider from '@bric/rex-spider/service-worker'
import chatGPTSpider from '@bric/rex-spider-chatgpt/service-worker'

console.log(`Imported ${corePlugin} into service worker context...`)

self['rexCorePlugin'] = corePlugin
self['rexSpiderPlugin'] = rexSpider
self['rexChatGPTPlugin'] = chatGPTSpider

corePlugin.setup()
