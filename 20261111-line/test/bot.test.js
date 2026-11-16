// 機器人的自動化測試（模擬環境）。
// LINE 平台和 Ollama 都是測試自己開的假伺服器，所以可以製造逾時、斷線、回覆失敗等狀況；
// 這裡驗證的是程式的流程，不是真實 LINE 或真實模型的表現（真實模型另見 real.test.js）。
// 為了不用真的等一分鐘，時間限制都縮短了（回覆期限 6 秒、聚會單次呼叫 1.5 秒…），邏輯與正式環境相同。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  SECRET,
  TOKEN,
  FAKE_MODEL,
  IMAGES,
  sleep,
  waitFor,
  startFakeLine,
  startFakeOllama,
  userId,
  makeEvent,
  textEvent,
  sendWebhook,
  captureLogs,
  encodeText,
} from './helpers.js'

const logs = captureLogs()
const line = await startFakeLine()
const ollama = await startFakeOllama()

// ---------- 天氣、匯率、新聞用假的回應，不連到網路 ----------
const external = { hang: false, status: 0, calls: [] }
const realFetch = globalThis.fetch
const json = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init)
  external.calls.push(url.href)
  if (external.hang) {
    // 對方一直不回應，直到被逾時中斷
    return new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal.reason))
    })
  }
  // 對方回 HTTP 錯誤（例如 500）
  if (external.status) return Promise.resolve(new Response('error', { status: external.status }))
  if (url.hostname === 'geocoding-api.open-meteo.com') {
    const found = !url.searchParams.get('name').includes('火星')
    return Promise.resolve(
      json(
        found
          ? { results: [{ name: '東京', country: '日本', latitude: 35.68, longitude: 139.69 }] }
          : {},
      ),
    )
  }
  if (url.hostname === 'api.open-meteo.com') {
    return Promise.resolve(
      json({
        current: {
          temperature_2m: 24,
          apparent_temperature: 25,
          relative_humidity_2m: 70,
          weather_code: 1,
          wind_speed_10m: 8,
        },
        daily: {
          time: ['2026-11-12', '2026-11-13', '2026-11-14'],
          weather_code: [1, 2, 61],
          temperature_2m_max: [26, 25, 22],
          temperature_2m_min: [19, 18, 17],
          precipitation_probability_max: [10, 40, 80],
        },
      }),
    )
  }
  if (url.hostname === 'open.er-api.com') {
    return Promise.resolve(
      json({
        result: 'success',
        time_last_update_unix: 1794441600,
        rates: {
          USD: 1,
          TWD: 32,
          JPY: 150,
          EUR: 0.9,
          CNY: 7.1,
          HKD: 7.8,
          KRW: 1350,
          GBP: 0.78,
          AUD: 1.5,
        },
      }),
    )
  }
  if (url.hostname === 'news.google.com') {
    const empty = url.searchParams.get('q')?.includes('查無此事')
    const item = (n) =>
      `<item><title>測試新聞標題${n} - 測試報</title><link>https://example.com/news/${n}</link><source url="https://example.com">測試報</source></item>`
    return Promise.resolve(
      new Response(`<rss><channel>${empty ? '' : item(1) + item(2)}</channel></rss>`, {
        status: 200,
      }),
    )
  }
  return Promise.reject(new Error(`測試沒有準備這個網址的假回應：${url.hostname}`))
}

// ---------- 啟動機器人 ----------
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: 'test/no-such.env', // 不讀真正的 .env
  CHANNEL_ID: 'test-channel',
  CHANNEL_SECRET: SECRET,
  CHANNEL_ACCESS_TOKEN: TOKEN,
  PORT: '0', // 由系統挑一個沒人用的埠，不會撞到正在執行的機器人
  OLLAMA_BASE_URL: `${ollama.url}/v1`,
  OLLAMA_MODEL: FAKE_MODEL,
  PARTY_MODE: 'sequential',
  REPLY_LIMIT_MS: '6000',
  REPLY_SEND_BUFFER_MS: '500',
  LINE_TIMEOUT_MS: '1000',
  PARTY_MERGE_MS: '300',
  PARTY_STAGE_MS: '1500',
  PARTY_RESERVE_MS: '700',
  PARTY_MIN_STAGE_MS: '400',
  AI_MIN_CALL_MS: '300',
  PENDING_TTL_MS: '1000',
})
delete process.env.OLLAMA_KEEP_ALIVE
delete process.env.LINE_LOADING
delete process.env.OLLAMA_MAX_QUEUE

const { bot, server } = await import('../index.js')
bot.endpoint = line.url
bot.dataEndpoint = line.url
if (!server.listening) await once(server, 'listening')
const { port } = server.address()
const party = await import('../party.js')
const ai = await import('../OpenAI.js')
const { HELP_TEXT, TASKS } = await import('../commands.js')

after(async () => {
  server.closeAllConnections()
  server.close()
  await line.close()
  await ollama.stop()
})

// ---------- 小工具 ----------
const spoken = new Set() // 測試中使用者說過的話，最後用來檢查日誌有沒有洩漏內容
const users = new Set()
const newUser = () => {
  const id = userId()
  users.add(id)
  return id
}
// 每個測試開始前把假伺服器的紀錄清掉，並等上一個測試留下的請求結束
const fresh = async () => {
  await waitFor(() => ollama.state.active === 0, { label: '上一個測試的請求結束' })
  await sleep(30)
  line.reset()
  ollama.reset()
  external.hang = false
  external.status = 0
  external.calls.length = 0
}
const say = async (user, text, overrides) => {
  const event = textEvent(user, text, overrides)
  spoken.add(text)
  event.sentAt = Date.now()
  assert.equal(await sendWebhook(port, event), 200)
  return event
}
const send = async (event) => {
  event.sentAt = Date.now()
  assert.equal(await sendWebhook(port, event), 200)
  return event
}
const replyOf = (event, timeout = 10000) =>
  waitFor(() => line.replyTo(event), {
    timeout,
    label: `「${event.message?.text || event.message?.type || event.type}」的回覆`,
  })
const textsOf = (reply) => reply.messages.map((message) => message.text)
const requests = () => ollama.state.requests
const sentTo = (index) => ollama.textsOf(requests()[index]) // 第 index 個請求裡，模型收到的每一則內容
const promptOf = (index) => requests()[index].body.messages[1].content // 聚會請求的提示詞
const enumOf = (index, field) =>
  requests()[index].body.response_format.json_schema.schema.properties.result.properties[field]
    ?.enum
const startParty = async (user) => {
  const reply = await replyOf(await say(user, '聚會'))
  assert.match(textsOf(reply)[0], /聚會開始/)
  return reply
}
const imageEvent = (user, body, type = 'image/jpeg', headers) => {
  const event = makeEvent(user, { type: 'image', contentProvider: { type: 'line' } })
  line.state.contents.set(event.message.id, { type, body, headers })
  return event
}
const fileEvent = (user, fileName, body) => {
  const event = makeEvent(user, { type: 'file', fileName, fileSize: Buffer.byteLength(body) })
  line.state.contents.set(event.message.id, { type: 'application/octet-stream', body })
  return event
}
const imagesIn = (index) =>
  requests()
    [index].body.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((part) => part.type === 'image_url')
    .map((part) => part.image_url.url.slice(0, part.image_url.url.indexOf(',')))
const NO_REPLY = '（這則訊息沒有成功回覆）'
const TOO_SLOW = 'AI 這次來不及在時限內回覆，請再傳一次。'

// ======================================================================
test('啟動：開始監聽之後才在背景預載模型，並查詢模型能力', async () => {
  await waitFor(() => ollama.state.preloads === 1, { label: '預載請求' })
  await waitFor(() => logs.some((item) => item.includes('已載入')), { label: '預載完成的日誌' })
  assert.equal(server.listening, true)
  assert.equal(ollama.state.shows, 1)
  assert.ok(logs.some((item) => item.includes('的能力：completion、vision、tools、thinking')))
})

test('1. 一般文字對話', async () => {
  await fresh()
  const user = newUser()
  const event = await say(user, '機密內容甲：今天星期幾')
  const reply = await replyOf(event)
  assert.equal(reply.delivered, true)
  assert.deepEqual(textsOf(reply), ['答覆0'])
  assert.equal(reply.messages[0].quickReply.items.length, 10, '一般回覆下方有 10 個快速按鈕')

  const [request] = requests()
  assert.equal(request.body.model, FAKE_MODEL)
  assert.equal(request.body.reasoning_effort, 'none', '會思考的模型要關掉思考')
  assert.equal(request.body.keep_alive, '30m', '每次請求都要求模型留在記憶體 30 分鐘')
  assert.equal(request.body.messages[0].role, 'system')
  assert.deepEqual(request.body.messages.slice(1), [
    { role: 'user', content: [{ type: 'text', text: '機密內容甲：今天星期幾' }] },
  ])

  // 等 AI 的時候顯示載入動畫（只有一對一聊天）
  await waitFor(() => line.state.loading.length === 1, { label: '載入動畫請求' })
  assert.equal(line.state.loading[0].chatId, user)
  assert.equal(line.state.loading[0].loadingSeconds % 5, 0, '秒數必須是 5 的倍數')
  assert.ok(line.state.loading[0].at <= reply.at, '動畫在回覆之前送出')
  // 呼叫 LINE 用的是測試的假權杖
  assert.deepEqual([...line.state.auth], [`Bearer ${TOKEN}`])
})

test('2. 連續兩則文字訊息：照順序處理，第二則看得到第一則的問答', async () => {
  await fresh()
  ollama.state.delay = 300
  const user = newUser()
  const first = textEvent(user, '我叫小明請記住')
  const second = textEvent(user, '我叫什麼名字呢')
  await sendWebhook(port, [first, second]) // 同一次 webhook 送來兩則
  const a = await replyOf(first)
  const b = await replyOf(second)
  assert.ok(a.at < b.at, '先回第一則，再回第二則')
  assert.equal(ollama.state.maxActive, 1, '同一個人的訊息不會同時處理')
  assert.deepEqual(sentTo(1).slice(1), ['我叫小明請記住', '答覆0', '我叫什麼名字呢'])
})

