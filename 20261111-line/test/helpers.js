// 測試工具：假的 LINE 平台、假的 Ollama，以及送 webhook 給機器人的函式。
// 測試不會連到真正的 LINE，也不會讀 .env 裡的真實權杖。
import http from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'

export const SECRET = 'test-channel-secret'
export const TOKEN = 'test-channel-token'
export const FAKE_MODEL = 'fake-model'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 等到 check() 回傳真值為止；超過時間就丟出錯誤
export const waitFor = async (check, { timeout = 10000, interval = 15, label = '條件' } = {}) => {
  const startedAt = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - startedAt > timeout) throw new Error(`等了 ${timeout}ms 還是沒有：${label}`)
    await sleep(interval)
  }
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

const parse = (raw) => {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

// ---------- 假的 LINE 平台 ----------
// state.replyMode 決定回覆 API 的反應：
//   ok 正常｜invalid_token 權杖無效（HTTP 400）｜error500 伺服器錯誤｜bad_request 訊息格式錯誤｜hang 不回應
// state.replyDelay：收到回覆請求後，過幾毫秒才回應（模擬回覆還在路上）
export const startFakeLine = async () => {
  const state = {
    replies: [], // 每一次回覆請求：{ at, replyToken, messages, mode, delivered }
    loading: [], // 載入動畫請求：{ at, chatId, loadingSeconds }
    downloads: [], // 被下載過的訊息 ID
    contents: new Map(), // 訊息 ID -> { status, type, body, headers }
    auth: new Set(), // 收到過的 Authorization 標頭
    usedTokens: new Set(),
    tokenUses: new Map(), // 每個回覆權杖被拿來送出幾次（整個測試期間累計，reset 不會清掉）
    replyMode: 'ok',
    replyDelay: 0,
  }
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req)
    const send = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-line-request-id': randomUUID(),
      })
      res.end(JSON.stringify(body))
    }
    state.auth.add(req.headers.authorization)

    if (req.method === 'POST' && req.url === '/v2/bot/message/reply') {
      const body = parse(raw)
      const record = {
        at: Date.now(),
        replyToken: body.replyToken,
        messages: body.messages,
        mode: state.replyMode,
        delivered: false,
      }
      state.replies.push(record)
      state.tokenUses.set(body.replyToken, (state.tokenUses.get(body.replyToken) || 0) + 1)
      if (state.replyDelay) await sleep(state.replyDelay)
      if (record.mode === 'hang') return
      if (record.mode === 'invalid_token') return send(400, { message: 'Invalid reply token' })
      if (record.mode === 'error500') return send(500, { message: 'Internal server error' })
      if (record.mode === 'bad_request') {
        return send(400, {
          message: 'The request body has 1 error(s)',
          details: [{ message: 'May not be empty', property: 'messages[0].text' }],
        })
      }
      // 跟真的 LINE 一樣：回覆權杖只能用一次，一次最多 5 則
      if (state.usedTokens.has(body.replyToken))
        return send(400, { message: 'Invalid reply token' })
      if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 5) {
        return send(400, { message: 'The request body has 1 error(s)' })
      }
      state.usedTokens.add(body.replyToken)
      record.delivered = true
      return send(200, { sentMessages: body.messages.map((_, index) => ({ id: String(index) })) })
    }

    if (req.method === 'POST' && req.url === '/v2/bot/chat/loading/start') {
      state.loading.push({ at: Date.now(), ...parse(raw) })
      return send(202, {})
    }

    const content = req.url.match(/^\/v2\/bot\/message\/([^/]+)\/content$/)
    if (req.method === 'GET' && content) {
      state.downloads.push(content[1])
      const item = state.contents.get(content[1])
      if (!item) return send(404, { message: 'not found' })
      res.writeHead(item.status ?? 200, { 'content-type': item.type, ...(item.headers || {}) })
      return res.end(item.body)
    }
    return send(404, { message: 'Not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    state,
    url: `http://127.0.0.1:${port}/v2/bot`,
    // 成功送達的回覆
    delivered: () => state.replies.filter((item) => item.delivered),
    // 某個事件收到的回覆（還沒有就是 undefined）
    replyTo: (event) => state.replies.find((item) => item.replyToken === event.replyToken),
    reset: () => {
      state.replies.length = 0
      state.loading.length = 0
      state.downloads.length = 0
      state.contents.clear()
      state.replyMode = 'ok'
      state.replyDelay = 0
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}

// ---------- 假的 Ollama ----------
// 聚會用的 JSON 回覆裡，每次給不一樣的句子，免得被當成重複發言
const SENTENCES = [
  '去爬山啊，流汗最舒服了',
  '那個…山上會不會很冷',
  '七星山步道來回約兩小時',
  '不然改天約個下午茶比較實在',
  '學生票有打折嗎拜託',
  '霧裡的樹看起來像水彩暈開',
  '先查好公車班次才不會白跑',
  '我比較想待在家裡畫畫',
  '門票錢省下來可以吃兩碗拉麵',
  '記得帶夠水跟一件薄外套',
  '這季節芒草應該正漂亮',
  '人多的地方我會有點緊張',
  '健身房年費攤下來一天不到三十塊',
  '值完大夜班只想睡到自然醒',
  '程式跑不動通常是環境沒設好',
  '預算表先給我看再決定',
  '期中考週誰有空出門啦',
  '顏料乾掉的味道其實滿好聞的',
  '蛋白質一天要吃到體重的兩倍克數',
  '打針其實沒有大家想的那麼痛',
  '那個數字的來源是哪裡',
  '客戶要的東西永遠跟上次不一樣',
  '宿舍冷氣又壞了超崩潰',
  '下雨天的窗戶像一幅會動的畫',
]

// 照 JSON Schema 產生一份合法的內容
const fromSchema = (schema, index) => {
  if (schema.enum) return schema.enum[0]
  if (schema.type === 'object') {
    return Object.fromEntries(
      Object.entries(schema.properties || {}).map(([key, value]) => [
        key,
        key === 'text' ? SENTENCES[index % SENTENCES.length] : fromSchema(value, index),
      ]),
    )
  }
  if (schema.type === 'array') return [fromSchema(schema.items, index)]
  if (schema.type === 'boolean') return false
  if (schema.type === 'number' || schema.type === 'integer') return 0
  return `內容${index}`
}

// 每個請求的反應由 state.plan（依序取用）或 state.respond(body) 決定，可用的設定：
//   delay 幾毫秒後才回應｜hang 永遠不回應｜reset 直接切斷連線｜status 回傳 HTTP 錯誤
//   text 直接指定回覆內容（字串）｜result 覆蓋聚會 JSON 裡的欄位（例如 { wrap_up: true }）
export const startFakeOllama = async ({
  capabilities = ['completion', 'vision', 'tools', 'thinking'],
} = {}) => {
  const state = {
    requests: [], // 對話請求：{ at, body, aborted, done, json }
    plan: [],
    respond: null,
    delay: 0,
    active: 0,
    maxActive: 0,
    loaded: true, // /api/ps 會不會列出模型
    capabilities, // null 表示查不到
    preloads: 0,
    preloadDelay: 0,
    shows: 0,
  }
  let port = 0
  let server = null

  const handler = async (req, res) => {
    const raw = await readBody(req)
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/api/ps') {
      return send(200, {
        models: state.loaded ? [{ name: FAKE_MODEL, model: FAKE_MODEL }] : [],
      })
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      state.shows += 1
      if (!state.capabilities) return send(404, { error: `model '${FAKE_MODEL}' not found` })
      return send(200, { capabilities: state.capabilities })
    }
    if (req.method === 'POST' && req.url === '/api/generate') {
      state.preloads += 1
      await sleep(state.preloadDelay)
      state.loaded = true
      return send(200, { model: FAKE_MODEL, response: '', done: true, done_reason: 'load' })
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      return send(404, { error: 'not found' })
    }

    const body = parse(raw)
    const index = state.requests.length
    const record = { at: Date.now(), body, aborted: false, done: false, json: null }
    state.requests.push(record)
    state.active += 1
    state.maxActive = Math.max(state.maxActive, state.active)
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      state.active -= 1
    }
    // 用戶端中途取消（逾時或聚會結束）時，連線會在回應之前就關掉
    res.on('close', () => {
      if (!record.done) record.aborted = true
      finish()
    })

    const behavior = state.plan.shift() || state.respond?.(body, index) || {}
    if (behavior.hang) return
    if (behavior.reset) return req.socket.destroy()
    const delay = behavior.delay ?? state.delay
    if (delay) await sleep(delay)
    if (record.aborted) return
    if (behavior.status) {
      record.done = true
      return send(behavior.status, { error: { message: `fake error ${behavior.status}` } })
    }

    let content = behavior.text
    if (content === undefined) {
      const schema = body.response_format?.json_schema?.schema
      if (schema) {
        record.json = fromSchema(schema, index)
        if (behavior.result !== undefined) {
          record.json.result = Array.isArray(behavior.result)
            ? behavior.result
            : { ...record.json.result, ...behavior.result }
        }
        content = JSON.stringify(record.json)
      } else {
        content = `答覆${index}`
      }
    }
    record.content = content
    record.done = true
    return send(200, {
      id: `fake-${index}`,
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: behavior.finish || 'stop',
        },
      ],
      usage: { prompt_tokens: 100 + index, completion_tokens: 20, total_tokens: 120 + index },
    })
  }

  const start = async () => {
    server = http.createServer(handler)
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
    port = server.address().port
  }
  const stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(resolve)
    })
  await start()

  return {
    state,
    get url() {
      return `http://127.0.0.1:${port}`
    },
    start, // 停掉之後在同一個埠重新啟動
    stop, // 模擬 Ollama 沒有開
    // 對話請求裡的文字內容（方便檢查模型到底收到了什麼）
    textsOf: (record) =>
      record.body.messages.map((message) =>
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((part) =>
                part.type === 'text' ? part.text : `[image:${part.image_url.url.slice(0, 22)}]`,
              )
              .join('\n'),
      ),
    reset: () => {
      state.requests.length = 0
      state.plan.length = 0
      state.respond = null
      state.delay = 0
      state.maxActive = 0
      state.loaded = true
    },
  }
}

