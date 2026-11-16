// 電腦時鐘不準時的「訊息晚到」警告（模擬環境）。
// 實際發生過：電腦時鐘快了 11.7 秒，結果每一則訊息都被誤報成「12 秒後才送達」。
// 這裡讓每個事件的時間都比本機時鐘早 12 秒，模擬同樣的狀況。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  SECRET,
  TOKEN,
  FAKE_MODEL,
  waitFor,
  startFakeLine,
  startFakeOllama,
  userId,
  textEvent,
  sendWebhook,
  captureLogs,
} from './helpers.js'

const SKEW_MS = 12 * 1000

const logs = captureLogs()
const line = await startFakeLine()
const ollama = await startFakeOllama()
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: 'test/no-such.env', // 不讀真正的 .env
  CHANNEL_ID: 'test-channel',
  CHANNEL_SECRET: SECRET,
  CHANNEL_ACCESS_TOKEN: TOKEN,
  PORT: '0',
  OLLAMA_BASE_URL: `${ollama.url}/v1`,
  OLLAMA_MODEL: FAKE_MODEL,
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

const user = userId()
// 送一則 help（不需要模型）；delayMs 是這則訊息額外晚到多久
const send = async (delayMs = 0) => {
  const event = textEvent(user, 'help', { timestamp: Date.now() - SKEW_MS - delayMs })
  await sendWebhook(port, event)
  const reply = await waitFor(() => line.replyTo(event), { label: 'help 的回覆' })
  assert.equal(reply.delivered, true)
}
const count = (text) => logs.filter((item) => item.includes(text)).length

test('時鐘快了 12 秒：只提醒一次時鐘可能不準，不會每一則都誤報晚到', async () => {
  for (let i = 0; i < 6; i++) await send()
  assert.equal(count('比平常晚了'), 0, '沒有任何一則被誤報成晚到')
  assert.equal(count('這則訊息在發生'), 0, '舊的誤報訊息不再出現')
  assert.equal(count('時鐘可能不準'), 1, '只提醒一次')
  assert.ok(logs.some((item) => item.includes('固定相差約 12 秒')))
})

test('真的晚到的訊息仍然會警告，而且只警告那一則', async () => {
  await send(30 * 1000) // 這一則比平常多晚了 30 秒
  assert.equal(count('比平常晚了 30 秒才送達'), 1)
  for (let i = 0; i < 3; i++) await send()
  assert.equal(count('比平常晚了'), 1, '之後正常的訊息不受那一則影響')
})