test('3. 快速連續傳送三則訊息：三則都回、順序正確、記憶不重複也不遺漏', async () => {
  await fresh()
  ollama.state.delay = 150
  const user = newUser()
  const events = []
  for (const text of ['連發第一則', '連發第二則', '連發第三則']) events.push(await say(user, text))
  const replies = []
  for (const event of events) replies.push(await replyOf(event))
  assert.deepEqual(replies.flatMap(textsOf), ['答覆0', '答覆1', '答覆2'])
  assert.ok(replies[0].at < replies[1].at && replies[1].at < replies[2].at)
  assert.equal(requests().length, 3)
  assert.equal(ollama.state.maxActive, 1)
  assert.deepEqual(sentTo(2).slice(1), ['連發第一則', '答覆0', '連發第二則', '答覆1', '連發第三則'])
})

test('4. 圖片辨識：依實際格式送給模型，追問時圖片只跟著三輪', async () => {
  await fresh()
  const user = newUser()
  const reply = await replyOf(await send(imageEvent(user, IMAGES.png, 'image/png')))
  assert.deepEqual(textsOf(reply), ['答覆0'])
  const content = requests()[0].body.messages[1].content
  assert.equal(content[0].type, 'image_url')
  assert.ok(content[0].image_url.url.startsWith('data:image/png;base64,'), '標示成實際的格式 PNG')
  assert.deepEqual(content[1], { type: 'text', text: '請描述這張圖片的內容。' })

  // 追問：圖片跟著前三次追問一起送，第四次起換成文字佔位，不再重送
  for (let i = 1; i <= 4; i++) await replyOf(await say(user, `圖片追問第${i}次`))
  assert.deepEqual(
    [1, 2, 3, 4].map((index) => imagesIn(index).length),
    [1, 1, 1, 0],
  )
  assert.ok(sentTo(4).some((text) => text.includes('（先前傳送的圖片已省略）')))
})

test('4b. 圖片：再傳新圖片時不重送舊圖片；JPEG、WEBP、GIF 的標示', async () => {
  await fresh()
  const user = newUser()
  await replyOf(await send(imageEvent(user, IMAGES.jpeg)))
  await replyOf(await send(imageEvent(user, IMAGES.webp, 'image/webp')))
  await replyOf(await send(imageEvent(user, IMAGES.gif, 'image/gif')))
  assert.deepEqual(imagesIn(0), ['data:image/jpeg;base64'])
  assert.deepEqual(imagesIn(1), ['data:image/webp;base64'], '請求裡只有新圖片，舊的已換成佔位文字')
  // Ollama 不收 image/gif 這個標示，但標成 jpeg 它讀得懂（實測），所以 GIF 標成 jpeg
  assert.deepEqual(imagesIn(2), ['data:image/jpeg;base64'])
})

test('4c. 圖片：下載到的不是圖片、下載失敗、檔案太大，都明確回覆且不呼叫模型', async () => {
  await fresh()
  const user = newUser()
  // 內容其實是一段錯誤訊息（以前會被當成圖片送給模型）
  const notImage = await replyOf(
    await send(imageEvent(user, Buffer.from('{"message":"Not found"}'), 'application/json')),
  )
  assert.deepEqual(textsOf(notImage), ['這張圖片的格式我讀不了，請改傳 JPG 或 PNG。'])

  const missing = makeEvent(user, { type: 'image', contentProvider: { type: 'line' } }) // 假 LINE 回 404
  assert.deepEqual(textsOf(await replyOf(await send(missing))), [
    '下載不到這則訊息的內容，可能已經過期或被收回，請再傳一次。',
  ])

  const huge = Buffer.concat([IMAGES.jpeg, Buffer.alloc(11 * 1024 * 1024)])
  assert.deepEqual(textsOf(await replyOf(await send(imageEvent(user, huge)))), [
    '圖片太大了，請傳 10MB 以內的圖片。',
  ])
  assert.equal(requests().length, 0, '三種情況都沒有呼叫模型')
})

test('4d. 圖片沒有處理成功（模型逾時或拒收）：圖片不留在記憶裡，之後的對話不再重送', async () => {
  await fresh()
  const user = newUser()
  const placeholder = '（使用者傳了一張圖片，但沒有處理成功）'
  // 模型一直沒回應，直到期限
  ollama.state.plan.push({ hang: true })
  assert.deepEqual(textsOf(await replyOf(await send(imageEvent(user, IMAGES.jpeg)))), [TOO_SLOW])
  assert.deepEqual(textsOf(await replyOf(await say(user, '圖片逾時之後的下一句'))), ['答覆1'])
  assert.equal(imagesIn(1).length, 0, '逾時的那張圖沒有再送給模型')
  assert.ok(
    sentTo(1).some((item) => item.includes(placeholder)),
    '記憶裡只留一句說明',
  )
  assert.ok(sentTo(1).includes(NO_REPLY))

  // 模型拒收圖片（HTTP 400）
  ollama.state.plan.push({ status: 400 })
  const refused = await replyOf(await send(imageEvent(user, IMAGES.png, 'image/png')))
  assert.deepEqual(textsOf(refused), ['這張圖片模型讀不了，請換一張，或改傳 JPG、PNG。'])
  assert.deepEqual(textsOf(await replyOf(await say(user, '圖片被拒收之後的下一句'))), ['答覆3'])
  assert.equal(imagesIn(3).length, 0, '被拒收的那張圖也沒有留在記憶裡')
  assert.equal(sentTo(3).filter((item) => item.includes(placeholder)).length, 2)
})

test('5. 語音訊息：明確回覆不支援，不下載也不呼叫模型', async () => {
  await fresh()
  const user = newUser()
  const event = makeEvent(user, {
    type: 'audio',
    duration: 3000,
    contentProvider: { type: 'line' },
  })
  const reply = await replyOf(await send(event))
  assert.deepEqual(textsOf(reply), ['目前還不支援語音訊息，請改用文字或圖片。'])
  assert.equal(line.state.downloads.length, 0)
  assert.equal(requests().length, 0)

  // 「逐字稿」指令也直接說明還不支援
  assert.deepEqual(textsOf(await replyOf(await say(user, '逐字稿'))), [TASKS.逐字稿.unavailable])
  assert.equal(requests().length, 0)
})

test('6. PDF：明確回覆不支援；文字檔照常摘要，太長的只讀前 5,000 字並告知', async () => {
  await fresh()
  const user = newUser()
  const pdf = await replyOf(await send(fileEvent(user, '報告.pdf', '%PDF-1.7 fake')))
  assert.match(textsOf(pdf)[0], /^目前還不支援 PDF。/)
  assert.equal(line.state.downloads.length, 0, 'PDF 不下載')
  assert.equal(requests().length, 0, 'PDF 不呼叫模型')

  const other = await replyOf(await send(fileEvent(user, '壓縮檔.zip', 'PK')))
  assert.match(textsOf(other)[0], /^目前只能讀文字檔/)

  const short = await replyOf(await send(fileEvent(user, '筆記.txt', '這是文字檔的內容，共三行。')))
  assert.deepEqual(textsOf(short), ['答覆0'])
  assert.equal(
    requests()[0].body.messages[1].content[0].text,
    '檔案「筆記.txt」的內容：\n\n這是文字檔的內容，共三行。',
  )
  assert.equal(requests()[0].body.messages[1].content[1].text, TASKS.摘要.build())

  const long = await replyOf(await send(fileEvent(user, '長文.md', '字'.repeat(25000))))
  assert.equal(textsOf(long)[0], '答覆1\n\n（這個檔案共 25,000 字，這次只讀了前 5,000 字。）')
  const sent = requests()[1].body.messages.at(-1).content[0].text
  assert.ok(sent.startsWith('檔案「長文.md」的內容（檔案太長，以下只有前 5,000 字）：\n\n'))
  assert.equal(sent.split('：\n\n')[1].length, 5000, '只送出前 5,000 字')
})

test('6c. 連續傳長檔案：記憶太長時從最舊的開始捨棄，不會把前一個長檔一起送給模型', async () => {
  await fresh()
  const user = newUser()
  const first = '甲'.repeat(4000)
  const second = '乙'.repeat(4000)
  await replyOf(await send(fileEvent(user, '第一份.txt', first)))
  await replyOf(await say(user, '針對第一份檔案的追問'))
  assert.ok(
    sentTo(1).some((text) => text.includes(first)),
    '追問時，檔案內容還在記憶裡',
  )

  // 再傳一個長檔：兩個加起來超過上限，第一個檔案被捨棄
  await replyOf(await send(fileEvent(user, '第二份.txt', second)))
  const sent = sentTo(2)
  assert.ok(sent.some((text) => text.includes(second)))
  assert.ok(!sent.some((text) => text.includes('甲甲甲')), '第一個長檔沒有再送給模型')
  assert.ok(sent.slice(1).join('').length <= 6000, '記憶加上這次的訊息不超過上限（6,000 字）')
  assert.equal(requests()[2].body.messages[1].role, 'user', '留下來的記憶從使用者的訊息開始')

  await replyOf(await say(user, '針對第二份檔案的追問'))
  assert.ok(
    sentTo(3).some((text) => text.includes(second)),
    '第二個檔案仍然可以追問',
  )
})

test('6b. 說明文字不再宣稱支援語音和 PDF', () => {
  assert.ok(!HELP_TEXT.includes('語音訊息會轉成文字'))
  assert.ok(!HELP_TEXT.includes('傳 PDF'))
  assert.ok(HELP_TEXT.includes('目前還不支援語音訊息和 PDF'))
})

test('7. 清除一般對話記憶', async () => {
  await fresh()
  const user = newUser()
  await replyOf(await say(user, '清除前說的話'))
  assert.deepEqual(textsOf(await replyOf(await say(user, '清除'))), ['已清除之前的對話記憶。'])
  await replyOf(await say(user, '清除後說的話'))
  assert.deepEqual(sentTo(1).slice(1), ['清除後說的話'], '清除後模型看不到之前的對話')
})

