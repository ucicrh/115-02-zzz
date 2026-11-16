// 用真正的本機 Ollama 測「文字檔逾時之後，一般對話能不能恢復正常」。
// 為了不必真的等 48 秒，這個檔案把回覆期限縮短成 12 秒（生成期限 8 秒），並把文字檔上限放寬成 8,000 字，
// 讓 8,000 字的數字表格一定來不及（模型最快也要讀 13 秒）；其餘都是真實的模型與正式的程式。LINE 仍然是假的。
// Ollama 沒有啟動、或沒有安裝模型時，整份測試會略過。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  SECRET,
  TOKEN,
  waitFor,
  startFakeLine,
  userId,
  makeEvent,
  textEvent,
  sendWebhook,
  captureLogs,
} from './helpers.js'

const MODEL = process.env.OLLAMA_MODEL || 'qwen3.6:35b-a3b'
const BASE = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '')
const available = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(3000) })
  .then((res) => res.json())
  .then((data) => (data.models || []).some((item) => item.name === MODEL))
  .catch(() => false)

if (!available) {
  test(`真實模型測試（略過：連不上 ${BASE}，或沒有安裝 ${MODEL}）`, { skip: true }, () => {})
} else {
  const logs = captureLogs()
  const line = await startFakeLine()
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: 'test/no-such.env', // 不讀真正的 .env，LINE 用假的權杖
    CHANNEL_ID: 'test-channel',
    CHANNEL_SECRET: SECRET,
    CHANNEL_ACCESS_TOKEN: TOKEN,
    PORT: '0',
    REPLY_LIMIT_MS: '12000',
    REPLY_SEND_BUFFER_MS: '4000',
    TEXT_FILE_MAX_CHARS: '8000',
    MEMORY_MAX_CHARS: '10000',
  })
  for (const name of ['AI_MIN_CALL_MS', 'OLLAMA_KEEP_ALIVE']) {
    delete process.env[name]
  }
  const { bot, server } = await import('../index.js')
  bot.endpoint = line.url
  bot.dataEndpoint = line.url
  if (!server.listening) await once(server, 'listening')
  const { port } = server.address()

  after(async () => {
    server.closeAllConnections()
    server.close()
    await line.close()
  })

  const send = async (event) => {
    const before = logs.length
    const startedAt = Date.now()
    assert.equal(await sendWebhook(port, event), 200)
    const reply = await waitFor(() => line.replyTo(event), { timeout: 60000, interval: 50 })
    const entry = logs.slice(before).find((item) => item.startsWith('[對話')) || ''
    return {
      text: reply.messages[0].text,
      seconds: (reply.at - startedAt) / 1000,
      input: Number(entry.match(/輸入 (\d+)/)?.[1] ?? NaN),
      log: entry,
    }
  }
  const csvLine = (i) =>
    `2026-11-${String((i % 28) + 1).padStart(2, '0')},${2300 + (i % 60)},${(2385.5 + i * 0.35).toFixed(2)},${(2395.25 + i * 0.4).toFixed(2)},${(2330.75 - i * 0.2).toFixed(2)},${34359285 + i * 7919}\r\n`
  let csv = ''
  for (let i = 1; csv.length < 8000; i++) csv += csvLine(i)

  test(
    '文字檔逾時之後：記憶裡不留整份檔案，一般對話馬上恢復正常',
    { timeout: 240000 },
    async (t) => {
      await waitFor(
        () => logs.some((item) => item.includes('已載入') || item.includes('預載模型')),
        {
          timeout: 180000,
          interval: 200,
          label: '模型載入',
        },
      )
      const user = userId()
      const named = await send(textEvent(user, '我叫小明，請記住我的名字。只回一個字：好'))
      t.diagnostic(`先聊一句 → ${named.seconds.toFixed(1)} 秒：${named.text}`)

      const file = makeEvent(user, {
        type: 'file',
        fileName: 'data.csv',
        fileSize: Buffer.byteLength(csv),
      })
      line.state.contents.set(file.message.id, { type: 'text/plain', body: csv })
      const failed = await send(file)
      t.diagnostic(
        `8,000 字的檔案（期限縮短成 8 秒）→ ${failed.seconds.toFixed(1)} 秒：${failed.text}`,
      )
      assert.equal(failed.text, 'AI 這次來不及在時限內回覆，請再傳一次。')
      assert.match(failed.log, /失敗：timeout/)

      const next = await send(textEvent(user, '我叫什麼名字？'))
      t.diagnostic(
        `逾時之後的一般對話 → ${next.seconds.toFixed(1)} 秒，輸入 ${next.input} tokens：${next.text}`,
      )
      assert.match(next.text, /小明/, '記得逾時之前說過的話')
      assert.ok(
        next.input < 1500,
        `記憶裡沒有整份檔案（整份約 8,000 tokens，實際輸入 ${next.input}）`,
      )
      assert.ok(next.seconds < 6, '很快就有回應')
    },
  )
}