// ---------- 送 webhook ----------
let messageId = 1000

export const userId = () => `U${randomUUID().replace(/-/g, '')}`

// 一則 LINE 訊息事件。message 例如 { type: 'text', text: '你好' }
export const makeEvent = (user, message, overrides = {}) => ({
  type: 'message',
  webhookEventId: randomUUID(),
  deliveryContext: { isRedelivery: false },
  timestamp: Date.now(),
  source: { type: 'user', userId: user },
  replyToken: randomUUID().replace(/-/g, ''),
  mode: 'active',
  message: { id: String(++messageId), ...message },
  ...overrides,
})

export const textEvent = (user, text, overrides) =>
  makeEvent(user, { type: 'text', text }, overrides)

// 像 LINE 一樣簽章後送給機器人；回傳 HTTP 狀態碼
export const sendWebhook = async (port, events, { secret = SECRET } = {}) => {
  const body = JSON.stringify({ destination: 'test', events: [events].flat() })
  const signature = createHmac('sha256', secret).update(body, 'utf8').digest('base64')
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': signature },
    body,
  })
  await res.text()
  return res.status
}

// 把 console 的輸出收集起來（測試時不印出來，設定 TEST_LOGS=1 才印），用來檢查日誌內容
export const captureLogs = () => {
  const lines = []
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      const line = args
        .map((arg) => (arg instanceof Error ? `${arg.stack || arg}` : String(arg)))
        .join(' ')
      lines.push(line)
      if (process.env.TEST_LOGS) original(line)
    }
  }
  return lines
}