test('8. 聚會中清除記憶：只清聚會的聊天紀錄，一般對話的記憶不動', async () => {
  await fresh()
  const user = newUser()
  await replyOf(await say(user, '聚會前的一般對話'))
  await startParty(user)
  await replyOf(await say(user, '聚會裡的第一句話'))
  assert.equal(requests().length, 4)

  const cleared = await replyOf(await say(user, '清除'))
  assert.match(textsOf(cleared)[0], /已清除這場聚會的聊天紀錄/)
  assert.deepEqual(
    cleared.messages[0].quickReply.items.map((item) => item.action.label),
    ['結束聚會'],
    '還在聚會中',
  )

  await replyOf(await say(user, '聚會裡的第二句話'))
  assert.ok(promptOf(4).includes('（聚會剛開始，還沒有紀錄）'), '聚會紀錄已清空')
  assert.ok(!promptOf(4).includes('聚會裡的第一句話'))

  assert.deepEqual(textsOf(await replyOf(await say(user, '結束聚會'))), ['聚會結束，大家下次見！'])
  await replyOf(await say(user, '聚會後的一般對話'))
  assert.deepEqual(sentTo(7).slice(1), ['聚會前的一般對話', '答覆0', '聚會後的一般對話'])
})

test('9. 聚會中快速連續傳送訊息：合併成一輪，不會每一則都啟動三人討論', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  ollama.state.delay = 150
  const burst = []
  for (const text of ['連發甲一', '連發甲二', '連發甲三']) burst.push(await say(user, text))
  const reply = await replyOf(burst[2])
  assert.equal(reply.messages.length, 3, '一輪三位成員')
  assert.equal(requests().length, 3, '三則訊息只用了三次呼叫（一輪），不是九次')
  assert.ok(promptOf(0).includes('使用者最新訊息：\n我：連發甲一\n我：連發甲二\n我：連發甲三'))
  assert.equal(line.replyTo(burst[0]), undefined, '用最新那一則的回覆權杖回覆一次')
  assert.equal(line.replyTo(burst[1]), undefined)

  // 上一輪還在生成時傳來的訊息，累積成下一輪的輸入
  ollama.state.delay = 400
  const fourth = await say(user, '連發甲四')
  await waitFor(() => requests().length === 4, { label: '第二輪開始生成' })
  const fifth = await say(user, '連發甲五')
  const sixth = await say(user, '連發甲六')
  assert.equal((await replyOf(fourth)).messages.length, 3)
  assert.equal((await replyOf(sixth)).messages.length, 3)
  assert.equal(line.replyTo(fifth), undefined)
  assert.equal(requests().length, 9, '六則訊息總共三輪')

  // 聊天紀錄裡，使用者的每一句話都在，而且只出現一次
  const prompt = promptOf(6)
  const history = prompt.slice(0, prompt.indexOf('目前的話題焦點'))
  for (const text of ['連發甲一', '連發甲二', '連發甲三', '連發甲四']) {
    assert.equal(history.split(`我：${text}`).length - 1, 1, `「${text}」在紀錄裡出現一次`)
  }
  assert.ok(prompt.includes('使用者最新訊息：\n我：連發甲五\n我：連發甲六'))
})

test('10. 第一位 AI 逾時：重試一次，重試不佔發言名額，後面兩位照常發言', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  ollama.state.plan.push({ hang: true }) // 第一次呼叫沒有回應
  const event = await say(user, '第一位會逾時的那一輪')
  const reply = await replyOf(event)
  assert.equal(reply.messages.length, 3, '重試成功後，三位都有發言')
  assert.ok(reply.at - event.sentAt < 6000, '在回覆期限內送出')
  assert.equal(requests()[0].aborted, true, '逾時的請求被中斷，不會繼續佔用模型')
  const turn = party.getLastTurn(user)
  assert.deepEqual(
    { calls: turn.calls, retries: turn.retries, timeouts: turn.timeouts, speakers: turn.speakers },
    { calls: 4, retries: 1, timeouts: 1, speakers: 3 },
  )
  assert.ok(turn.log[0].ms >= 1400 && turn.log[0].ms < 2000, '第一次在單次上限 1.5 秒左右逾時')
  assert.equal(turn.log[1].retry, true)
})

test('10b. 第一位連續兩次逾時：這一輪失敗，但使用者說的話留在紀錄裡', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  ollama.state.plan.push({ hang: true }, { hang: true })
  const event = await say(user, '兩次都逾時的那一輪')
  const reply = await replyOf(event)
  assert.deepEqual(textsOf(reply), [TOO_SLOW])
  assert.ok(reply.at - event.sentAt < 6000)
  assert.deepEqual(
    reply.messages[0].quickReply.items.map((item) => item.action.label),
    ['結束聚會'],
  )
  const turn = party.getLastTurn(user)
  assert.deepEqual(
    { calls: turn.calls, retries: turn.retries, timeouts: turn.timeouts, speakers: turn.speakers },
    { calls: 2, retries: 1, timeouts: 2, speakers: 0 },
    '最多只重試一次',
  )
  await replyOf(await say(user, '接著說的下一句'))
  assert.ok(promptOf(2).includes('我：兩次都逾時的那一輪'), '失敗那一輪使用者說的話沒有遺失')
})

test('10c. 時間吃緊時，第一位會提早被中斷，把時間留給後面兩位', async () => {
  await fresh()
  const [other, user] = [newUser(), newUser()]
  await startParty(user)
  // 別人的請求先把模型佔住 3 秒；輪到聚會的第一位時，整輪只剩 2.5 秒左右
  ollama.state.plan.push({ delay: 3000 }, { delay: 1400 })
  await say(other, '先把模型佔住三秒的問題')
  await waitFor(() => requests().length === 1)
  const event = await say(user, '排隊排很久才輪到的那一輪')
  const reply = await replyOf(event)
  assert.equal(reply.messages.length, 3, '三位都來得及發言')
  assert.ok(reply.at - event.sentAt < 6000)
  const turn = party.getLastTurn(user)
  // 第一位本來可以用 1.5 秒，但要替後面兩位各留 0.7 秒，所以大約 1.1 秒就被中斷並重試
  assert.ok(turn.log[0].waitMs > 2000, `排隊等了 ${turn.log[0].waitMs}ms，這段時間算在整輪期限裡`)
  assert.ok(turn.log[0].ms >= 800 && turn.log[0].ms < 1350, `第一位用了 ${turn.log[0].ms}ms`)
  assert.deepEqual([turn.timeouts, turn.retries, turn.speakers], [1, 1, 3])
})

test('10d. 排隊排到保留時間都用完：第一位改用整輪剩下的時間，至少讓對話有回應', async () => {
  await fresh()
  const [other, user] = [newUser(), newUser()]
  await startParty(user)
  ollama.state.plan.push({ delay: 4200 }) // 別人的請求把模型佔住 4.2 秒
  await say(other, '先把模型佔住四秒多的問題')
  await waitFor(() => requests().length === 1)
  const event = await say(user, '幾乎排到期限才輪到的那一輪')
  const reply = await replyOf(event)
  assert.ok(reply.messages.length >= 1 && reply.messages[0].sender, '至少有一位成員回應')
  assert.ok(reply.at - event.sentAt < 6000)
  const turn = party.getLastTurn(user)
  assert.deepEqual(
    [turn.log[0].reason, turn.log[0].ms],
    ['deadline', 0],
    '第一次排隊等到保留時間用完，沒有用到模型',
  )
  assert.equal(turn.calls, turn.log.length - 1, '沒用到模型的那一次不算呼叫，也不算重試')
  assert.equal(turn.retries, 0)
})

test('11. 第二位 AI 生成失敗：暫時性錯誤重試一次；不是暫時性的就不重試，保留已產生的訊息', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)

  // (a) 第二位遇到伺服器錯誤 → 重試成功 → 三位都發言
  ollama.state.plan.push({}, { status: 500 })
  assert.equal((await replyOf(await say(user, '第二位先失敗再成功'))).messages.length, 3)
  let turn = party.getLastTurn(user)
  assert.deepEqual([turn.calls, turn.retries, turn.speakers], [4, 1, 3])
  assert.equal(turn.log[1].reason, 'server')

  // (b) 第二位兩次都輸出無法解析的內容 → 只送出第一位的訊息
  ollama.state.plan.push({}, { text: '這不是 JSON' }, { text: '這也不是 JSON' })
  assert.equal((await replyOf(await say(user, '第二位一直輸出壞掉的內容'))).messages.length, 1)
  turn = party.getLastTurn(user)
  assert.deepEqual([turn.calls, turn.retries, turn.speakers], [3, 1, 1])
  assert.equal(turn.reason, '生成失敗（invalid）')

  // (c) 第二位遇到 400（請求本身有問題，不是暫時性的）→ 不重試
  ollama.state.plan.push({}, { status: 400 })
  assert.equal((await replyOf(await say(user, '第二位遇到不是暫時性的錯誤'))).messages.length, 1)
  turn = party.getLastTurn(user)
  assert.deepEqual([turn.calls, turn.retries, turn.speakers], [2, 0, 1])
  assert.equal(turn.reason, '生成失敗（request）')

  // (d) 整輪只有一次重試機會：第一位已經用掉，第二位再失敗就不重試了
  ollama.state.plan.push({ status: 500 }, {}, { status: 500 })
  assert.equal(
    (await replyOf(await say(user, '第一位和第二位都遇到暫時性錯誤'))).messages.length,
    1,
  )
  turn = party.getLastTurn(user)
  assert.deepEqual([turn.calls, turn.retries, turn.speakers], [3, 1, 1], '一輪最多呼叫 3 + 1 次')
})

