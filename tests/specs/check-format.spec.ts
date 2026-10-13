import { test, expect } from './fixtures';

const testFiles = {
  'desktop-app-1.json': {
    'turns_length': 2,
    'platform': 'chatgpt',
    'identifier': '6aa01272-2688-83e9-ad53-fa714a50f3fe',
    'started_value': '2026-09-08T13:49:38.860025856Z',
    'ended_value': '2026-09-08T13:49:41.427Z'
  },
  'mobile-app-1.json': {
    'turns_length': 2,
    'platform': 'chatgpt',
    'identifier': '6aa01135-af88-83e9-9117-b5c384e0586d',
    'started_value': '2026-09-08T13:44:22.533660928Z',
    'ended_value': '2026-09-08T13:44:30.932Z'
  },
  'mobile-app-2.json': {
    'turns_length': 2,
    'platform': 'chatgpt',
    'identifier': '6aa01141-bd84-83ea-a3a8-db8a358fe60f',
    'started_value': '2026-09-08T13:44:34.629404928Z',
    'ended_value': '2026-09-08T13:44:36.846Z'
  },
  'web-browser-1.json': {
    'turns_length': 2,
    'platform': 'chatgpt',
    'identifier': '6aa011a9-1c48-83e9-910c-0a4e99fbb317',
    'started_value': '2026-09-08T13:46:17.916142848Z',
    'ended_value': '2026-09-08T13:46:58.031Z'
  },
  'web-browser-2.json': {
    'turns_length': 2,
    'platform': 'chatgpt',
    'identifier': '6a99c765-c670-83e9-8fcb-8eb222ad4c6c',
    'started_value': '2026-09-03T19:15:51.35677696Z',
    'ended_value': '2026-09-03T19:15:51.356Z'
  }
}

test.describe('REX Spider - Chat GPT - Check Formats', () => {
  for (const testFile of Object.keys(testFiles)) {
    test(testFile, async ({serviceWorker}) => {
      const values = testFiles[testFile]
  
      return new Promise<void>((resolve) => {
        serviceWorker.evaluate(async (filename) => {
          return new Promise((testResolve) => {
            const dataUrl = chrome.runtime.getURL(`data/${filename}`)

            console.log(`DATA URL: ${dataUrl}`)

            fetch(dataUrl).then((response) => {
              if (response.ok) {
                response.json().then((rawData) => {
                  rexChatGPTPlugin.parseConversation(rawData).then((payload) => {
                    testResolve(payload)
                  }).expect((err) => { 
                    testResolve(err)
                  })
                }).expect((err) => { 
                  testResolve(err)
                })
              } else {
                testResolve(null)
              }
            })
          })
        }, testFile)
        .then((workerResponse) => {
          expect(typeof workerResponse).toEqual('object')
          expect(workerResponse['turns'].length).toEqual(values['turns_length'])
          expect(workerResponse['platform']).toEqual(values['platform'])
          expect(workerResponse['identifier']).toEqual(values['identifier'])
          expect(workerResponse['started']['value']).toEqual(values['started_value'])
          expect(workerResponse['ended']['value']).toEqual(values['ended_value'])

          resolve()
        })
      })
    })
  }
})

