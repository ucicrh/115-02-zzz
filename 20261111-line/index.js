import 'dotenv/config'
import { createHash, randomUUID } from 'node:crypto'
import linebot from 'linebot'
import { askAI, clearHistory, markUndelivered, warmUp } from './OpenAI.js'
import { TASKS, HELP_TEXT, parseCommand } from './commands.js'
import { getRates, parseRateQuery, getNews } from './services.js'
import { rateOverviewCard, rateConvertCard, newsCard } from './flex.js'
import {
  isInParty,
  isPartyClosing,
  startParty,
  endParty,
  interruptParty,
  clearPartyMemory,
  partyReply,
  isPartyTurnActive,
  finishPartyTurn,
} from './party.js'

export const bot = linebot({
  channelId: process.env.CHANNEL_ID,
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
})

// ---------- 時間限制 ----------
// LINE 的回覆權杖要在收到訊息後一分鐘內用掉，所以每則訊息的期限都從「收到 webhook 的那一刻」起算，
// 排隊等待的時間也算在裡面：
//   收到後 REPLY_LIMIT_MS 內，回覆一定要送出去；
//   其中最後 SEND_BUFFER_MS 留給傳送，AI 生成最晚只能用到「收到後 REPLY_LIMIT_MS − SEND_BUFFER_MS」。
const envNumber = (name, fallback) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const REPLY_LIMIT_MS = envNumber('REPLY_LIMIT_MS', 52 * 1000)
const SEND_BUFFER_MS = envNumber('REPLY_SEND_BUFFER_MS', 4 * 1000)
const LINE_TIMEOUT_MS = envNumber('LINE_TIMEOUT_MS', 10 * 1000) // 呼叫 LINE API 最多等多久
const PARTY_MERGE_MS = envNumber('PARTY_MERGE_MS', 1500) // 聚會中這段時間內連續傳來的訊息合併成一輪
const PENDING_TTL_MS = envNumber('PENDING_TTL_MS', 5 * 60 * 1000) // 選了功能之後多久內要傳圖片或檔案
const TASK_LIMIT_MS = REPLY_LIMIT_MS + 20 * 1000 // 單一則訊息的處理時間上限（保險用，正常不會碰到）
// LINE 文件：重新送達的事件，發生超過 20 分鐘後回覆權杖就不能用了
const REDELIVERY_LIMIT_MS = 20 * 60 * 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 日誌裡不直接寫使用者 ID，改用雜湊後的短代號（同一個人每次都一樣，但看不出原本的 ID）
const maskUser = (userId) => createHash('sha256').update(String(userId)).digest('hex').slice(0, 8)

// ---------- 回覆 ----------
const messageButton = (label, text = label) => ({
  type: 'action',
  action: { type: 'message', label, text },
})

const DEFAULT_BUTTONS = [
  'OCR',
  '翻譯',
  '解題',
  '摘要',
  '改寫',
  '匯率',
  '新聞',
  '聚會',
  'help',
].map((label) => messageButton(label))

// LINE 回覆失敗的原因
const classifyLineError = (status, message = '') => {
  if (status === 400 && /reply token/i.test(message)) return 'reply_token' // 回覆權杖過期或已經用過
  if (status === 400) return 'bad_request' // 訊息內容不合規定
  if (status === 401 || status === 403) return 'auth' // 頻道權杖無效，或沒有權限
  if (status === 429) return 'rate_limit' // 超過速率或額度上限
  if (status >= 500) return 'line_server' // LINE 伺服器的問題
  return 'http'
}