test('12. 三位角色正常串行生成：後面的人看得到前面的發言，第二位從剩下兩位裡選', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  const reply = await replyOf(await say(user, '週末有什麼推薦的活動呢'))
  assert.equal(requests().length, 3)
  assert.deepEqual(
    reply.messages.map((message) => message.sender.name),
    ['阿哲', '小雯', 'Kevin'],
  )
  for (const message of reply.messages) {
    assert.match(message.sender.iconUrl, /^https:\/\/.+\.png$/)
  }
  const [first, second] = textsOf(reply)
  // 選角：第一位從三位候選人裡選，第二位從剩下兩位裡選，第三位就是剩下那一位
  assert.deepEqual(enumOf(0, 'speaker'), ['阿哲', '小雯', 'Kevin'])
  assert.deepEqual(enumOf(1, 'speaker'), ['小雯', 'Kevin'])
  assert.equal(enumOf(2, 'speaker'), undefined)
  // 承接：第二位的提示詞裡有第一位說的話，第三位有前兩位說的話
  assert.ok(promptOf(1).includes(`這一輪已經發言（依序）：\n阿哲：${first}`))
  assert.ok(promptOf(2).includes(`阿哲：${first}\n小雯：${second}`))
  assert.ok(promptOf(0).includes('這一輪還沒有人發言。'))

  // 下一輪換另外三位（剛說過話的排到後面）
  const next = await replyOf(await say(user, '那如果下雨怎麼辦呢'))
  assert.deepEqual(enumOf(3, 'speaker'), ['美玲姐', '小宇', '艾莉'])
  assert.equal(next.messages.length, 3)
  assert.ok(promptOf(3).includes(`阿哲：${first}`), '下一輪看得到上一輪的聊天紀錄')
})

test('12b. 聚會：被點名的成員一定會回，而且優先發言', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  await replyOf(await say(user, '先聊一輪讓大家輪替')) // 阿哲、小雯、Kevin 說完排到後面
  const reply = await replyOf(await say(user, 'Kevin 你覺得這樣可行嗎'))
  assert.deepEqual(enumOf(3, 'speaker'), ['Kevin'], '第一位只能是被點名的 Kevin')
  assert.equal(reply.messages[0].sender.name, 'Kevin')
  assert.deepEqual(enumOf(4, 'speaker'), ['美玲姐', '小宇'], '其餘照最久沒發言的順序')

  await replyOf(await say(user, '我的小宇宙要爆發了啦'))
  assert.equal(enumOf(6, 'speaker').length, 3, '「小宇宙」不算點到小宇')
  await replyOf(await say(user, '美玲姐跟艾莉怎麼看這件事'))
  assert.deepEqual(enumOf(9, 'speaker'), ['美玲姐', '艾莉'], '點到兩位時，第一位從這兩位裡選')
  assert.equal(enumOf(10, 'speaker'), undefined, '第二位就是另一位被點名的人')
  assert.ok(promptOf(10).includes('你是艾莉'))
})

test('12c. 聚會：發言人數、提前收尾、重複發言、提問上限都由程式把關', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)

  // 道謝、道別這類訊息最多兩個人接話
  assert.equal((await replyOf(await say(user, '謝謝大家'))).messages.length, 2)
  assert.equal(party.getLastTurn(user).planned, 2)
  assert.equal(requests().length, 2)

  // AI 判斷可以收尾（wrap_up）時提前結束，不硬湊三個人
  ollama.state.plan.push({ result: { wrap_up: true } })
  assert.equal((await replyOf(await say(user, '這個話題聊到這裡就夠了吧各位'))).messages.length, 1)
  assert.equal(party.getLastTurn(user).reason, '提前收尾')

  // 第二位說的話和第一位幾乎一樣 → 捨棄，換下一位
  ollama.state.plan.push(
    { result: { text: '夜市的雞排真的是人間美味' } },
    { result: { text: '夜市的雞排真的是人間美味！' } },
  )
  const deduped = await replyOf(await say(user, '大家週末通常都在做什麼事情'))
  assert.equal(deduped.messages.length, 2)
  assert.equal(party.getLastTurn(user).dropped, 1)
  assert.equal(new Set(deduped.messages.map((message) => message.sender.name)).size, 2)

  // 一輪最多一個人問使用者問題：前面有人問過，後面的人結尾的問句會被拿掉
  ollama.state.plan.push(
    { result: { text: '走啊去打球！你平常有在運動嗎？' } },
    { result: { text: '陽明山的公車很好搭。你會暈車嗎？' } },
    { result: { text: '太熱了吧。阿哲你不怕中暑嗎？' } },
  )
  const asked = textsOf(await replyOf(await say(user, '我想找個地方走走散散心')))
  assert.deepEqual(asked, [
    '走啊去打球！你平常有在運動嗎？',
    '陽明山的公車很好搭。',
    '太熱了吧。阿哲你不怕中暑嗎？', // 問的是其他成員，不是使用者，保留
  ])
  const base = requests().length
  assert.ok(promptOf(base - 2).includes('這一輪已經有人提問了'))

  // 上一輪問過了，這一輪第一位就不再問
  ollama.state.plan.push({ result: { text: '跑步不錯啊，膝蓋要顧好。你都跑幾公里？' } })
  const followUp = textsOf(await replyOf(await say(user, '我偶爾會去河堤跑跑步')))
  assert.equal(followUp[0], '跑步不錯啊，膝蓋要顧好。')
  assert.ok(promptOf(base).includes('這次不要問使用者問題'))
})

test('12d. 聚會 single 模式（一次呼叫產生三人的話）仍然可用', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  process.env.PARTY_MODE = 'single'
  try {
    ollama.state.plan.push({
      result: [
        { name: '阿哲', text: '走啊去運動' },
        { name: '小雯', text: '那個…我可以嗎' },
        { name: 'Kevin', text: '先看行事曆。' },
      ],
    })
    const reply = await replyOf(await say(user, '單次模式的這一輪'))
    assert.deepEqual(textsOf(reply), ['走啊去運動', '那個…我可以嗎', '先看行事曆。'])
    assert.equal(requests().length, 1)
    assert.equal(party.getLastTurn(user).mode, 'single')
  } finally {
    process.env.PARTY_MODE = 'sequential'
  }
})

test('12e. 聚會：很短的反應（像「哈哈哈」）本來就容易一樣，不會被當成重複發言丟掉', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  ollama.state.plan.push(
    { result: { text: '哈哈哈哈' } },
    { result: { text: '哈哈哈' } },
    { result: { text: '笑死。' } },
  )
  const reply = await replyOf(await say(user, '我剛剛在捷運上睡過站了'))
  assert.deepEqual(textsOf(reply), ['哈哈哈哈', '哈哈哈', '笑死。'])
  assert.equal(party.getLastTurn(user).dropped, 0)
})

test('13. Ollama 暫時無法連線：明確告知，使用者的訊息不遺失，恢復後照常運作', async () => {
  await fresh()
  const user = newUser()
  const partyUser = newUser()
  await startParty(partyUser)
  await ollama.stop() // Ollama 關掉了

  assert.deepEqual(textsOf(await replyOf(await say(user, '我叫阿明請記住我'))), [
    '現在連不上 AI 模型，請稍後再試。',
  ])
  assert.deepEqual(textsOf(await replyOf(await say(partyUser, '聚會中連不上的那句話'))), [
    '現在連不上 AI 模型，請稍後再試。',
  ])
  assert.ok(logs.some((item) => item.includes('失敗：unreachable')))

  await ollama.start() // Ollama 回來了
  assert.deepEqual(textsOf(await replyOf(await say(user, '我叫什麼名字來著'))), ['答覆0'])
  assert.deepEqual(sentTo(0).slice(1), ['我叫阿明請記住我', NO_REPLY, '我叫什麼名字來著'])

  assert.equal((await replyOf(await say(partyUser, '恢復之後的下一句'))).messages.length, 3)
  const prompt = promptOf(1)
  assert.equal(
    prompt.split('我：聚會中連不上的那句話').length - 1,
    1,
    '聚會紀錄裡有那句話，且只有一次',
  )
})

test('14. 同一使用者與不同使用者同時發送：各自排隊、模型一次一個、記憶互不干擾', async () => {
  await fresh()
  ollama.state.delay = 300
  const [a, b, c] = [newUser(), newUser(), newUser()]
  const events = [
    textEvent(a, '甲的第一則'),
    textEvent(a, '甲的第二則'),
    textEvent(b, '乙的第一則'),
    textEvent(c, '丙的第一則'),
  ]
  await sendWebhook(port, events)
  const replies = []
  for (const event of events) replies.push(await replyOf(event))
  assert.equal(ollama.state.maxActive, 1, '模型一次只處理一個請求')
  // 先到先服務：甲的第二則要等第一則做完才排隊，所以乙、丙不會被甲的兩則訊息擋在後面
  assert.deepEqual(
    requests().map((_, index) => sentTo(index).at(-1)),
    ['甲的第一則', '乙的第一則', '丙的第一則', '甲的第二則'],
  )
  assert.ok(replies[2].at < replies[1].at, '乙比甲的第二則先得到回覆')
  // 記憶各自獨立
  assert.deepEqual(sentTo(1).slice(1), ['乙的第一則'])
  assert.deepEqual(sentTo(2).slice(1), ['丙的第一則'])
  assert.deepEqual(sentTo(3).slice(1), ['甲的第一則', '答覆0', '甲的第二則'])
})

test('15. LINE 回覆失敗：會被發現並記錄原因，沒送達的回答不留在記憶裡', async () => {
  await fresh()
  const user = newUser()
  line.state.replyMode = 'invalid_token' // 回覆權杖過期或已用過
  const failed = await replyOf(await say(user, '這則的回覆會失敗'))
  assert.equal(failed.delivered, false)
  await waitFor(() =>
    logs.some((item) => /回覆失敗｜reply_token｜HTTP 400｜Invalid reply token/.test(item)),
  )
  assert.equal(line.state.replies.length, 1, '沒有重複嘗試，也沒有改用推播')

  line.state.replyMode = 'ok'
  await replyOf(await say(user, '失敗之後的下一則'))
  assert.deepEqual(sentTo(1).slice(1), ['這則的回覆會失敗', NO_REPLY, '失敗之後的下一則'])

  line.state.replyMode = 'error500'
  await replyOf(await say(user, '伺服器錯誤的那一則'))
  await waitFor(() => logs.some((item) => /回覆失敗｜line_server｜HTTP 500/.test(item)))

  line.state.replyMode = 'bad_request'
  await replyOf(await say(user, '格式錯誤的那一則'))
  await waitFor(() =>
    logs.some((item) =>
      /回覆失敗｜bad_request｜HTTP 400｜.*messages\[0\]\.text May not be empty/.test(item),
    ),
  )
})

