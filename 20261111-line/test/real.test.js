// 用「真正的本機 Ollama」跑的整合測試：實際量回覆時間、冷啟動，並印出聚會的對話內容。
// LINE 平台仍然是假的（不會傳訊息給任何人），時間限制用的是正式環境的數字（回覆期限 52 秒）。
// Ollama 沒有啟動、或沒有安裝模型時，整份測試會略過。
// 模型可用環境變數 OLLAMA_MODEL、OLLAMA_BASE_URL 指定（測試不讀 .env）。
// 會把模型卸載再重新載入兩次來測冷啟動，整份大約要跑七分鐘。
// 模型的速度會隨電腦當時忙不忙而變，所以文字檔測試前後各量一次速度，並印出每次請求的 token 數與時間。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  SECRET,
  TOKEN,
  sleep,
  waitFor,
  startFakeLine,
  userId,
  makeEvent,
  textEvent,
  sendWebhook,
  captureLogs,
  solidPng,
  encodeText,
} from './helpers.js'

const MODEL = process.env.OLLAMA_MODEL || 'qwen3.6:35b-a3b'
const BASE = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '')
const REPLY_LIMIT_MS = 52 * 1000

// 一張整片紅色的圖（160×120 PNG）
const RED_PNG = solidPng(160, 120, [255, 0, 0])
// 一張損毀的圖：檔頭是 PNG，但內容解不開
const BROKEN_PNG = Buffer.concat([RED_PNG.subarray(0, 60), Buffer.from('這不是圖片的內容')])