// ---------- 測試用的圖片 ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

// 產生一張單色的 PNG 圖片（真的可以被解碼）
export const solidPng = (width, height, [r, g, b]) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // 每個顏色 8 位元
  header[9] = 2 // RGB
  const row = Buffer.alloc(1 + width * 3) // 開頭一個位元組是濾鏡類型（0＝無）
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 測試用的文字編碼 ----------
// Node 只內建「解碼」Big5、GBK，測試要產生這些編碼的檔案，所以先用解碼器建一張反查表
const encoders = new Map()
export const encodeText = (label, text) => {
  if (!encoders.has(label)) {
    const decoder = new TextDecoder(label)
    const table = new Map()
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail === 0x7f) continue
        const char = decoder.decode(Uint8Array.of(lead, trail))
        if (char.length === 1 && char !== '�' && !table.has(char)) table.set(char, [lead, trail])
      }
    }
    encoders.set(label, table)
  }
  const table = encoders.get(label)
  const bytes = []
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) bytes.push(char.charCodeAt(0))
    else bytes.push(...(table.get(char) || [0x3f]))
  }
  return Buffer.from(bytes)
}

// 各種格式的小圖片（除了 PNG，其他只有檔頭是真的，夠讓機器人判斷格式）
export const IMAGES = {
  png: solidPng(8, 8, [255, 0, 0]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF fake jpeg body')]),
  gif: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]),
}