test('15b. LINE 回覆逾時：不會卡住後面的訊息', async () => {
  await fresh()
  const user = newUser()
  line.state.replyMode = 'hang' // LINE 一直不回應
  const stuck = await say(user, '回覆卡住的那一則')
  await replyOf(stuck)
  const next = textEvent(user, '排在後面的那一則')
  await sleep(100)
  line.state.replyMode = 'ok'
  await send(next)
  const reply = await replyOf(next)
  assert.equal(reply.delivered, true)
  assert.ok(reply.at - stuck.sentAt < 3000, '等了 1 秒的逾時上限後就繼續處理下一則')
  assert.ok(logs.some((item) => /回覆失敗｜timeout｜HTTP 0/.test(item)))
})

test('15c. 聚會的回覆沒送達：成員的發言不寫進聊天紀錄，輪替順序也不變', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  line.state.replyMode = 'invalid_token'
  const failed = await replyOf(await say(user, '這一輪的回覆送不出去'))
  assert.equal(failed.delivered, false)
  assert.equal(failed.messages.length, 3)
  const lost = textsOf(failed)

  line.state.replyMode = 'ok'
  await replyOf(await say(user, '送不出去之後的下一輪'))
  const prompt = promptOf(3)
  assert.ok(prompt.includes('我：這一輪的回覆送不出去'), '使用者說的話有留下來')
  for (const text of lost) assert.ok(!prompt.includes(text), '沒送達的成員發言不在紀錄裡')
  assert.deepEqual(enumOf(3, 'speaker'), ['阿哲', '小雯', 'Kevin'], '沒送達的人不算說過話')
})

test('16. 聚會取消：生成到一半說「結束聚會」，那一輪立刻停止，之後不再發言', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  ollama.state.delay = 600
  const talking = await say(user, '這一輪講到一半會被打斷')
  await waitFor(() => requests().length === 1, { label: '第一位開始生成' })
  const end = await say(user, '結束聚會')
  const reply = await replyOf(end)
  assert.deepEqual(textsOf(reply), ['聚會結束，大家下次見！'])
  assert.ok(reply.at - end.sentAt < 500, '不必等那一輪跑完，立刻結束')
  await waitFor(() => requests()[0].aborted, { label: '進行中的生成被中斷' })

  await sleep(1500) // 等超過原本三位發言所需的時間
  assert.equal(requests().length, 1, '沒有再啟動第二、第三位')
  assert.equal(line.replyTo(talking), undefined, '被打斷的那一輪沒有送出任何訊息')
  assert.equal(line.state.replies.length, 2, '只有「聚會開始」和「聚會結束」兩則回覆')
  assert.equal(party.isInParty(user), false)
})

test('16b. 聚會取消：結束之前排隊中的聚會訊息不再處理，之後的訊息回到一般對話', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  ollama.state.delay = 600
  const first = await say(user, '正在生成的那一輪')
  await waitFor(() => requests().length === 1)
  const queued = await say(user, '排隊中還沒處理的那一則')
  const end = await say(user, '結束聚會')
  assert.deepEqual(textsOf(await replyOf(end)), ['聚會結束，大家下次見！'])
  await sleep(1200)
  assert.equal(requests().length, 1, '排隊中的那一則沒有啟動新的一輪')
  assert.equal(line.replyTo(first), undefined)
  assert.equal(line.replyTo(queued), undefined)
  assert.ok(logs.some((item) => item.includes('使用者已經結束聚會，略過 1 則訊息')))

  ollama.state.delay = 0
  const chat = await replyOf(await say(user, '聚會結束後的一般訊息'))
  assert.equal(chat.messages.length, 1)
  assert.equal(requests()[1].body.response_format, undefined, '走一般對話，不是聚會')
  assert.deepEqual(sentTo(1).slice(1), ['聚會結束後的一般訊息'], '聚會裡說的話不會混進一般對話')

  // 結束後可以重新開一場
  await startParty(user)
  assert.equal((await replyOf(await say(user, '新的一場聚會'))).messages.length, 3)
  assert.ok(promptOf(2).includes('（聚會剛開始，還沒有紀錄）'))
})

test('16c. 聚會取消：就算已經生成完，送出前發現聚會結束或重開，也不發言、不寫入紀錄', async () => {
  await fresh()
  const user = newUser()
  party.startParty(user)
  const turn = await party.partyReply(user, '生成完才發現聚會沒了')
  assert.equal(turn.messages.length, 3)
  assert.equal(party.isPartyTurnActive(user, turn), true)

  party.interruptParty(user) // 使用者說了「結束聚會」
  assert.equal(party.isPartyTurnActive(user, turn), false, '送出前的檢查會擋下來')
  assert.equal(party.finishPartyTurn(user, turn, true), false, '作廢的輪次不寫入紀錄')
  assert.equal(await party.partyReply(user, '結束後又想發言'), null, '已結束的聚會不再生成')
  assert.equal(requests().length, 3, '沒有為已結束的聚會呼叫模型')
  party.endParty(user)

  // 重新開一場時，上一場還沒寫入的那一輪不能混進新的一場
  party.startParty(user)
  const stale = await party.partyReply(user, '舊的一場最後一輪')
  party.startParty(user)
  assert.equal(party.finishPartyTurn(user, stale, true), false)
  const fresh2 = await party.partyReply(user, '新的一場第一輪')
  assert.ok(promptOf(6).includes('（聚會剛開始，還沒有紀錄）'))
  assert.equal(party.finishPartyTurn(user, fresh2, true), true)
  assert.equal(party.finishPartyTurn(user, fresh2, true), false, '同一輪不會寫入兩次')
  party.endParty(user)
})

test('17. 模型冷啟動（聚會）：第一位等模型載入，不受單次上限限制，之後照常', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  ollama.state.loaded = false // 模型不在記憶體裡
  ollama.state.plan.push({ delay: 3000 }) // 第一次呼叫要等 3 秒（超過單次上限 1.5 秒）
  const event = await say(user, '冷啟動時的第一輪')
  const reply = await replyOf(event)
  assert.equal(reply.messages.length, 3)
  assert.ok(reply.at - event.sentAt < 6000, '仍然在回覆期限內')
  let turn = party.getLastTurn(user)
  assert.deepEqual([turn.cold, turn.timeouts, turn.retries, turn.calls], [true, 0, 0, 3])
  assert.ok(logs.some((item) => item.includes('模型冷啟動')))

  // 對照：模型已載入時，同樣慢的第一次呼叫會在 1.5 秒被中斷並重試
  ollama.state.loaded = true
  ollama.state.plan.push({ delay: 3000 })
  assert.equal((await replyOf(await say(user, '模型已載入時的慢回應'))).messages.length, 3)
  turn = party.getLastTurn(user)
  assert.deepEqual([turn.cold, turn.timeouts, turn.retries, turn.calls], [false, 1, 1, 4])
})

test('17c. 第一位用掉大部分時間後：不夠替兩位都留時間，就少一位，而不是全部不說', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  ollama.state.loaded = false
  // 第一位要 4.3 秒才回應（加上合併等待，已經是收到訊息後 4.6 秒；生成期限是 5.5 秒）。
  // 剩下的 0.9 秒不夠「替第三位留 0.7 秒之後再讓第二位說」，但夠第二位自己說（0.65 秒）
  ollama.state.plan.push({ delay: 4300 }, { delay: 650 })
  const event = await say(user, '第一位很慢的那一輪')
  const reply = await replyOf(event)
  assert.equal(reply.messages.length, 2, '第一、第二位有發言，第三位來不及就不說了')
  assert.ok(reply.at - event.sentAt < 6000, '仍然在回覆期限內送出')
  const turn = party.getLastTurn(user)
  assert.equal(turn.reason, '時間不夠')
  assert.equal(turn.calls, 2, '時間不夠的第三位沒有呼叫模型')
})

test('17b. 模型冷啟動太久：在期限前放棄並告知使用者，不會拖到回覆權杖失效', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  ollama.state.loaded = false
  ollama.state.plan.push({ delay: 9000 })
  const event = await say(user, '載入太久的那一輪')
  const reply = await replyOf(event)
  assert.deepEqual(textsOf(reply), [TOO_SLOW])
  const elapsed = reply.at - event.sentAt
  assert.ok(
    elapsed >= 5400 && elapsed < 6000,
    `在生成期限（5.5 秒）到了之後、回覆期限（6 秒）之前送出，實際 ${elapsed}ms`,
  )
  assert.equal(party.getLastTurn(user).calls, 1, '時間用完就不再重試')

  // 一般對話也一樣：慢但來得及的照常回，來不及的在期限前告知，訊息留在記憶裡
  const chatter = newUser()
  ollama.state.plan.push({ delay: 4000 })
  const slow = await say(chatter, '慢但來得及的問題')
  assert.deepEqual(textsOf(await replyOf(slow)), ['答覆1'])
  ollama.state.plan.push({ delay: 9000 })
  const tooSlow = await say(chatter, '來不及回答的問題')
  const late = await replyOf(tooSlow)
  assert.deepEqual(textsOf(late), [TOO_SLOW])
  assert.ok(late.at - tooSlow.sentAt < 6000)
  await replyOf(await say(chatter, '再問一次'))
  assert.deepEqual(sentTo(3).slice(1), [
    '慢但來得及的問題',
    '答覆1',
    '來不及回答的問題',
    NO_REPLY,
    '再問一次',
  ])
})