const loadedModels = async () => {
  const res = await fetch(`${BASE}/api/ps`, { signal: AbortSignal.timeout(3000) })
  return (await res.json()).models || []
}
const isLoaded = async () => (await loadedModels()).some((item) => item.name === MODEL)
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
    PARTY_MODE: 'sequential',
  })
  for (const name of [
    'REPLY_LIMIT_MS',
    'REPLY_SEND_BUFFER_MS',
    'LINE_TIMEOUT_MS',
    'PARTY_MERGE_MS',
    'PARTY_STAGE_MS',
    'PARTY_RESERVE_MS',
    'PARTY_MIN_STAGE_MS',
    'AI_MIN_CALL_MS',
    'PENDING_TTL_MS',
    'OLLAMA_KEEP_ALIVE',
    'OLLAMA_MAX_QUEUE',
  ]) {
    delete process.env[name] // 用正式環境的預設值
  }

  const startedAt = Date.now()
  const { bot, server } = await import('../index.js')
  bot.endpoint = line.url
  bot.dataEndpoint = line.url
  if (!server.listening) await once(server, 'listening')
  const { port } = server.address()
  const party = await import('../party.js')

  after(async () => {
    server.closeAllConnections()
    server.close()
    await line.close()
  })

  const spoken = new Set()
  const say = async (user, text) => {
    const event = textEvent(user, text)
    spoken.add(text)
    event.sentAt = Date.now()
    assert.equal(await sendWebhook(port, event), 200)
    return event
  }
  const replyOf = (event) =>
    waitFor(() => line.replyTo(event), {
      timeout: 70 * 1000,
      interval: 50,
      label: `「${event.message.text || event.message.type}」的回覆`,
    })
  const textsOf = (reply) => reply.messages.map((message) => message.text)
  const seconds = (ms) => `${(ms / 1000).toFixed(1)} 秒`
  // 在期限內送達的回覆
  const answered = async (t, event) => {
    const reply = await replyOf(event)
    const elapsed = reply.at - event.sentAt
    assert.equal(reply.delivered, true)
    assert.ok(elapsed < REPLY_LIMIT_MS, `要在 52 秒內回覆，實際 ${seconds(elapsed)}`)
    t.diagnostic(`「${event.message.text || event.message.type}」→ ${seconds(elapsed)}`)
    return reply
  }
  const show = (t, reply) => {
    for (const message of reply.messages) {
      t.diagnostic(`  ${message.sender ? `${message.sender.name}：` : ''}${message.text}`)
    }
  }
  const describeTurn = (turn) =>
    `${turn.speakers} 則｜呼叫 ${turn.calls} 次（重試 ${turn.retries}、逾時 ${turn.timeouts}）｜${turn.cold ? '冷啟動｜' : ''}共 ${seconds(turn.ms)}｜各次生成 ${turn.log.map((item) => `${seconds(item.ms)}${item.ok ? '' : `(${item.reason})`}`).join('、')}｜${turn.reason}`
  const unload = async () => {
    await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
    })
    await waitFor(async () => !(await isLoaded()), {
      timeout: 30000,
      interval: 500,
      label: '模型卸載',
    })
  }
  const options = { timeout: 200 * 1000 }

  test('啟動：機器人先開始監聽，再在背景把模型載入記憶體', options, async (t) => {
    assert.equal(server.listening, true)
    await waitFor(() => logs.some((item) => item.includes('已載入') || item.includes('預載模型')), {
      timeout: 180 * 1000,
      interval: 200,
      label: '預載結果',
    })
    t.diagnostic(logs.find((item) => item.includes('已載入') || item.includes('預載模型')))
    t.diagnostic(`從啟動到模型就緒 ${seconds(Date.now() - startedAt)}`)
    assert.equal(await isLoaded(), true)
    assert.ok(logs.some((item) => item.includes('的能力：')))
  })

  test('1. 一般文字對話，並記得前面說過的話', options, async (t) => {
    const user = userId()
    show(t, await answered(t, await say(user, '我叫小明，請記住我的名字。')))
    const reply = await answered(t, await say(user, '我叫什麼名字？'))
    show(t, reply)
    assert.match(textsOf(reply)[0], /小明/)
  })

  test('2. 同時送來的兩則訊息照順序處理（第一階段檢查時這裡會答不出來）', options, async (t) => {
    const user = userId()
    const first = textEvent(user, '我最喜歡的水果是芒果，請記住。')
    const second = textEvent(user, '我最喜歡的水果是什麼？')
    first.sentAt = second.sentAt = Date.now()
    await sendWebhook(port, [first, second])
    await answered(t, first)
    const reply = await answered(t, second)
    show(t, reply)
    assert.match(textsOf(reply)[0], /芒果/)
  })

  test('4. 圖片辨識', options, async (t) => {
    const user = userId()
    const event = makeEvent(user, { type: 'image', contentProvider: { type: 'line' } })
    line.state.contents.set(event.message.id, { type: 'image/png', body: RED_PNG })
    event.sentAt = Date.now()
    await sendWebhook(port, event)
    const reply = await answered(t, event)
    show(t, reply)
    assert.match(textsOf(reply)[0], /紅|红/, '看得出圖片是紅色的')
    const followUp = await answered(t, await say(user, '所以它是什麼顏色？只回答顏色。'))
    show(t, followUp)
    assert.match(textsOf(followUp)[0], /紅|红/, '追問時還記得那張圖')

    // 損毀的圖片：模型讀不了時，明確告訴使用者，而且之後的對話不受影響
    const broken = makeEvent(user, { type: 'image', contentProvider: { type: 'line' } })
    line.state.contents.set(broken.message.id, { type: 'image/png', body: BROKEN_PNG })
    broken.sentAt = Date.now()
    await sendWebhook(port, broken)
    const refused = await answered(t, broken)
    show(t, refused)
    assert.deepEqual(textsOf(refused), ['這張圖片模型讀不了，請換一張，或改傳 JPG、PNG。'])
    const after = await answered(t, await say(user, '只回一個字：好'))
    show(t, after)
    assert.ok(!textsOf(after)[0].includes('發生錯誤'), '壞掉的圖片沒有留在記憶裡拖累後面的對話')
  })

  test('12. 聚會：三位角色串行生成', options, async (t) => {
    const user = userId()
    await replyOf(await say(user, '聚會'))
    const reply = await answered(t, await say(user, '週末有什麼推薦的活動？'))
    show(t, reply)
    const turn = party.getLastTurn(user)
    t.diagnostic(describeTurn(turn))
    assert.equal(reply.messages.length, 3)
    assert.equal(
      new Set(reply.messages.map((message) => message.sender.name)).size,
      3,
      '三位不同的成員',
    )
    assert.ok(turn.calls <= 4, '一輪最多呼叫 3 + 1 次')
    for (const text of textsOf(reply)) assert.ok(text.length > 0)

    const second = await answered(t, await say(user, '可是我怕下雨耶。'))
    show(t, second)
    t.diagnostic(describeTurn(party.getLastTurn(user)))
    const names = [...reply.messages, ...second.messages].map((message) => message.sender.name)
    assert.equal(new Set(names).size, names.length, '第二輪換另外幾位成員，沒有人連續出現')
    await replyOf(await say(user, '結束聚會'))
  })

  test('9. 聚會：快速連續傳三則，只回一輪', options, async (t) => {
    const user = userId()
    await replyOf(await say(user, '聚會'))
    const events = []
    for (const text of ['我今天加班到九點。', '晚餐還沒吃。', '有沒有推薦的宵夜？']) {
      events.push(await say(user, text))
    }
    const reply = await answered(t, events[2])
    show(t, reply)
    const turn = party.getLastTurn(user)
    t.diagnostic(describeTurn(turn))
    await sleep(3000)
    assert.equal(line.replyTo(events[0]), undefined)
    assert.equal(line.replyTo(events[1]), undefined)
    assert.ok(turn.calls <= 4, `三則訊息只用了 ${turn.calls} 次呼叫`)

    // 點名的成員一定會回
    const named = await answered(t, await say(user, '小楷 你覺得呢？'))
    show(t, named)
    assert.equal(named.messages[0].sender.name, '小楷')

    // 道別時不用三個人都出來說話
    const bye = await answered(t, await say(user, '我先走囉，掰掰'))
    show(t, bye)
    t.diagnostic(describeTurn(party.getLastTurn(user)))
    assert.ok(bye.messages.length <= 2)
    await replyOf(await say(user, '結束聚會'))
  })

  test('16. 聚會：生成到一半結束聚會，立刻停止、不再發言', options, async (t) => {
    const user = userId()
    await replyOf(await say(user, '聚會'))
    const talking = await say(user, '最近有什麼好看的電影嗎？')
    await sleep(3000) // 這時第一位正在生成
    const end = await say(user, '結束聚會')
    const reply = await replyOf(end)
    const elapsed = reply.at - end.sentAt
    t.diagnostic(`說「結束聚會」後 ${seconds(elapsed)} 收到回覆`)
    assert.deepEqual(textsOf(reply), ['聚會結束，大家下次見！'])
    assert.ok(elapsed < 2000, '不用等那一輪跑完')
    await sleep(15000) // 原本三位發言需要的時間
    assert.equal(line.replyTo(talking), undefined, '被打斷的那一輪沒有送出任何訊息')
    // 模型已經被釋放：馬上問別的問題很快就有回應
    const quick = await say(user, '只回一個字：好')
    const next = await answered(t, quick)
    assert.ok(next.at - quick.sentAt < 10000, '模型沒有被那一輪繼續佔著')
  })

  test('14. 兩位使用者同時發問：都得到回覆，記憶互不干擾', options, async (t) => {
    const [a, b] = [userId(), userId()]
    const events = [
      textEvent(a, '我養的貓叫做麻糬，請記住。'),
      textEvent(b, '我養的狗叫做布丁，請記住。'),
    ]
    events[0].sentAt = events[1].sentAt = Date.now()
    await sendWebhook(port, events)
    await answered(t, events[0])
    await answered(t, events[1])
    const asks = [textEvent(a, '我的寵物叫什麼名字？'), textEvent(b, '我的寵物叫什麼名字？')]
    asks[0].sentAt = asks[1].sentAt = Date.now()
    await sendWebhook(port, asks)
    const [replyA, replyB] = [await answered(t, asks[0]), await answered(t, asks[1])]
    show(t, replyA)
    show(t, replyB)
    assert.match(textsOf(replyA)[0], /麻糬/)
    assert.ok(!textsOf(replyA)[0].includes('布丁'))
    assert.match(textsOf(replyB)[0], /布丁/)
    assert.ok(!textsOf(replyB)[0].includes('麻糬'))
  })

  // ---------- 第二批修正：文字檔與快速指令 ----------
  const csvLine = (i) =>
    `2026-11-${String((i % 28) + 1).padStart(2, '0')},${2300 + (i % 60)},${(2385.5 + i * 0.35).toFixed(2)},${(2395.25 + i * 0.4).toFixed(2)},${(2330.75 - i * 0.2).toFixed(2)},${34359285 + i * 7919}\r\n`
  const zhParagraph = (i) =>
    `第${i}段：台灣位於東亞，四面環海，中央山脈縱貫南北，氣候從亞熱帶到熱帶都有。近年各縣市推動觀光與在地創生，夜市、溫泉、登山步道與離島旅遊各有特色，也帶動交通與住宿產業的發展。\r\n`
  const build = (make, chars) => {
    let text = ''
    for (let i = 1; text.length < chars; i++) text += make(i)
    return text.slice(0, chars)
  }
  const fileEvent = (user, name, body) => {
    const event = makeEvent(user, {
      type: 'file',
      fileName: name,
      fileSize: Buffer.byteLength(body),
    })
    line.state.contents.set(event.message.id, { type: 'text/plain', body })
    event.sentAt = Date.now()
    return event
  }
  const sendFile = async (user, name, body) => {
    const event = fileEvent(user, name, body)
    event.logsBefore = logs.length
    assert.equal(await sendWebhook(port, event), 200)
    return event
  }
  // 等檔案的回覆，並印出這次模型請求的紀錄（排隊與生成時間、輸入與輸出的 token 數；裡面沒有訊息內容）
  const answeredFile = async (t, event) => {
    const reply = await answered(t, event)
    const entry = logs.slice(event.logsBefore).find((item) => item.startsWith('[對話'))
    t.diagnostic(`  ${entry ? entry.replace(/^\[對話[^\]]*\] /, '') : '（沒有呼叫模型）'}`)
    return reply
  }
  const NOT_READY = 'AI 這次來不及在時限內回覆，請再傳一次。'
  // 直接問 Ollama 一題，量「讀輸入」和「產生輸出」各自的速度（Ollama 自己的 API 會分開回報）
  const measureSpeed = async (t, label) => {
    const seed = Date.now() % 100000
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,
        keep_alive: '30m',
        messages: [
          {
            role: 'user',
            content: `${build((i) => csvLine(i + seed), 2000)}\n\n請用三句話說明這份資料的欄位。`,
          },
        ],
      }),
      signal: AbortSignal.timeout(120 * 1000),
    })
    const data = await res.json()
    assert.equal(res.status, 200)
    const read = data.prompt_eval_count / (data.prompt_eval_duration / 1e9)
    const write = data.eval_count / (data.eval_duration / 1e9)
    t.diagnostic(
      `${label}：讀取每秒 ${read.toFixed(0)} tokens（${data.prompt_eval_count} tokens）、輸出每秒 ${write.toFixed(1)} tokens（${data.eval_count} tokens）`,
    )
    assert.ok(read > 0 && write > 0)
  }

  test('量測：文字檔測試之前，模型目前的速度', options, async (t) => {
    await measureSpeed(t, '文字檔測試之前')
  })

  test('文字檔：5,000 字的數字表格加上既有的對話記憶，仍在期限內完成', options, async (t) => {
    const user = userId()
    // 先聊五句（約 2,000 字）。總長度上限是 6,000 字，所以送檔案時，記憶只會留下放得下的最新幾句
    for (let i = 1; i <= 5; i++) {
      const text =
        `這是第${i}段背景說明，請記住就好，只回一個字：好。${'我平常喜歡在週末去不同的城市走走，順便記下當地的小吃與交通方式。'.repeat(20)}`.slice(
          0,
          400,
        )
      await replyOf(await say(user, text))
    }
    const reply = await answeredFile(t, await sendFile(user, 'data.csv', build(csvLine, 5000)))
    show(t, reply)
    assert.notEqual(textsOf(reply)[0], NOT_READY)
    const zh = await answeredFile(
      t,
      await sendFile(userId(), 'article.txt', build(zhParagraph, 5000)),
    )
    assert.notEqual(textsOf(zh)[0], NOT_READY)
  })

  test('文字檔：超過上限的檔案只讀前 5,000 字，並在回覆裡說明', options, async (t) => {
    const reply = await answeredFile(
      t,
      await sendFile(userId(), 'long.txt', build(zhParagraph, 12000)),
    )
    show(t, reply)
    assert.ok(textsOf(reply)[0].endsWith('（這個檔案共 12,000 字，這次只讀了前 5,000 字。）'))
  })

  test('文字檔：Big5 和 UTF-16 編碼的檔案讀得懂，GBK 明確回覆讀不了', options, async (t) => {
    const text = build(zhParagraph, 600)
    const big5 = await answeredFile(
      t,
      await sendFile(userId(), 'big5.txt', encodeText('big5', text)),
    )
    show(t, big5)
    assert.match(textsOf(big5)[0], /台灣|臺灣/, '摘要得出內容，表示不是亂碼')
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    const reply16 = await answeredFile(t, await sendFile(userId(), 'utf16.txt', utf16))
    show(t, reply16)
    assert.match(textsOf(reply16)[0], /台灣|臺灣/)
    const simplified =
      '台湾位于东亚，四面环海，中央山脉纵贯南北，气候从亚热带到热带都有。近年各县市推动观光与在地创生。'
    const gbk = await answered(
      t,
      await sendFile(userId(), 'gbk.txt', encodeText('gbk', simplified)),
    )
    show(t, gbk)
    assert.match(textsOf(gbk)[0], /^這個文字檔的編碼我讀不了/)
  })

  test('快速指令：真實的摘要還在進行時，help、匯率、新聞立刻回覆', options, async (t) => {
    const user = userId()
    // 內容要和前面的測試不同：一樣的話模型會沿用上次讀過的結果，幾秒就做完，測不到「進行中」
    const other = (i) =>
      `第${i}則：這是一份會議紀錄的節錄，內容包含各部門的進度報告、預算執行情形與下一季的工作重點，另外也討論了人力調度、教育訓練與設備更新的時程安排。\r\n`
    const file = await sendFile(user, 'minutes.txt', build(other, 5000))
    await sleep(1500) // 這時模型正在讀檔案
    for (const text of ['help', '匯率', '新聞']) {
      const event = await say(user, text)
      const reply = await replyOf(event)
      const ms = reply.at - event.sentAt
      t.diagnostic(`摘要進行中送「${text}」→ ${ms}ms 回覆`)
      assert.ok(ms < 3000, `「${text}」不必等摘要`)
      assert.equal(line.replyTo(file), undefined, '這時摘要還沒完成')
    }
    const summary = await answeredFile(t, file)
    show(t, summary)
    assert.notEqual(textsOf(summary)[0], NOT_READY)
  })

  test('量測：文字檔測試之後，模型目前的速度', options, async (t) => {
    await measureSpeed(t, '文字檔測試之後')
  })

  test('17. 模型冷啟動（一般對話）：卸載模型後的第一則訊息仍在 52 秒內回覆', options, async (t) => {
    await unload()
    const reply = await answered(t, await say(userId(), '請用一句話介紹台北。'))
    show(t, reply)
    assert.ok(!textsOf(reply)[0].includes('來不及'), '有等到模型載入並回答')
  })

  test('17. 模型冷啟動（聚會）：在期限內至少有回應，下一輪恢復三位', options, async (t) => {
    const user = userId()
    await replyOf(await say(user, '聚會'))
    await unload()
    const cold = await answered(t, await say(user, '大家晚餐都吃了什麼？'))
    show(t, cold)
    const turn = party.getLastTurn(user)
    t.diagnostic(describeTurn(turn))
    assert.equal(turn.cold, true, '有偵測到模型還沒載入')
    assert.ok(cold.messages.length >= 1)
    t.diagnostic(
      cold.messages[0].sender
        ? `冷啟動這一輪有 ${cold.messages.length} 位成員發言`
        : '冷啟動這一輪來不及，回覆的是「來不及」的說明',
    )

    const warm = await answered(t, await say(user, '那你們平常都自己煮嗎？'))
    show(t, warm)
    t.diagnostic(describeTurn(party.getLastTurn(user)))
    assert.equal(warm.messages.length, 3)
    await replyOf(await say(user, '結束聚會'))
  })

  test('模型會留在記憶體約 30 分鐘（每次請求都帶 keep_alive）', options, async (t) => {
    const [model] = (await loadedModels()).filter((item) => item.name === MODEL)
    const minutes = (new Date(model.expires_at) - Date.now()) / 60000
    t.diagnostic(`距離卸載還有 ${minutes.toFixed(1)} 分鐘`)
    assert.ok(minutes > 25 && minutes < 31)
  })

  test('原有功能（真實網路）：匯率、新聞卡片', options, async (t) => {
    const user = userId()
    for (const text of ['匯率', '匯率 100 美金 日幣', '新聞']) {
      const reply = await answered(t, await say(user, text))
      if (reply.messages[0].type !== 'flex') {
        t.diagnostic(`  機器人的回覆：${reply.messages[0].text}`)
      }
      assert.equal(reply.messages[0].type, 'flex', `「${text}」回的是卡片`)
      t.diagnostic(`  ${reply.messages[0].altText}`)
    }
  })

  test('日誌裡沒有聊天內容', () => {
    const all = logs.join('\n')
    for (const text of spoken) {
      if (text.length < 6) continue
      assert.ok(!all.includes(text), `日誌裡不應該出現：「${text}」`)
    }
  })
}
