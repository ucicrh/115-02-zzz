// 機器人啟動時 Ollama 還沒開的情況（模擬環境）。
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
// capabilities: null → 之後就算連得上，也查不到這個模型的能力
const ollama = await startFakeOllama({ capabilities: null })
await ollama.stop() // 機器人啟動的時候，Ollama 不在

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: 'test/no-such.env', // 不讀真正的 .env
  CHANNEL_ID: 'test-channel',
  CHANNEL_SECRET: SECRET,
  CHANNEL_ACCESS_TOKEN: TOKEN,
  PORT: '0',
  OLLAMA_BASE_URL: `${ollama.url}/v1`,
  OLLAMA_MODEL: FAKE_MODEL,
  PARTY_MODE: 'sequential',
  REPLY_LIMIT_MS: '6000',
  REPLY_SEND_BUFFER_MS: '500',
  LINE_TIMEOUT_MS: '1000',
  AI_MIN_CALL_MS: '300',
})
delete process.env.OLLAMA_KEEP_ALIVE
delete process.env.OLLAMA_MAX_QUEUE

const { bot, server } = await import('../index.js')
bot.endpoint = line.url
bot.dataEndpoint = line.url
if (!server.listening) await once(server, 'listening')
const { port } = server.address()
const { HELP_TEXT } = await import('../commands.js')

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
const say = async (user, text) => {
  const event = textEvent(user, text)
  await sendWebhook(port, event)
  return event
}

test('Ollama 沒開也能啟動：預載失敗只寫日誌，不需要 AI 的功能照常運作', async () => {
  await waitFor(
    () => logs.some((item) => item.includes(`預載模型 ${FAKE_MODEL} 失敗（Ollama 沒有啟動）`)),
    {
      label: '預載失敗的日誌',
    },
  )
  assert.equal(server.listening, true)
  const user = userId()
  assert.deepEqual(textsOf(await replyOf(await say(user, 'help'))), [HELP_TEXT])
  assert.deepEqual(textsOf(await replyOf(await say(user, '這時候問 AI 問題'))), [
    '現在連不上 AI 模型，請稍後再試。',
  ])
})

test('Ollama 之後才啟動：不用重開機器人就恢復；查不到模型能力時照舊嘗試', async () => {
  await ollama.start()
  const user = userId()
  assert.deepEqual(textsOf(await replyOf(await say(user, 'Ollama 開了之後的問題'))), ['答覆0'])
  assert.equal(
    ollama.state.requests[0].body.reasoning_effort,
    'none',
    '不確定模型會不會思考時，照舊帶參數',
  )

  // 不確定模型看不看得懂圖片時，照舊交給模型試試
  const event = makeEvent(user, { type: 'image', contentProvider: { type: 'line' } })
  line.state.contents.set(event.message.id, { type: 'image/png', body: IMAGES.png })
  await sendWebhook(port, event)
  assert.deepEqual(textsOf(await replyOf(event)), ['答覆1'])
  const content = ollama.state.requests[1].body.messages.at(-1).content
  assert.equal(content[0].type, 'image_url')
})