test('18. 重複的 webhook：同一個事件只處理一次', async () => {
  await fresh()
  const user = newUser()
  const event = textEvent(user, '這則事件會送來兩次')
  spoken.add(event.message.text)
  await sendWebhook(port, event)
  await sendWebhook(port, event)
  await replyOf(event)
  await sleep(300)
  assert.equal(requests().length, 1, '只呼叫一次模型')
  assert.equal(line.state.replies.length, 1, '只回覆一次')
  assert.ok(logs.some((item) => item.includes('收到重複的事件，略過')))

  // 重新送達、但發生不到 20 分鐘的事件（之前沒收到過）照常處理
  const redelivered = await say(user, '重新送達但還來得及的事件', {
    deliveryContext: { isRedelivery: true },
    timestamp: Date.now() - 2 * 60 * 1000,
  })
  assert.equal((await replyOf(redelivered)).delivered, true)
})

test('18b. 重新送達的舊事件（超過 20 分鐘）：不呼叫模型、不嘗試回覆，但訊息留在記憶裡', async () => {
  await fresh()
  const user = newUser()
  await say(user, '半小時前的舊訊息', {
    deliveryContext: { isRedelivery: true },
    timestamp: Date.now() - 30 * 60 * 1000,
  })
  await waitFor(() =>
    logs.some((item) => item.includes('這是重新送達的舊事件，回覆權杖已經不能用')),
  )
  assert.equal(requests().length, 0, '已經過期的任務不會用到模型')
  assert.equal(line.state.replies.length, 0)
  await replyOf(await say(user, '現在才傳的新訊息'))
  assert.deepEqual(sentTo(0).slice(1), ['半小時前的舊訊息', NO_REPLY, '現在才傳的新訊息'])
})

test('19. 排隊等模型等到來不及的請求：輪到之前就取消，不佔用模型', async () => {
  await fresh()
  const [a, b] = [newUser(), newUser()]
  ollama.state.plan.push({ hang: true }) // 甲的請求把模型佔到期限為止
  const first = await say(a, '甲把模型佔住的請求')
  await waitFor(() => requests().length === 1)
  const second = await say(b, '乙排隊等到來不及的請求')
  const late = await replyOf(second)
  assert.deepEqual(textsOf(late), [TOO_SLOW])
  assert.ok(late.at - second.sentAt < 6000, '乙在自己的回覆期限內被告知')
  assert.deepEqual(textsOf(await replyOf(first)), [TOO_SLOW])
  assert.equal(requests().length, 1, '乙的請求從頭到尾沒有送到模型')
  assert.ok(logs.some((item) => item.includes('失敗：deadline（排隊等到來不及了，沒有呼叫模型）')))

  await replyOf(await say(b, '乙之後再問一次'))
  assert.deepEqual(sentTo(1).slice(1), ['乙排隊等到來不及的請求', NO_REPLY, '乙之後再問一次'])
})

test('20. 先選功能再傳圖片：五分鐘內有效（測試縮短為 1 秒），不支援的媒體不會把選擇用掉', async () => {
  await fresh()
  const user = newUser()
  const chosen = await replyOf(await say(user, 'OCR'))
  assert.equal(
    textsOf(chosen)[0],
    '已選擇「OCR」，請傳圖片或文字檔給我（或在指令後面直接輸入文字）。',
  )
  // 中間傳了不支援的語音：選擇還在
  await replyOf(await send(makeEvent(user, { type: 'audio', duration: 1000 })))
  await replyOf(await send(imageEvent(user, IMAGES.jpeg)))
  assert.equal(requests()[0].body.messages.at(-1).content[1].text, TASKS.OCR.build())

  await replyOf(await say(user, 'OCR'))
  await sleep(1300) // 超過有效期限
  await replyOf(await send(imageEvent(user, IMAGES.jpeg)))
  assert.equal(
    requests()[1].body.messages.at(-1).content[1].text,
    '請描述這張圖片的內容。',
    '選擇過期後，圖片回到預設的「描述」',
  )

  // 指令後面直接帶文字照常運作
  await replyOf(await say(user, '翻譯 日文 早安你好'))
  assert.equal(
    requests()[2].body.messages.at(-1).content[0].text,
    `${TASKS.翻譯.build('日文')}\n\n早安你好`,
  )
})

test('21. 原有功能：help、天氣、匯率、新聞、位置、看不懂的訊息、加入好友', async () => {
  await fresh()
  const user = newUser()
  assert.deepEqual(textsOf(await replyOf(await say(user, 'help'))), [HELP_TEXT])
  assert.deepEqual(textsOf(await replyOf(await say(user, '？'))), [HELP_TEXT])

  const flex = async (text) => {
    const reply = await replyOf(await say(user, text))
    assert.equal(reply.messages[0].type, 'flex', `「${text}」回的是卡片`)
    return reply.messages[0]
  }
  await flex('天氣 台北')
  await flex('東京天氣')
  await flex('匯率')
  await flex('匯率 100 美金 日幣')
  await flex('新聞')
  await flex('新聞 人工智慧')
  assert.equal(requests().length, 0, '這些功能都不需要 AI')
  assert.deepEqual(textsOf(await replyOf(await say(user, '新聞 查無此事'))), [
    '找不到「查無此事」的相關新聞。',
  ])
  assert.match(textsOf(await replyOf(await say(user, '天氣')))[0], /^想查哪裡的天氣/)
  assert.match(textsOf(await replyOf(await say(user, '匯率 100 XYZ')))[0], /^不認得貨幣「XYZ」/)

  // 查不到的地名會請 AI 翻成英文再查一次
  await flex('天氣 火星基地')
  assert.equal(requests().length, 1)

  const location = makeEvent(user, {
    type: 'location',
    latitude: 25.03,
    longitude: 121.56,
    title: '我家',
  })
  assert.equal((await replyOf(await send(location))).messages[0].type, 'flex')

  const sticker = makeEvent(user, { type: 'sticker', packageId: '1', stickerId: '1' })
  assert.deepEqual(textsOf(await replyOf(await send(sticker))), [
    '我看不懂這種訊息，請傳文字、圖片、文字檔或位置給我。',
  ])

  const follow = {
    type: 'follow',
    webhookEventId: 'follow-1',
    timestamp: Date.now(),
    source: { type: 'user', userId: user },
    replyToken: 'follow-token-1',
    mode: 'active',
  }
  await sendWebhook(port, follow)
  assert.equal(textsOf(await replyOf(follow))[0], `歡迎加入！\n\n${HELP_TEXT}`)
})

test('21b. 對外查詢逾時：8 秒後放棄並告知，不會一直卡住', async () => {
  await fresh()
  const user = newUser()
  external.hang = true
  const event = await say(user, '匯率 5 歐元 日幣')
  // 匯率有快取（上一個測試查過），所以改用天氣來測逾時
  await replyOf(event)
  const slow = await say(user, '首爾天氣')
  const reply = await replyOf(slow, 12000)
  assert.deepEqual(textsOf(reply), ['查詢資料逾時，請稍後再試。'])
  const elapsed = reply.at - slow.sentAt
  assert.ok(elapsed >= 7900 && elapsed < 9500, `約 8 秒逾時，實際 ${elapsed}ms`)
  external.hang = false
  assert.equal(
    (await replyOf(await say(user, '天氣 台中'))).messages[0].type,
    'flex',
    '之後照常運作',
  )
})

test('22. 群組訊息拿不到個人 ID 時：用群組 ID 區分記憶，不顯示載入動畫', async () => {
  await fresh()
  const group = `C${userId().slice(1)}`
  users.add(group)
  const event = textEvent(null, '群組裡的訊息', { source: { type: 'group', groupId: group } })
  spoken.add(event.message.text)
  assert.deepEqual(textsOf(await replyOf(await send(event))), ['答覆0'])
  await sleep(100)
  assert.equal(line.state.loading.length, 0)
})

test('23. 記憶清理：太久沒互動的對話記憶與聚會會被清掉', async () => {
  await fresh()
  const user = newUser()
  await replyOf(await say(user, '會被清掉的對話'))
  await startParty(user)
  const later = Date.now() + 7 * 60 * 60 * 1000 // 七小時後
  assert.equal(ai.sweepHistories(Date.now()), ai.sweepHistories(Date.now()), '還沒到期的不會被清')
  assert.equal(party.isInParty(user), true)
  assert.equal(ai.sweepHistories(later), 0)
  assert.equal(party.sweepParties(later), 0)
  assert.equal(party.isInParty(user), false)
  await replyOf(await say(user, '清掉之後的新對話'))
  assert.deepEqual(sentTo(1).slice(1), ['清掉之後的新對話'])
})

// ======================================================================
// 第二批修正的專項測試
// ======================================================================
test('25. 快速指令：文字檔摘要還在跑的時候，help、天氣、匯率、新聞、位置訊息都立刻回覆', async () => {
  await fresh()
  const user = newUser()
  ollama.state.plan.push({ hang: true }) // 摘要會跑到期限（測試裡是 5.5 秒）
  const file = await send(fileEvent(user, '摘要很慢的檔案.txt', '這份檔案的內容。'.repeat(300)))
  await waitFor(() => requests().length === 1, { label: '摘要開始' })

  const quick = []
  for (const text of ['help', '天氣 台北', '匯率', '新聞']) {
    const event = await say(user, text)
    quick.push({ text, event, reply: await replyOf(event, 3000) })
  }
  const location = await send(
    makeEvent(user, { type: 'location', latitude: 25.03, longitude: 121.56, title: '我家' }),
  )
  const locationReply = await replyOf(location, 3000)

  for (const { text, event, reply } of quick) {
    assert.ok(reply.at - event.sentAt < 1000, `「${text}」${reply.at - event.sentAt}ms 就回覆`)
    assert.equal(reply.delivered, true)
  }
  assert.deepEqual(textsOf(quick[0].reply), [HELP_TEXT])
  assert.deepEqual(
    quick.slice(1).map((item) => item.reply.messages[0].type),
    ['flex', 'flex', 'flex'],
  )
  assert.equal(locationReply.messages[0].type, 'flex')
  assert.equal(line.replyTo(file), undefined, '這時候摘要還沒有回覆')
  assert.equal(requests().length, 1, '快速指令沒有用到模型')
  // 快速指令的回覆會讓聊天室的載入動畫消失，所以每回一則，就替還在跑的摘要把動畫補回來
  await waitFor(() => line.state.loading.length === 6, { label: '原本 1 次，加上補回的 5 次動畫' })
  assert.ok(
    line.state.loading.every((item) => item.chatId === user && item.loadingSeconds % 5 === 0),
  )

  // 摘要到期限後照常回覆，沒有被快速指令打亂
  assert.deepEqual(textsOf(await replyOf(file)), [TOO_SLOW])
  // 沒有工作在跑的時候，快速指令不會多顯示動畫
  await replyOf(await say(user, 'help'))
  await sleep(100)
  assert.equal(line.state.loading.length, 6)
  // 對話記憶裡沒有被插進任何快速指令
  await replyOf(await say(user, '檔案失敗之後的一般對話'))
  assert.equal(sentTo(1).length, 4, '這次請求只有：系統提示、那個檔案、沒回覆的標記、這一句')
  assert.equal(sentTo(1).at(-1), '檔案失敗之後的一般對話')
})

