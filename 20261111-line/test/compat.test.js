// 模型相容性與排隊上限的測試（模擬環境）。
// 這裡的假模型不支援圖片、也不會思考；另外把「最多幾個請求排隊」設成 1、keep_alive 設成 -1。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  SECRET,
  TOKEN,
  FAKE_MODEL,
  IMAGES,
  waitFor,
  startFakeLine,
  startFakeOllama,
  userId,
  makeEvent,
  textEvent,
  sendWebhook,
  captureLogs,
} from './helpers.js'

const logs = captureLogs()
const line = await startFakeLine()
const ollama = await startFakeOllama({ capabilities: ['completion'] })

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: 'test/no-such.env', // 不讀真正的 .env
  CHANNEL_ID: 'test-channel',
  CHANNEL_SECRET: SECRET,
  CHANNEL_ACCESS_TOKEN: TOKEN,
  PORT: '0',
  OLLAMA_BASE_URL: `${ollama.url}/v1`,
  OLLAMA_MODEL: FAKE_MODEL,
  OLLAMA_KEEP_ALIVE: '-1',
  OLLAMA_MAX_QUEUE: '1',
  PARTY_MODE: 'sequential',
  REPLY_LIMIT_MS: '6000',
  REPLY_SEND_BUFFER_MS: '500',
  LINE_TIMEOUT_MS: '1000',
  AI_MIN_CALL_MS: '300',
})

const { bot, server } = await import('../index.js')
bot.endpoint = line.url
bot.dataEndpoint = line.url
if (!server.listening) await once(server, 'listening')
const { port } = server.address()

after(async () => {
  server.closeAllConnections()
  server.close()
  await line.close()
  await ollama.stop()
})

const replyOf = (event) =>
  waitFor(() => line.replyTo(event), {
    label: `「${event.message.text || event.message.type}」的回覆`,
  })
const textsOf = (reply) => reply.messages.map((message) => message.text)

test('不會思考的模型：請求不帶 reasoning_effort；keep_alive 設成 -1 時用數字送出', async () => {
  await waitFor(() => logs.some((item) => item.includes('的能力：completion')))
  const event = textEvent(userId(), '給不會思考的模型的問題')
  await sendWebhook(port, event)
  assert.deepEqual(textsOf(await replyOf(event)), ['答覆0'])
  const { body } = ollama.state.requests[0]
  assert.equal('reasoning_effort' in body, false)
  assert.equal(body.keep_alive, -1)
})

test('不支援圖片的模型：直接告知使用者，不把圖片送給模型', async () => {
  const before = ollama.state.requests.length
  const event = makeEvent(userId(), { type: 'image', contentProvider: { type: 'line' } })
  line.state.contents.set(event.message.id, { type: 'image/jpeg', body: IMAGES.jpeg })
  await sendWebhook(port, event)
  assert.deepEqual(textsOf(await replyOf(event)), [
    `目前使用的模型（${FAKE_MODEL}）看不懂圖片，請改用文字描述。`,
  ])
  assert.equal(ollama.state.requests.length, before)
})

test('排隊等模型的請求已滿：多出來的人立刻被告知稍後再試，不會佔用模型', async () => {
  const before = ollama.state.requests.length
  ollama.state.delay = 500
  const events = ['第一個人的問題', '第二個人的問題', '第三個人的問題'].map((text) =>
    textEvent(userId(), text),
  )
  await sendWebhook(port, events)
  const replies = []
  for (const event of events) replies.push(await replyOf(event))
  assert.deepEqual(textsOf(replies[2]), ['現在同時使用的人比較多，請稍等一下再傳。'])
  assert.ok(replies[2].at < replies[0].at, '第三個人不用等前面的人做完就得到答覆')
  assert.equal(replies[0].delivered && replies[1].delivered, true)
  assert.match(textsOf(replies[0])[0], /^答覆/)
  assert.match(textsOf(replies[1])[0], /^答覆/)
  assert.equal(ollama.state.requests.length, before + 2, '第三個請求沒有送到模型')
  assert.ok(logs.some((item) => item.includes('失敗：busy')))
})