// 呼叫 LINE API。回傳 { ok, status, kind, message }，不會丟出錯誤；失敗原因放在 kind（另外還有 timeout、network）。
// 回覆不用 linebot 的 reply()：它會丟掉 HTTP 狀態碼，回覆失敗也看不出來，而且沒有逾時。
// 這裡用的是同一個端點、同樣的內容，只是自己送出請求。
const callLine = async (path, body, timeoutMs = LINE_TIMEOUT_MS) => {
  try {
    const res = await fetch(`${bot.endpoint}${path}`, {
      method: 'POST',
      headers: bot.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    if (res.ok) return { ok: true, status: res.status }
    let data = {}
    try {
      data = JSON.parse(text)
    } catch {
      // 錯誤內容不是 JSON，只用狀態碼判斷
    }
    // details 只有欄位名稱和規則說明（例如 messages[0].text：May not be empty），沒有訊息內容
    const details = (data.details || [])
      .map((item) => `${item.property || ''} ${item.message || ''}`.trim())
      .join('；')
    return {
      ok: false,
      status: res.status,
      kind: classifyLineError(res.status, data.message),
      message: [data.message, details].filter(Boolean).join('｜') || '（沒有說明）',
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      kind: error.name === 'TimeoutError' ? 'timeout' : 'network',
      message: error.cause?.message || error.message,
    }
  }
}

// LINE 單則文字上限 5000 字（以 UTF-16 計算）；剛好切在表情符號中間的話，把剩下的半個字拿掉
const clip = (text) => {
  const cut = text.slice(0, 5000)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

// messages 可以是字串、訊息物件或陣列；快速按鈕會掛在最後一則訊息下方。
// 回傳 callLine 的結果，可以用 ok 判斷有沒有送達。失敗時不會丟出錯誤，但一定會寫進日誌。
const reply = async (event, messages, buttons = DEFAULT_BUTTONS) => {
  const list = [messages]
    .flat()
    .map((message) =>
      typeof message === 'string' ? { type: 'text', text: clip(message) } : message,
    )
  if (buttons?.length) list[list.length - 1].quickReply = { items: buttons }
  const age = event.ctx ? `｜收到訊息後 ${Date.now() - event.ctx.receivedAt}ms` : ''
  if (event.stale) {
    console.error(`[LINE ${event.tag}] 沒有回覆：這是重新送達的舊事件，回覆權杖已經不能用${age}`)
    return { ok: false, status: 0, kind: 'reply_token', message: '重新送達的舊事件' }
  }
  // 回覆權杖只能用一次：同一個事件不管走哪一條處理路徑，都只會送出一次回覆
  if (event.replied) {
    console.error(`[LINE ${event.tag}] 這個事件已經回覆過，略過第二次回覆${age}`)
    return { ok: false, status: 0, kind: 'reply_token', message: '同一個事件重複回覆' }
  }
  event.replied = true
  const result = await callLine('/message/reply', { replyToken: event.replyToken, messages: list })
  if (!result.ok) {
    console.error(
      `[LINE ${event.tag}] 回覆失敗｜${result.kind}｜HTTP ${result.status}｜${result.message}${age}`,
    )
  }
  return result
}

// ---------- 載入動畫 ----------
// 等 AI 的時候讓聊天室顯示「輸入中」的動畫。LINE 的限制：只有一對一聊天能用，
// 使用者要正開著聊天畫面才看得到；之後只要送出任何訊息，動畫就會消失。
let loadingAvailable = process.env.LINE_LOADING !== 'off'
let loadingConfirmed = false
const showLoading = (event) => {
  if (!loadingAvailable || event.source?.type !== 'user' || !event.source.userId) return
  if (event.stale) return // 已經來不及回覆的舊事件，不用顯示
  // 秒數只能是 5 的倍數（5～60）。設成到回覆期限為止，萬一回覆沒送出去，動畫也會自己消失
  const left = event.ctx.replyBy - Date.now()
  const seconds = Math.min(60, Math.max(5, Math.ceil(left / 5000) * 5))
  // 不等它完成，它失敗也不影響回覆
  callLine(
    '/chat/loading/start',
    { chatId: event.source.userId, loadingSeconds: seconds },
    3000,
  ).then((result) => {
    if (result.ok) {
      if (!loadingConfirmed) console.log(`[LINE] 載入動畫可用（HTTP ${result.status}）`)
      loadingConfirmed = true
      return
    }
    console.warn(
      `[LINE ${event.tag}] 載入動畫失敗｜${result.kind}｜HTTP ${result.status}｜${result.message}`,
    )
    // 權杖或權限的問題不會自己好，這次執行期間就不再嘗試；逾時、限流之類的下次照常
    if (result.kind === 'auth') loadingAvailable = false
  })
}

// ---------- 匯率、新聞 ----------
const replyRate = async (event, query) => {
  const rateData = await getRates()
  const parsed = parseRateQuery(query, rateData.rates)
  if (parsed?.unknown) {
    await reply(event, `不認得貨幣「${parsed.unknown}」，請用像「匯率 100 美金 日幣」的寫法。`)
  } else if (parsed) {
    await reply(event, rateConvertCard(parsed, rateData))
  } else {
    await reply(event, rateOverviewCard(rateData))
  }
}

// 只回新聞卡片，不另外請 AI 整理重點，省下免費額度
const replyNews = async (event, keyword) => {
  const items = await getNews(keyword)
  if (items.length === 0) {
    await reply(event, `找不到「${keyword}」的相關新聞。`)
    return
  }
  await reply(event, newsCard(items, keyword))
}

// ---------- 圖片、檔案 ----------
// 目前模型只讀得懂文字和圖片：語音、PDF 還沒有支援，會直接告訴使用者，不會假裝處理。
const MAX_FILE_SIZE = 15 * 1024 * 1024
const MAX_IMAGE_SIZE = 10 * 1024 * 1024
// 文字檔一次最多處理幾個字（可用 .env 的 TEXT_FILE_MAX_CHARS 調整）。
// 模型讀多久看的是 token 不是字數：中文每字約 0.7 個 token，數字表格每字約 1 個。
// 讀取速度平常每秒約 500 個 token，但實測過有一段時間只剩一半（原因還不確定），上限要照慢的時候訂：
// 5,000 字的數字表格加上對話記憶，平常實測 19–23 秒；讀取速度減半時推算約 28–33 秒，離 48 秒的生成期限還有 15 秒。
// 8,000 字在讀取變慢的那段時間實測 46 秒（只剩 2 秒），10,000 字以上會超過期限。
const MAX_TEXT_LENGTH = envNumber('TEXT_FILE_MAX_CHARS', 5000)
const DOWNLOAD_TIMEOUT_MS = 15 * 1000
const TEXT_EXTENSIONS = ['txt', 'md', 'csv', 'json', 'log', 'html', 'xml']

// 可以直接把訊息回給使用者看的錯誤（例如檔案太大）；cause 是原本的錯誤，只寫進日誌
class UserError extends Error {}

// 下載使用者傳來的圖片或檔案。
// 不用 linebot 的 message.content()：它不檢查狀態碼也沒有逾時，下載失敗時會把錯誤訊息當成檔案內容。
const download = async (event, maxSize, tooLarge) => {
  const res = await fetch(`${bot.dataEndpoint}/message/${event.message.id}/content`, {
    headers: { Authorization: bot.headers.Authorization },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (res.status !== 200) {
    await res.body?.cancel()
    const error = new Error(`下載訊息內容失敗：HTTP ${res.status}`)
    // 404、410：內容不存在或已被收回
    if (res.status === 404 || res.status === 410) {
      throw new UserError('下載不到這則訊息的內容，可能已經過期或被收回，請再傳一次。', {
        cause: error,
      })
    }
    throw error
  }
  if (Number(res.headers.get('content-length')) > maxSize) {
    await res.body?.cancel()
    throw new UserError(tooLarge)
  }
  // 邊讀邊算大小，超過上限就停，不把過大的檔案整個讀進記憶體
  const chunks = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > maxSize) throw new UserError(tooLarge)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// 從檔案開頭的幾個位元組判斷圖片格式；不是認得的圖片就回傳 null
const sniffImage = (buffer) => {
  const head = buffer.toString('latin1', 0, 12)
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png'
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp'
  if (/^GIF8[79]a/.test(head)) return 'image/gif'
  if (head.startsWith('BM')) return 'image/bmp'
  return null
}

// 簡體的 GBK、韓文的 EUC-KR、日文的 EUC-JP 檔有時也能照 Big5 的規則解出來，只是整篇都是錯字。
// 用雙位元組字的兩個特徵分辨（都是實測的數字）：
//   第一碼：真正的 Big5 中文幾乎都是常用字，落在 0xA1–0xC6（100%）；簡體 GBK 的長文只有五、六成。
//   第二碼：Big5 有四到六成小於 0x80；GBK 的常用字、EUC-KR、EUC-JP 一律是 0xA1 以上（0%）。
const looksLikeBig5 = (buffer) => {
  let pairs = 0
  let common = 0
  let lowTrail = 0
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] < 0x81) continue
    pairs += 1
    if (buffer[i] >= 0xa1 && buffer[i] <= 0xc6) common += 1
    if (buffer[i + 1] < 0x80) lowTrail += 1
    i += 1 // 跳過這個字的第二個位元組
  }
  if (pairs === 0) return true
  if (common / pairs < 0.8) return false
  // 字太少時第二碼的比例不準（例如「謝謝」兩個字的第二碼剛好都不小於 0x80），十個字以上才看
  return pairs < 10 || lowTrail / pairs >= 0.1
}

// 嚴格解碼：遇到不合這種編碼的位元組就回傳 null，而不是悄悄換成亂碼符號
const strictDecode = (buffer, encoding) => {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

// 把文字檔的內容解成字串。支援 UTF-8（有沒有 BOM 都可以）、UTF-16（要有 BOM）、Big5。
// 都不是就回傳 null，由呼叫端告訴使用者，不把亂碼交給模型。
const decodeText = (buffer) => {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return strictDecode(buffer, 'utf-16le')
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return strictDecode(buffer, 'utf-16be')
  // 文字檔裡不該有空字元；有的話多半是沒有 BOM 的 UTF-16，或根本不是文字檔
  if (buffer.includes(0)) return null
  const utf8 = strictDecode(buffer, 'utf-8')
  if (utf8 !== null) return utf8
  return looksLikeBig5(buffer) ? strictDecode(buffer, 'big5') : null
}

// 把訊息內容轉成給 AI 的 part，並決定沒選功能時的預設功能；不支援時回傳 { error }
const readMedia = async (event) => {
  const { type, fileName = '', fileSize = 0 } = event.message
  if (type === 'audio') {
    // 語音辨識還沒有實作，先說清楚，也不必下載
    return { error: '目前還不支援語音訊息，請改用文字或圖片。' }
  }
  if (type === 'image') {
    const buffer = await download(event, MAX_IMAGE_SIZE, '圖片太大了，請傳 10MB 以內的圖片。')
    const mimeType = sniffImage(buffer)
    if (!mimeType) {
      console.warn(`[${event.tag}] 下載到的內容不是認得的圖片格式（${buffer.length} bytes）`)
      return { error: '這張圖片的格式我讀不了，請改傳 JPG 或 PNG。' }
    }
    return {
      part: { inlineData: { mimeType, data: buffer.toString('base64') } },
      defaultTask: '描述',
    }
  }
  const extension = fileName.split('.').pop().toLowerCase()
  if (extension === 'pdf') {
    // PDF 需要先抽出文字才能交給模型，這個功能還沒有實作
    return {
      error: `目前還不支援 PDF。可以把內容貼成文字，或改傳文字檔（${TEXT_EXTENSIONS.join('、')}）。`,
    }
  }
  if (!TEXT_EXTENSIONS.includes(extension)) {
    return { error: `目前只能讀文字檔（${TEXT_EXTENSIONS.join('、')}）。` }
  }
  if (fileSize > MAX_FILE_SIZE) {
    return { error: '檔案太大了，請傳 15MB 以內的檔案。' }
  }
  const tooLarge = '檔案太大了，請傳 15MB 以內的檔案。'
  const full = decodeText(await download(event, MAX_FILE_SIZE, tooLarge))
  if (full === null) {
    console.warn(`[${event.tag}] 文字檔不是 UTF-8、UTF-16 或 Big5 編碼，沒有交給模型`)
    return {
      error: '這個文字檔的編碼我讀不了（支援 UTF-8、UTF-16、Big5），請另存成 UTF-8 再傳一次。',
    }
  }
  const truncated = full.length > MAX_TEXT_LENGTH
  const limit = MAX_TEXT_LENGTH.toLocaleString('en-US')
  return {
    part: {
      text: `檔案「${fileName}」的內容${truncated ? `（檔案太長，以下只有前 ${limit} 字）` : ''}：\n\n${full.slice(0, MAX_TEXT_LENGTH)}`,
    },
    defaultTask: '摘要',
    // 只處理了一部分的話，要明白告訴使用者
    note: truncated
      ? `（這個檔案共 ${full.length.toLocaleString('en-US')} 字，這次只讀了前 ${limit} 字。）`
      : '',
  }
}

// ---------- 事件處理 ----------
// 記錄使用者選了哪個功能，下一則圖片或檔案會套用（用完即重置，超過 PENDING_TTL_MS 沒傳也作廢）
const pendingTask = new Map() // userId -> { command, at }

const setPending = (userId, command) => pendingTask.set(userId, { command, at: Date.now() })

// 取出並清掉使用者先前選的功能；已經過期的不算
const takePending = (userId) => {
  const entry = pendingTask.get(userId)
  pendingTask.delete(userId)
  return entry && Date.now() - entry.at <= PENDING_TTL_MS ? entry.command : null
}

const PARTY_BUTTONS = [messageButton('結束聚會')]

const END_PARTY = /^(結束聚會|離開聚會|散會)$/
const CLEAR_MEMORY = /^(清除|重置|reset)$/i

// 交給 AI 時一起帶上的期限、取消開關和日誌標記
const aiOptions = (event) => ({
  deadline: event.ctx.deadline,
  signal: event.ctx.signal,
  tag: event.tag,
})

// 請 AI 回答並回覆使用者。note 是要附在回答後面的說明
const answerWithAI = async (event, userId, parts, note = '') => {
  showLoading(event)
  const answer = await askAI(userId, parts, aiOptions(event))
  const result = await reply(event, note ? `${answer}\n\n${note}` : answer)
  // 沒送達的回答，使用者沒看到，記憶裡不能當作已經說過
  if (!result.ok) markUndelivered(userId)
}

// ---------- 快速指令 ----------
// help、匯率、新聞不需要 AI，也不讀寫對話記憶。
// 這段文字是不是快速指令：是的話回傳要做什麼，不是就回傳 null。
// 「要不要排隊」和「實際怎麼處理」都用這同一個函式判斷，兩邊不會不一致。
const parseQuickCommand = (text) => {
  if (/^(help|說明|幫助|\?|？)$/i.test(text)) return { kind: 'help' }

  const rateMatch = text.match(/^匯率(?:\s+(.+))?$/)
  if (rateMatch) return { kind: 'rates', query: rateMatch[1] || '' }

  const newsMatch = text.match(/^新聞(?:\s+(.+))?$/)
  if (newsMatch) return { kind: 'news', keyword: newsMatch[1] || '' }
  return null
}

const handleQuick = async (event, quick) => {
  if (quick.kind === 'help') {
    await reply(event, HELP_TEXT)
  } else if (quick.kind === 'rates') {
    await replyRate(event, quick.query)
  } else {
    await replyNews(event, quick.keyword)
  }
}

const handleText = async (event, userId, text) => {
  if (END_PARTY.test(text)) {
    const wasInParty = endParty(userId)
    await reply(event, wasInParty ? '聚會結束，大家下次見！' : '目前沒有在聚會中。')
    return
  }
  if (text === '聚會') {
    // 角色設定載入失敗時聚會不會開始，這時回的是說明文字，按鈕照一般的顯示
    const greeting = startParty(userId)
    await reply(event, greeting, isInParty(userId) ? PARTY_BUTTONS : DEFAULT_BUTTONS)
    return
  }
  // 清除記憶：聚會的聊天紀錄和一般對話的記憶是分開的，人在哪裡就清哪一邊
  if (CLEAR_MEMORY.test(text)) {
    if (isInParty(userId)) {
      clearPartyMemory(userId)
      await reply(
        event,
        '已清除這場聚會的聊天紀錄，大家會當作重新開始聊。（聚會以外的對話記憶沒有動）',
        PARTY_BUTTONS,
      )
    } else {
      clearHistory(userId)
      pendingTask.delete(userId)
      await reply(event, '已清除之前的對話記憶。')
    }
    return
  }
  // 聚會進行中的其他文字都交給聚會（見 handlePartyTurn），不會走到下面

  // help、匯率、新聞
  const quick = parseQuickCommand(text)
  if (quick) {
    await handleQuick(event, quick)
    return
  }

  const command = parseCommand(text)
  if (!command) {
    // 一般對話
    pendingTask.delete(userId)
    await answerWithAI(event, userId, [{ text }])
  } else if (TASKS[command.task].unavailable) {
    // 還沒有實作的功能：直接說明，不假裝處理
    await reply(event, TASKS[command.task].unavailable)
  } else if (command.rest) {
    // 指令後面直接帶文字：直接處理
    pendingTask.delete(userId)
    const instruction = TASKS[command.task].build(command.option)
    await answerWithAI(event, userId, [{ text: `${instruction}\n\n${command.rest}` }])
  } else {
    // 只有指令：等使用者傳圖片或檔案
    setPending(userId, command)
    await reply(
      event,
      `已選擇「${command.task}」，請傳圖片或文字檔給我（或在指令後面直接輸入文字）。`,
      null,
    )
  }
}

const handleMedia = async (event, userId) => {
  const media = await readMedia(event)
  if (media.error) {
    await reply(event, media.error)
    return
  }
  const pending = takePending(userId) || { task: media.defaultTask }
  const instruction = TASKS[pending.task].build(pending.option)
  try {
    await answerWithAI(event, userId, [media.part, { text: instruction }], media.note)
  } catch (error) {
    // 模型拒收這張圖片（格式或內容它讀不了）
    if (media.part.inlineData && error.kind === 'request') {
      throw new UserError('這張圖片模型讀不了，請換一張，或改傳 JPG、PNG。', { cause: error })
    }
    throw error
  }
}

// 聚會中的一輪。tasks 是合併在一起處理的訊息（照收到的順序）
const handlePartyTurn = async (userId, tasks) => {
  // 回覆時用最新那一則的回覆權杖，剩下的有效時間最長
  const { event } = tasks[tasks.length - 1]
  if (isPartyClosing(userId)) {
    console.log(`[聚會 ${event.tag}] 使用者已經結束聚會，略過 ${tasks.length} 則訊息`)
    return
  }
  showLoading(event)
  const turn = await partyReply(
    userId,
    tasks.map((task) => task.event.message.text.trim()),
    {
      deadline: event.ctx.deadline,
      signal: event.ctx.signal,
      turnId: event.ctx.turnId,
      user: event.ctx.user,
    },
  )
  // 生成需要時間，這段期間使用者可能已經結束聚會：送出之前再確認一次，結束了就不發言
  if (!isPartyTurnActive(userId, turn)) {
    console.log(`[聚會 ${event.tag}] 這一輪已經作廢（聚會結束或被取消），不送出訊息`)
    return
  }
  const result = await reply(event, turn.messages, PARTY_BUTTONS)
  // 有送達，成員的發言才寫進聊天紀錄；沒送達只記使用者說的話
  finishPartyTurn(userId, turn, result.ok)
}

const handleEvent = async (event, userId) => {
  const { type } = event.message
  if (type === 'text') {
    await handleText(event, userId, event.message.text.trim())
  } else if (type === 'image' || type === 'audio' || type === 'file') {
    await handleMedia(event, userId)
  } else {
    await reply(event, '我看不懂這種訊息，請傳文字、圖片或文字檔給我。')
  }
}

// ---------- 錯誤處理 ----------
// 把錯誤換成給使用者看的說明（詳細原因寫在日誌裡）
const explain = (error) => {
  if (error instanceof UserError) return error.message
  switch (error?.kind) {
    case 'deadline':
    case 'timeout':
      return 'AI 這次來不及在時限內回覆，請再傳一次。'
    case 'busy':
      return '現在同時使用的人比較多，請稍等一下再傳。'
    case 'unreachable':
    case 'network':
    case 'server':
      return '現在連不上 AI 模型，請稍後再試。'
    default:
      return error?.name === 'TimeoutError'
        ? '查詢資料逾時，請稍後再試。'
        : '處理時發生錯誤，請稍後再試。'
  }
}

const fail = async (event, userId, error) => {
  // 被取消（例如使用者結束了聚會）不算錯誤，也不用回覆
  if (error?.kind === 'cancelled') {
    console.log(`[${event.tag}] 已取消，不回覆`)
    return
  }
  const cause = error instanceof UserError && error.cause ? `（${error.cause.message}）` : ''
  console.error(`[${event.tag}] 處理失敗｜${error?.kind || error?.name}｜${error?.message}${cause}`)
  // 預期之外的錯誤才印出完整內容，方便找問題
  if (!error?.kind && !(error instanceof UserError) && error?.name !== 'TimeoutError') {
    console.error(error)
  }
  await reply(event, explain(error), isInParty(userId) ? PARTY_BUTTONS : DEFAULT_BUTTONS)
}

// ---------- 排隊 ----------
// 同一位使用者的訊息照收到的順序一則一則處理，對話記憶才不會錯亂；不同使用者之間互不等待。
// （AI 模型一次只能服務一個請求，那一層的排隊在 OpenAI.js。）
const mailboxes = new Map() // userId -> 等待處理的訊息（照收到的順序）

const OVERTIME = Symbol('overtime')

// 處理一則訊息。任何錯誤都在這裡接住、記錄並回覆使用者，不讓它卡住後面的訊息
const run = async (event, userId, work) => {
  let timer
  const overtime = new Promise((resolve) => {
    timer = setTimeout(() => resolve(OVERTIME), TASK_LIMIT_MS)
  })
  const job = (async () => {
    try {
      await work()
    } catch (error) {
      try {
        await fail(event, userId, error)
      } catch (second) {
        console.error(`[${event.tag}] 回報錯誤時又發生錯誤`, second)
      }
    }
  })()
  const outcome = await Promise.race([job, overtime])
  clearTimeout(timer)
  if (outcome === OVERTIME) {
    // 每個步驟都有自己的時限，正常不會走到這裡。真的卡住時放棄這一則，讓後面的訊息繼續處理
    console.error(`[${event.tag}] 處理超過 ${TASK_LIMIT_MS}ms 還沒結束，放棄這一則訊息`)
    event.ctx.controller.abort()
  }
}

// 「結束聚會」「聚會」「清除」這幾個指令在聚會中也要照常生效，不會被當成聊天內容
const isControl = (text) => END_PARTY.test(text) || CLEAR_MEMORY.test(text) || text === '聚會'

// 這則訊息是不是聚會中的聊天內容
const isPartyText = (userId, task) => {
  const { type, text } = task.event.message
  return type === 'text' && !isControl(text.trim()) && isInParty(userId)
}

// 每位使用者目前正在處理的那一則排隊訊息（一次只會有一則）
const inProgress = new Map() // userId -> event

const runQueued = async (event, userId, work) => {
  inProgress.set(userId, event)
  try {
    await run(event, userId, work)
  } finally {
    inProgress.delete(userId)
  }
}

const drain = async (userId) => {
  const tasks = mailboxes.get(userId)
  while (tasks.length) {
    if (isPartyText(userId, tasks[0])) {
      // 聚會：稍等一下，把連續傳來的訊息合成一輪，不要每一則都讓三個人各回一次。
      // 上一輪還在生成時傳來的訊息，這時通常已經等超過這段時間，不會再多等。
      const wait = tasks[0].receivedAt + PARTY_MERGE_MS - Date.now()
      if (wait > 0 && !isPartyClosing(userId)) await sleep(wait)
      let count = 1
      while (count < tasks.length && isPartyText(userId, tasks[count])) count += 1
      const batch = tasks.splice(0, count)
      await runQueued(batch[batch.length - 1].event, userId, () => handlePartyTurn(userId, batch))
    } else {
      const { event } = tasks.shift()
      await runQueued(event, userId, () => handleEvent(event, userId))
    }
  }
  // 沒有訊息了就收掉，下次有新訊息再開
  mailboxes.delete(userId)
}

const enqueue = (userId, task) => {
  const tasks = mailboxes.get(userId)
  if (tasks) {
    tasks.push(task)
    return
  }
  mailboxes.set(userId, [task])
  // 不等它跑完：每位使用者各自處理自己的訊息
  drain(userId).catch((error) => {
    console.error(`[u=${maskUser(userId)}] 訊息佇列發生預期之外的錯誤`, error)
    mailboxes.delete(userId)
  })
}

// ---------- 不必排隊的訊息 ----------
// 這則訊息如果排在佇列最後，輪到它的時候使用者會不會在聚會中。
// 佇列裡還沒處理的「聚會」「結束聚會」要算進去，結果才會和「照順序處理」一致。
const willBeInParty = (userId) => {
  const tasks = mailboxes.get(userId) || []
  for (let i = tasks.length - 1; i >= 0; i--) {
    const { type, text } = tasks[i].event.message
    if (type !== 'text') continue
    if (text.trim() === '聚會') return true
    if (END_PARTY.test(text.trim())) return false
  }
  return isInParty(userId) && !isPartyClosing(userId)
}

// 可以收到就處理的訊息：不在聚會中時的 help、匯率、新聞。
// 它們不讀寫對話記憶、不改變聚會狀態，所以不必等同一位使用者前面的 AI 工作做完，
// 也不會影響正在進行的那些工作。聚會進行中的文字照舊都算聊天內容，要排隊交給聚會。
const isQuickEvent = (event, userId) => {
  const { type, text } = event.message
  return type === 'text' && !willBeInParty(userId) && parseQuickCommand(text.trim()) !== null
}

// 快速指令的回覆一送出，聊天室裡的載入動畫就會消失（LINE 的規則：收到新訊息動畫就停）。
// 同一位使用者如果還有訊息在處理，就把動畫補回來，免得看起來像是沒在處理了。
const resumeLoading = (userId) => {
  const current = inProgress.get(userId)
  // 已經在送出回覆的不用補，不然動畫會留在回覆之後
  if (current && !current.replied) showLoading(current)
}

// ---------- 重複的事件 ----------
// LINE 可能把同一個事件送來不只一次（網路問題或重新送達），用事件編號擋掉重複的
const SEEN_TTL_MS = 24 * 60 * 60 * 1000
const seenEvents = new Map() // webhookEventId -> 收到的時間

const isDuplicate = (event) => {
  const id = event.webhookEventId
  if (!id) return false
  if (seenEvents.has(id)) return true
  seenEvents.set(id, Date.now())
  return false
}

// 定期清掉用不到的資料：太久以前的事件編號、過期沒用到的功能選擇
const sweep = (now = Date.now()) => {
  for (const [id, at] of seenEvents) if (now - at > SEEN_TTL_MS) seenEvents.delete(id)
  for (const [userId, entry] of pendingTask) {
    if (now - entry.at > PENDING_TTL_MS) pendingTask.delete(userId)
  }
}
setInterval(sweep, 10 * 60 * 1000).unref()

// ---------- LINE 事件 ----------
// LINE 標示的事件時間和本機收到的時間會有一個差距（網路延遲＋本機時鐘的誤差），正常情況下幾乎固定。
// 拿最近幾則的中位數當基準：比基準多出很多，才算這則訊息真的晚到。
// 如果直接看差距，電腦時鐘快了十幾秒就會每一則都誤報「晚到」。
const LATE_WARNING_MS = 10 * 1000
const CLOCK_NOTICE_MS = 5 * 1000
const recentLags = []
let clockNoticed = false

// 回傳這則訊息比平常晚了多少毫秒
const measureDelay = (event, lag) => {
  if (!Number.isFinite(lag)) return 0
  // 重新送達的事件本來就晚，不拿來當基準
  if (event.deliveryContext?.isRedelivery !== true) {
    recentLags.push(lag)
    if (recentLags.length > 7) recentLags.shift()
  }
  if (!recentLags.length) return lag
  const baseline = [...recentLags].sort((a, b) => a - b)[Math.floor((recentLags.length - 1) / 2)]
  if (!clockNoticed && recentLags.length >= 3 && Math.abs(baseline) > CLOCK_NOTICE_MS) {
    clockNoticed = true
    console.warn(
      `[LINE] 這台電腦的時鐘和 LINE 的事件時間固定相差約 ${Math.round(baseline / 1000)} 秒，時鐘可能不準。回覆期限是用相對時間算的，不受影響。`,
    )
  }
  return lag - baseline
}

// 記下收到的時間、算好期限，並準備日誌用的標記（輪次編號 + 遮罩過的使用者代號）
const prepare = (event, userId) => {
  const now = Date.now()
  const lag = now - event.timestamp
  // 重新送達而且已經太久的事件：回覆權杖不能用了，期限從事件發生的時間算（也就是已經過期）
  event.stale = event.deliveryContext?.isRedelivery === true && lag > REDELIVERY_LIMIT_MS
  const receivedAt = event.stale ? event.timestamp : now
  const controller = new AbortController()
  event.ctx = {
    turnId: randomUUID().slice(0, 8),
    user: maskUser(userId),
    receivedAt,
    deadline: receivedAt + REPLY_LIMIT_MS - SEND_BUFFER_MS, // AI 生成最晚到這個時間
    replyBy: receivedAt + REPLY_LIMIT_MS, // 回覆最晚要在這個時間送出
    controller,
    signal: controller.signal,
  }
  event.tag = `t=${event.ctx.turnId} u=${event.ctx.user}`
  const late = measureDelay(event, lag)
  if (late > LATE_WARNING_MS) {
    console.warn(
      `[LINE ${event.tag}] 這則訊息比平常晚了 ${Math.round(late / 1000)} 秒才送達${event.stale ? '（重新送達的舊事件）' : ''}`,
    )
  }
  return receivedAt
}

bot.on('follow', async (event) => {
  event.tag = `u=${maskUser(event.source?.userId)}`
  try {
    await reply(event, `歡迎加入！\n\n${HELP_TEXT}`)
  } catch (error) {
    console.error(error)
  }
})

bot.on('message', (event) => {
  // 群組裡拿不到個人 ID 時，用群組 ID 當作對話的對象，避免不同來源共用同一份記憶
  const userId = event.source?.userId || event.source?.groupId || event.source?.roomId
  if (!userId) {
    console.warn('[LINE] 收到沒有來源 ID 的訊息，略過')
    return
  }
  if (isDuplicate(event)) {
    console.log(`[LINE u=${maskUser(userId)}] 收到重複的事件，略過`)
    return
  }
  const receivedAt = prepare(event, userId)
  // 「結束聚會」要立刻生效：正在生成的那一輪馬上停下來，不必等它跑完才輪到這則指令
  if (event.message.type === 'text' && END_PARTY.test(event.message.text.trim())) {
    interruptParty(userId)
  }
  // help、匯率、新聞：不排在同一位使用者的 AI 工作後面，收到就處理。
  // 每個事件只會走「立刻處理」或「排隊」其中一條路，所以回覆權杖不會被用兩次。
  if (isQuickEvent(event, userId)) {
    run(event, userId, () => handleEvent(event, userId))
      .then(() => resumeLoading(userId))
      .catch((error) => {
        console.error(`[${event.tag}] 快速指令發生預期之外的錯誤`, error)
      })
    return
  }
  enqueue(userId, { event, receivedAt })
})

// 雲端平台會用環境變數 PORT 指定埠號，本機沒有設定時用 3000
const port = process.env.PORT || 3000
export const server = bot.listen('/', port, () => {
  console.log(`bot 啟動，埠號 ${port}`)
  // 開始接收訊息之後，才在背景把模型載入記憶體；Ollama 還沒開或載入失敗都不影響機器人運作
  warmUp()
})