test('25c. 正在送出回覆的訊息不再補載入動畫（否則動畫會留在回覆之後）', async () => {
  await fresh()
  const user = newUser()
  line.state.replyDelay = 600 // LINE 收到回覆請求後，過 0.6 秒才回應
  const chat = await say(user, '這句的回覆正在送出')
  await waitFor(() => line.replyTo(chat), { label: '回覆請求已經送到 LINE' })
  line.state.replyDelay = 0
  const help = await say(user, 'help') // 這時上一句的回覆還在路上
  assert.equal((await replyOf(help)).delivered, true)
  assert.equal(line.replyTo(chat).delivered, false, '上一句的回覆這時還沒送達')
  await waitFor(() => line.replyTo(chat).delivered, { label: '上一句的回覆送達' })
  await sleep(100)
  assert.equal(line.state.loading.length, 1, '只有原本那一次動畫，沒有在回覆送出後又補一次')
})

test('25b. 快速指令：一般對話和圖片正在處理時也立刻回覆，而且不影響它們的順序與記憶', async () => {
  await fresh()
  const user = newUser()
  ollama.state.delay = 700
  const chat = await say(user, '這句一般對話要等模型回答')
  const image = await send(imageEvent(user, IMAGES.jpeg)) // 排在一般對話後面
  await waitFor(() => requests().length === 1, { label: '一般對話開始生成' })
  const help = await say(user, 'help')
  const rates = await say(user, '匯率')
  const helpReply = await replyOf(help, 2000)
  const ratesReply = await replyOf(rates, 2000)
  assert.equal(line.replyTo(chat), undefined, '一般對話還沒回，快速指令已經回了')
  assert.deepEqual(textsOf(helpReply), [HELP_TEXT])
  assert.equal(ratesReply.messages[0].type, 'flex')

  const chatReply = await replyOf(chat)
  const imageReply = await replyOf(image)
  assert.deepEqual([textsOf(chatReply), textsOf(imageReply)], [['答覆0'], ['答覆1']])
  assert.ok(chatReply.at < imageReply.at, '一般對話和圖片仍然照順序處理')
  assert.equal(requests().length, 2)
  assert.equal(ollama.state.maxActive, 1)
  // 圖片那次請求帶的記憶裡只有前一句對話，沒有 help 或匯率
  assert.deepEqual(sentTo(1).slice(1, 3), ['這句一般對話要等模型回答', '答覆0'])
  assert.equal(sentTo(1).length, 4)
})

test('26. 快速指令不會誤入 AI 或聚會；聚會中的文字照舊交給聚會', async () => {
  await fresh()
  const user = newUser()
  for (const text of ['help', '天氣', '匯率', '新聞']) {
    assert.equal((await replyOf(await say(user, text))).delivered, true)
  }
  assert.equal(requests().length, 0, '不在聚會中：四個指令都不呼叫模型')

  // 看起來像指令但不是（「今天」不是地名）：照舊交給一般對話
  assert.deepEqual(textsOf(await replyOf(await say(user, '今天天氣'))), ['答覆0'])
  assert.equal(requests()[0].body.response_format, undefined)

  // 聚會中：同樣的字是聊天內容，由成員回應
  await startParty(user)
  const inParty = await replyOf(await say(user, 'help'))
  assert.equal(inParty.messages.length, 3)
  assert.ok(inParty.messages.every((message) => message.sender))
  assert.equal(requests().length, 4, '聚會的一輪：三次呼叫')
  assert.deepEqual(textsOf(await replyOf(await say(user, '結束聚會'))), ['聚會結束，大家下次見！'])
  assert.deepEqual(textsOf(await replyOf(await say(user, 'help'))), [HELP_TEXT])
  assert.equal(requests().length, 4)
})

test('26b. 佇列裡還有沒處理的「聚會」或「結束聚會」時，快速指令照處理完之後的狀態分流', async () => {
  await fresh()
  const user = newUser()
  // 一般對話還在跑 → 送「聚會」（排隊中）→ 馬上送 help：輪到 help 時已經在聚會裡，應該交給聚會
  ollama.state.delay = 400
  const chat = await say(user, '先來一句比較慢的一般對話')
  await waitFor(() => requests().length === 1, { label: '一般對話開始生成' })
  const start = await say(user, '聚會')
  const help = await say(user, 'help')
  await replyOf(chat)
  assert.match(textsOf(await replyOf(start))[0], /聚會開始/)
  const helpReply = await replyOf(help)
  assert.equal(helpReply.messages.length, 3, '排在「聚會」後面的 help 是聚會裡的聊天內容')
  assert.ok(helpReply.messages[0].sender)

  // 聚會正在生成 → 送「結束聚會」→ 馬上送 help：聚會已經要結束，help 立刻回說明
  const talking = await say(user, '聚會裡再聊一句')
  await waitFor(() => requests().length === 5, { label: '這一輪開始生成' })
  const end = await say(user, '結束聚會')
  const after = await say(user, 'help')
  assert.deepEqual(textsOf(await replyOf(after, 2000)), [HELP_TEXT])
  assert.deepEqual(textsOf(await replyOf(end)), ['聚會結束，大家下次見！'])
  await sleep(600)
  assert.equal(line.replyTo(talking), undefined, '被打斷的那一輪沒有發言')
  assert.equal(requests().length, 5)
})

test('26c. 聚會正在生成時傳位置訊息：立刻回天氣卡片，這一輪聚會照常完成', async () => {
  await fresh()
  const user = newUser()
  await startParty(user)
  ollama.state.delay = 400
  const talk = await say(user, '聚會裡聊一句，成員還在想')
  await waitFor(() => requests().length === 1, { label: '這一輪開始生成' })
  const location = await send(
    makeEvent(user, { type: 'location', latitude: 25.03, longitude: 121.56, title: '我家' }),
  )
  const card = await replyOf(location, 2000)
  assert.equal(card.messages[0].type, 'flex')
  assert.equal(line.replyTo(talk), undefined, '位置訊息先回，聚會這一輪還在生成')

  const turn = await replyOf(talk)
  assert.equal(turn.messages.length, 3, '聚會這一輪照常由三位成員回應')
  assert.ok(turn.messages.every((message) => message.sender))
  assert.equal(requests().length, 3, '位置訊息沒有用到模型，也沒有被當成聊天內容')
  assert.equal(party.isInParty(user), true)
  assert.deepEqual(textsOf(await replyOf(await say(user, '結束聚會'))), ['聚會結束，大家下次見！'])
})

test('27. 同一個人連續送出很多快速指令：每一則都有回覆，每個回覆權杖只用一次', async () => {
  await fresh()
  const user = newUser()
  const texts = [
    'help',
    '匯率',
    '新聞',
    '天氣',
    '匯率 100 美金 日幣',
    '新聞 人工智慧',
    '？',
    '天氣 台北',
    '匯率',
    '新聞',
    'help',
    '天氣 台中',
  ]
  const events = texts.map((text) => textEvent(user, text))
  await sendWebhook(port, events) // 同一次 webhook 送來 12 則
  for (const event of events) {
    assert.equal((await replyOf(event, 5000)).delivered, true)
  }
  for (const event of events) {
    const uses = line.state.replies.filter((item) => item.replyToken === event.replyToken)
    assert.equal(uses.length, 1, `「${event.message.text}」的回覆權杖只用了一次`)
  }
  assert.equal(line.state.replies.length, texts.length, '沒有多送，也沒有漏掉')
  assert.equal(requests().length, 0)
})

test('28. 重複送達的快速指令只處理一次', async () => {
  await fresh()
  const user = newUser()
  const event = textEvent(user, '新聞')
  await sendWebhook(port, [event, event]) // 同一次 webhook 裡重複
  await sendWebhook(port, event) // 之後又重送一次
  await replyOf(event)
  await sleep(300)
  assert.equal(line.state.replies.length, 1)
})

test('29. 天氣查詢逾時：8 秒後告知；等待期間不擋住其他指令，也不擋住一般對話', async () => {
  await fresh()
  const user = newUser()
  external.hang = true // 外部的天氣服務不回應
  const weather = await say(user, '首爾天氣')
  await sleep(200)
  const help = await say(user, 'help')
  const chat = await say(user, '天氣還沒查到時的一般對話')
  const helpReply = await replyOf(help, 2000)
  assert.ok(helpReply.at - help.sentAt < 1000)
  assert.deepEqual(textsOf(await replyOf(chat, 3000)), ['答覆0'])
  assert.equal(line.replyTo(weather), undefined, '天氣這時候還在等外部服務')

  const reply = await replyOf(weather, 12000)
  external.hang = false
  assert.deepEqual(textsOf(reply), ['查詢資料逾時，請稍後再試。'])
  const elapsed = reply.at - weather.sentAt
  assert.ok(elapsed >= 7900 && elapsed < 9500, `約 8 秒逾時，實際 ${elapsed}ms`)
  assert.ok(
    logs.some((item) => /處理失敗｜TimeoutError/.test(item)),
    '逾時有寫進日誌',
  )
})

test('29b. 快速指令遇到預期之外的錯誤（外部服務回 HTTP 500）：有完整日誌、有回覆，不影響其他訊息', async () => {
  await fresh()
  const user = newUser()
  external.status = 500
  const before = logs.length
  const weather = await say(user, '天氣 台北')
  const news = await say(user, '新聞')
  const help = await say(user, 'help')
  assert.deepEqual(textsOf(await replyOf(weather)), ['處理時發生錯誤，請稍後再試。'])
  assert.deepEqual(textsOf(await replyOf(news)), ['處理時發生錯誤，請稍後再試。'])
  assert.deepEqual(textsOf(await replyOf(help)), [HELP_TEXT], '同時送出的 help 不受影響')
  external.status = 0

  const failed = logs.slice(before)
  // 每一則失敗各有一行摘要：輪次編號、遮罩過的使用者代號、錯誤種類、哪個服務、狀態碼
  const summaries = failed.filter((item) =>
    /^\[t=[0-9a-f]{8} u=[0-9a-f]{8}\] 處理失敗｜Error｜/.test(item),
  )
  assert.equal(summaries.length, 2)
  assert.ok(summaries.some((item) => item.endsWith('https://api.open-meteo.com/v1/forecast 500')))
  assert.ok(summaries.some((item) => item.endsWith('Google 新聞 500')))
  // 預期之外的錯誤另外印出完整內容（含發生的位置），方便找問題
  assert.equal(failed.filter((item) => /^Error: .* 500\n\s+at /.test(item)).length, 2)
  // 查詢參數裡有地名或座標，不能寫進日誌
  assert.ok(!failed.some((item) => item.includes('latitude') || item.includes('?')))

  // 外部服務恢復後照常運作
  assert.equal((await replyOf(await say(user, '天氣 台北'))).messages[0].type, 'flex')
})

test('30. 文字檔失敗後不把整份內容留在記憶裡，之後的一般對話恢復正常', async () => {
  await fresh()
  const user = newUser()
  ollama.state.plan.push({ hang: true })
  const failed = await replyOf(await send(fileEvent(user, '會逾時的檔案.txt', '丁'.repeat(4500))))
  assert.deepEqual(textsOf(failed), [TOO_SLOW])

  const next = await say(user, '檔案失敗之後問別的事')
  const reply = await replyOf(next)
  assert.deepEqual(textsOf(reply), ['答覆1'])
  assert.ok(reply.at - next.sentAt < 1000, '一般對話馬上就有回應')
  const sent = sentTo(1)
  const total = sent.slice(1).join('').length
  assert.ok(total < 800, `這次請求帶的記憶加訊息只有 ${total} 字`)
  assert.ok(sent[1].startsWith('檔案「會逾時的檔案.txt」的內容：'), '留下檔名和開頭')
  assert.ok(sent[1].includes('字，沒有處理成功，後面省略'))
  assert.ok(!sent[1].includes('丁'.repeat(600)), '整份檔案沒有留在記憶裡')
  assert.equal(sent[2], NO_REPLY)
})

test('31. 文字檔的編碼：UTF-8、UTF-16、Big5 都讀得懂；讀不懂的明確告知，不把亂碼交給模型', async () => {
  await fresh()
  const user = newUser()
  const text =
    '第一段：台灣位於東亞，四面環海，中央山脈縱貫南北。\r\n第二段：夜市、溫泉、登山步道各有特色。'
  const utf16 = Buffer.from(text, 'utf16le')
  const readable = [
    ['UTF-8', Buffer.from(text, 'utf8')],
    [
      'UTF-8（有 BOM）',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]),
    ],
    ['UTF-16 LE（有 BOM）', Buffer.concat([Buffer.from([0xff, 0xfe]), utf16])],
    [
      'UTF-16 BE（有 BOM）',
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16).swap16()]),
    ],
    ['Big5', encodeText('big5', text)],
  ]
  for (const [label, body] of readable) {
    const before = requests().length
    await replyOf(await send(fileEvent(user, '編碼測試.txt', body)))
    assert.equal(
      requests()[before].body.messages.at(-1).content[0].text,
      `檔案「編碼測試.txt」的內容：\n\n${text}`,
      `${label}：模型收到的內容和原文一模一樣`,
    )
  }

  // 很短的 Big5 檔（只有兩個字）也要讀得懂
  await replyOf(await send(fileEvent(user, '很短.txt', encodeText('big5', '謝謝'))))
  assert.equal(
    requests().at(-1).body.messages.at(-1).content[0].text,
    '檔案「很短.txt」的內容：\n\n謝謝',
  )

  // 下面這些編碼的內容，照 Big5 的規則其實都「解得開」，只是會變成整篇錯字，所以要另外分辨
  const simplified =
    '第一段：台湾位于东亚，四面环海，中央山脉纵贯南北。第二段：夜市、温泉、登山步道各有特色。'
  const japanese = 'こんにちは。本日の会議の内容をまとめてお送りします。'
  const unreadable = [
    ['GBK（簡體長句）', encodeText('gbk', simplified)],
    // 這一句每個字的第一碼剛好都落在 Big5 的常用字區，要靠第二碼才分得出來
    ['GBK（簡體短句）', encodeText('gbk', '基本结构课程考核办法（大纲）')],
    // 不到十個字：第二碼的比例不準，靠第一碼分辨
    ['GBK（簡體，不到十個字）', encodeText('gbk', '我们是学生')],
    ['EUC-KR（韓文）', encodeText('euc-kr', '안녕하세요. 오늘 회의 내용을 정리해서 보내드립니다.')],
    ['EUC-JP（日文）', encodeText('euc-jp', japanese)],
    ['Shift_JIS（日文）', encodeText('shift_jis', japanese)],
    ['UTF-16（沒有 BOM）', utf16],
    // 純英文的 UTF-16：每個字後面都跟著一個空字元，照 UTF-8 的規則其實解得開，但不是能讀的文字
    ['UTF-16（沒有 BOM，純英文）', Buffer.from('This is a plain English file.', 'utf16le')],
    ['不是文字的內容', Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 256))],
  ]
  const count = requests().length
  for (const [label, body] of unreadable) {
    const reply = await replyOf(await send(fileEvent(user, '讀不懂的檔案.txt', body)))
    assert.deepEqual(
      textsOf(reply),
      ['這個文字檔的編碼我讀不了（支援 UTF-8、UTF-16、Big5），請另存成 UTF-8 再傳一次。'],
      label,
    )
  }
  assert.equal(requests().length, count, '讀不懂的檔案都沒有交給模型')
})

test('32. 記憶裡有圖片時傳長檔案：圖片不再跟著重送', async () => {
  await fresh()
  const user = newUser()
  await replyOf(await send(imageEvent(user, IMAGES.jpeg)))
  await replyOf(await say(user, '針對圖片的追問'))
  assert.equal(imagesIn(1).length, 1, '短的追問會帶著圖片')
  await replyOf(await send(fileEvent(user, '長檔案.txt', '戊'.repeat(4500))))
  assert.equal(imagesIn(2).length, 0, '長檔案加上圖片會超過上限，圖片那一輪被捨棄')
  assert.ok(sentTo(2).some((item) => item.includes('戊'.repeat(4500))))
})

test('24. 日誌：有輪次編號、遮罩過的使用者代號、模型、時間與 token，但沒有聊天內容', () => {
  const summary = logs.find((item) =>
    /^\[聚會 t=[0-9a-f]{8} u=[0-9a-f]{8}\] 本輪 sequential｜/.test(item),
  )
  assert.ok(summary, '每一輪聚會有一行總結')
  assert.match(
    summary,
    /｜fake-model｜.*\d 則（最多 \d）｜呼叫 \d+ 次（重試 \d+、逾時 \d+）｜共 \d+ms｜/,
  )
  const call = logs.find((item) => /^\[聚會 t=[0-9a-f]{8} u=[0-9a-f]{8}\] 第一位 /.test(item))
  assert.match(call, /｜fake-model｜排隊 \d+ms｜生成 \d+ms｜輸入 \d+ \/ 輸出 \d+ tokens/)
  assert.ok(
    logs.some((item) => /^\[聚會 .*（重試）｜/.test(item)),
    '重試有標記',
  )
  assert.ok(
    logs.some((item) => /^\[聚會 .*｜失敗：timeout｜/.test(item)),
    '逾時有標記',
  )
  assert.ok(
    logs.some((item) =>
      /^\[對話 t=[0-9a-f]{8} u=[0-9a-f]{8}\] fake-model｜排隊 \d+ms｜生成 \d+ms｜/.test(item),
    ),
  )

  const all = logs.join('\n')
  for (const text of spoken) {
    // 指令本身（聚會、清除、help…）不是聊天內容，日誌的分類標籤裡本來就會有這些字
    if (text.length < 6) continue
    assert.ok(!all.includes(text), `日誌裡不應該出現使用者說的話：「${text}」`)
  }
  for (const id of users) assert.ok(!all.includes(id), '日誌裡不應該出現原始的使用者 ID')
  assert.ok(!all.includes(TOKEN) && !all.includes(SECRET), '日誌裡不應該出現權杖或密鑰')
})

test('33. 整個測試期間，沒有任何一個回覆權杖被拿來送出兩次', () => {
  const reused = [...line.state.tokenUses].filter(([, count]) => count > 1)
  assert.deepEqual(reused, [], '每個事件最多只回覆一次')
  assert.ok(line.state.tokenUses.size > 150, `共檢查了 ${line.state.tokenUses.size} 個回覆權杖`)
  assert.ok(
    !logs.some((item) => item.includes('已經回覆過，略過第二次回覆')),
    '沒有任何流程嘗試重複回覆',
  )
})
