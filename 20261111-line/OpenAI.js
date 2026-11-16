// 所有 AI 功能都走本機的 Ollama（OpenAI 相容 API），只處理文字和圖片。
// 可在 .env 調整：
//   OLLAMA_MODEL        使用的模型
//   OLLAMA_BASE_URL     Ollama 的位址
//   OLLAMA_KEEP_ALIVE   模型閒置多久才從記憶體卸載（預設 30m；-1 表示不卸載）
//   OLLAMA_MAX_QUEUE    最多讓幾個請求排隊等模型（預設 8）
//   MEMORY_MAX_CHARS    一次請求裡「對話記憶＋這次的訊息」最多幾個字（預設 6000）
import OpenAI from 'openai'

export const MODEL = process.env.OLLAMA_MODEL || 'qwen3.6:35b-a3b'
const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1'
// Ollama 自己的 API（查模型能力、是否已載入、預載）在同一個位址，只是沒有 /v1
const NATIVE_URL = BASE_URL.replace(/\/v1\/?$/, '')

const envNumber = (name, fallback) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// Ollama 預設閒置 5 分鐘就卸載模型，下次要重新載入 30 秒以上，所以每次請求都要求它留久一點
const KEEP_ALIVE_TEXT = process.env.OLLAMA_KEEP_ALIVE || '30m'
// 純數字（秒數，或 -1）要用數字送出，Ollama 才認得
const KEEP_ALIVE = /^-?\d+$/.test(KEEP_ALIVE_TEXT) ? Number(KEEP_ALIVE_TEXT) : KEEP_ALIVE_TEXT

const DEFAULT_LIMIT_MS = 45 * 1000 // 呼叫端沒給期限時，一次請求最多等多久
const MIN_CALL_MS = envNumber('AI_MIN_CALL_MS', 3 * 1000) // 剩下的時間比這個少，就不值得再呼叫模型
const MAX_WAITING = envNumber('OLLAMA_MAX_QUEUE', 8)

const SYSTEM_PROMPT =
  '你是 LINE 上的助理，請用繁體中文簡潔回答。回覆會顯示在 LINE 聊天室，不支援 Markdown，請用純文字。'

const client = new OpenAI({
  baseURL: BASE_URL,
  // Ollama 不檢查金鑰，但 SDK 要求要有值
  apiKey: 'ollama',
  // 每次請求都會依期限另外指定逾時，這裡只是沒指定時的上限
  timeout: DEFAULT_LIMIT_MS,
  maxRetries: 0,
})

// ---------- 錯誤 ----------
// kind 表示失敗的原因：
//   cancelled   被取消（例如使用者結束了聚會）
//   deadline    已經來不及在期限內完成，沒有呼叫模型
//   busy        排隊等模型的請求太多，沒有呼叫模型
//   timeout     這一次生成超過時間
//   unreachable 連不上 Ollama（沒有啟動）
//   network     連線中途斷掉
//   server      Ollama 內部錯誤（HTTP 5xx、429、408）
//   request     請求被拒絕（HTTP 4xx：參數、圖片或模型名稱有問題）
//   unknown     其他
// 另外帶有 waitMs（排隊等了多久）、ms（生成花了多久）、status（HTTP 狀態碼）。
export class AIError extends Error {
  constructor(kind, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'AIError'
    this.kind = kind
    this.status = cause?.status ?? null
    this.waitMs = 0
    this.ms = 0
  }
}

// 底層的連線錯誤碼（例如 ECONNREFUSED）包在好幾層 cause 裡面
const causeCode = (error) => {
  for (let item = error, depth = 0; item && depth < 5; item = item.cause, depth++) {
    if (typeof item.code === 'string') return item.code
  }
  return null
}

const toAIError = (error) => {
  if (error instanceof AIError) return error
  let kind = 'unknown'
  if (error instanceof OpenAI.APIUserAbortError) kind = 'cancelled'
  else if (error instanceof OpenAI.APIConnectionTimeoutError) kind = 'timeout'
  else if (error instanceof OpenAI.APIConnectionError) {
    kind = causeCode(error) === 'ECONNREFUSED' ? 'unreachable' : 'network'
  } else if (error?.status === 408 || error?.status === 429 || error?.status >= 500) kind = 'server'
  else if (error?.status >= 400) kind = 'request'
  return new AIError(kind, error?.message || String(error), error)
}

// ---------- 排隊 ----------
// Ollama 一次只處理一個請求，所以這裡自己排隊（先到先服務）：
// 才知道每個請求等了多久，也才能讓已經來不及的請求在輪到之前就放棄，不去佔用模型。
let running = false
const waiting = []

const leave = (entry) => {
  const index = waiting.indexOf(entry)
  if (index >= 0) waiting.splice(index, 1)
  clearTimeout(entry.timer)
  entry.signal?.removeEventListener('abort', entry.onAbort)
}

// 等到輪到自己。latest 是「最晚要在這個時間點之前輪到」，等超過了就放棄。
const enter = ({ latest, signal }) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AIError('cancelled', '已取消，沒有呼叫模型'))
    if (Date.now() > latest) {
      return reject(new AIError('deadline', '剩下的時間不夠，沒有呼叫模型'))
    }
    if (!running) {
      running = true
      return resolve()
    }
    if (waiting.length >= MAX_WAITING) {
      return reject(new AIError('busy', `已經有 ${waiting.length} 個請求在排隊，沒有呼叫模型`))
    }
    const entry = { resolve, signal }
    entry.timer = setTimeout(() => {
      leave(entry)
      reject(new AIError('deadline', '排隊等到來不及了，沒有呼叫模型'))
    }, latest - Date.now())
    entry.onAbort = () => {
      leave(entry)
      reject(new AIError('cancelled', '排隊時被取消，沒有呼叫模型'))
    }
    signal?.addEventListener('abort', entry.onAbort, { once: true })
    waiting.push(entry)
  })

// 做完了，換下一個
const exit = () => {
  const next = waiting.shift()
  if (!next) {
    running = false
    return
  }
  clearTimeout(next.timer)
  next.signal?.removeEventListener('abort', next.onAbort)
  next.resolve()
}

// ---------- 模型能力與載入狀態 ----------
const nativeFetch = (path, body, timeoutMs) =>
  fetch(`${NATIVE_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })

// 模型的能力，例如 ['completion', 'vision', 'tools', 'thinking']；還沒查到是 null
let capabilities = null
let capabilityCheck = null
let capabilityCheckedAt = 0
const CAPABILITY_RETRY_MS = 60 * 1000 // 查不到時隔多久再查一次

const loadCapabilities = () => {
  if (capabilities || Date.now() - capabilityCheckedAt < CAPABILITY_RETRY_MS) return capabilities
  if (capabilityCheck) return capabilityCheck
  capabilityCheck = (async () => {
    try {
      const res = await nativeFetch('/api/show', { model: MODEL }, 3000)
      const data = await res.json().catch(() => ({}))
      if (res.ok && Array.isArray(data.capabilities)) {
        capabilities = data.capabilities
        console.log(`[AI] 模型 ${MODEL} 的能力：${capabilities.join('、')}`)
      } else {
        console.warn(
          `[AI] 查不到模型 ${MODEL} 的能力（HTTP ${res.status}${data.error ? `：${data.error}` : ''}），先當作都支援`,
        )
      }
    } catch (error) {
      console.warn(`[AI] 查不到模型 ${MODEL} 的能力（${error.message}），先當作都支援`)
    }
    capabilityCheckedAt = Date.now()
    capabilityCheck = null
    return capabilities
  })()
  return capabilityCheck
}

// 模型支不支援某項能力：true／false；查不到時是 null（由呼叫端決定要不要試）
const supports = async (feature) => {
  const list = await loadCapabilities()
  return list ? list.includes(feature) : null
}

const withTag = (name) => (name.includes(':') ? name : `${name}:latest`)

// 模型是不是已經載入記憶體：true／false；查不到時是 null。
// 還在載入中的模型不會出現在清單裡，所以 false 也可能是「正在載入」。
export const isModelLoaded = async () => {
  try {
    const res = await nativeFetch('/api/ps', null, 1500)
    if (!res.ok) return null
    const data = await res.json()
    return (data.models || []).some(
      (item) => withTag(item.name || item.model || '') === withTag(MODEL),
    )
  } catch {
    return null
  }
}

// 啟動後在背景把模型載入記憶體。Ollama 還沒開或載入失敗只記錄下來，不影響機器人運作
// （之後第一則訊息會自己觸發載入，只是比較慢）。
const WARM_UP_LIMIT_MS = 3 * 60 * 1000
export const warmUp = async () => {
  const startedAt = Date.now()
  try {
    await loadCapabilities()
    // 不帶提示詞的請求只會載入模型，不會生成任何內容
    const res = await nativeFetch(
      '/api/generate',
      { model: MODEL, keep_alive: KEEP_ALIVE },
      WARM_UP_LIMIT_MS,
    )
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
    console.log(
      `[AI] 模型 ${MODEL} 已載入（${Date.now() - startedAt}ms），閒置 ${KEEP_ALIVE_TEXT} 後才會卸載`,
    )
    return true
  } catch (error) {
    const reason = causeCode(error) === 'ECONNREFUSED' ? 'Ollama 沒有啟動' : error.message
    console.warn(
      `[AI] 預載模型 ${MODEL} 失敗（${reason}）。機器人照常運作，之後第一則訊息會觸發載入、等比較久。`,
    )
    return false
  }
}

// ---------- 送出請求 ----------
// 送出一次請求，回傳 { text, model, usage, finish, waitMs, ms }；失敗時丟出 AIError。
//   deadline   這次生成最晚要在什麼時候結束（絕對時間）。排隊等待的時間也算在裡面。
//   timeoutMs  單次生成最多多久，從「輪到」開始算，而且不會超過 deadline。
//   signal     取消用（排隊中或生成中都會停下來）。
//   minMs      輪到時剩下的時間少於這個數字，就不呼叫模型。
//   maxTokens  輸出上限；extra 是其他請求參數。
const complete = async (
  messages,
  { extra = {}, maxTokens, timeoutMs, deadline, signal, minMs = MIN_CALL_MS } = {},
) => {
  const limit = deadline ?? Date.now() + DEFAULT_LIMIT_MS
  // 會思考的模型要關掉思考（開著的話一則簡單問答要等 10 秒以上）；不會思考的模型就不送這個參數
  const thinking = await supports('thinking')
  const queuedAt = Date.now()
  try {
    await enter({ latest: limit - minMs, signal })
  } catch (error) {
    error.waitMs = Date.now() - queuedAt
    throw error
  }
  const startedAt = Date.now()
  const waitMs = startedAt - queuedAt
  try {
    const completion = await client.chat.completions.create(
      {
        model: MODEL,
        messages,
        ...(thinking === false ? {} : { reasoning_effort: 'none' }),
        keep_alive: KEEP_ALIVE,
        ...extra,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      },
      { timeout: Math.max(1, Math.min(timeoutMs ?? Infinity, limit - startedAt)), signal },
    )
    return {
      text: completion.choices[0]?.message?.content?.trim() || '',
      model: MODEL,
      usage: {
        input: completion.usage?.prompt_tokens ?? null,
        output: completion.usage?.completion_tokens ?? null,
      },
      finish: completion.choices[0]?.finish_reason ?? null,
      waitMs,
      ms: Date.now() - startedAt,
    }
  } catch (error) {
    const failure = toAIError(error)
    failure.waitMs = waitMs
    failure.ms = Date.now() - startedAt
    throw failure
  } finally {
    exit()
  }
}

// 一次請求的日誌：只記時間和用量，不記內容
const logCall = (tag, result) =>
  console.log(
    `[對話${tag ? ` ${tag}` : ''}] ${result.model}｜排隊 ${result.waitMs}ms｜生成 ${result.ms}ms｜輸入 ${result.usage.input} / 輸出 ${result.usage.output} tokens${result.finish === 'length' ? '｜輸出被截斷' : ''}`,
  )

const logFailure = (tag, error) =>
  console.warn(
    `[對話${tag ? ` ${tag}` : ''}] ${MODEL}｜排隊 ${error.waitMs}ms｜生成 ${error.ms}ms｜失敗：${error.kind}（${error.message}）`,
  )

// ---------- 單次生成（不讀也不寫對話記憶） ----------
// options 可帶 deadline、timeoutMs、signal（說明見 complete），tag 是日誌用的標記
export const generate = async (text, { tag, ...options } = {}) => {
  try {
    const result = await complete(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      options,
    )
    logCall(tag, result)
    return result.text
  } catch (error) {
    logFailure(tag, error)
    throw error
  }
}

// 呼叫端的 schema 型別是大寫（'ARRAY'），JSON Schema 要小寫；propertyOrdering 不是 JSON Schema 的欄位
const toJsonSchema = (schema) => {
  const result = { ...schema }
  if (typeof schema.type === 'string') result.type = schema.type.toLowerCase()
  delete result.propertyOrdering
  if (schema.items) result.items = toJsonSchema(schema.items)
  if (schema.properties) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toJsonSchema(value)]),
    )
  }
  return result
}

// 單次生成並要求照 schema 輸出 JSON，回傳 { data, model, usage, finish, waitMs, ms }；
// 輸出無法解析時 data 為 null。可用 maxTokens 限制輸出長度，
// deadline、timeoutMs、signal、minMs 控制時間（說明見 complete）。
export const generateJsonDetailed = async (
  text,
  { system, schema, maxTokens, timeoutMs, deadline, signal, minMs },
) => {
  const result = await complete(
    [
      { role: 'system', content: `${system}\n\n請輸出 JSON 物件，內容放在 result 欄位。` },
      { role: 'user', content: text },
    ],
    {
      timeoutMs,
      deadline,
      signal,
      minMs,
      maxTokens,
      extra: {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'result',
            strict: true,
            // 最外層固定包成物件，裡面的 result 才是呼叫端要的內容
            schema: {
              type: 'object',
              properties: { result: toJsonSchema(schema) },
              required: ['result'],
            },
          },
        },
      },
    },
  )
  let data = null
  try {
    data = JSON.parse(result.text).result ?? null
  } catch {
    // 輸出被截斷或不是合法 JSON：data 維持 null，由呼叫端決定要不要重試
  }
  return { ...result, data }
}

// 同上，但只回傳解析後的結果
export const generateJson = async (text, options) =>
  (await generateJsonDetailed(text, options)).data

// Ollama 只接受這幾種圖片標示；其他它讀得懂的格式（GIF、BMP）要標成 jpeg 才會收，內容它會自己判斷
const IMAGE_LABELS = ['image/jpeg', 'image/png', 'image/webp']

// index.js 傳進來的 part 是 { text } 或 { inlineData: { mimeType, data } }，這裡轉成 OpenAI 格式
const toContent = (parts) =>
  parts.map((part) => {
    if (!part.inlineData) return { type: 'text', text: part.text }
    const { mimeType, data } = part.inlineData
    const label = IMAGE_LABELS.includes(mimeType) ? mimeType : 'image/jpeg'
    return { type: 'image_url', image_url: { url: `data:${label};base64,${data}` } }
  })

const isImage = (part) => part.inlineData?.mimeType.startsWith('image/')
const hasMedia = (parts) => parts.some((part) => part.inlineData)

// ---------- 對話記憶 ----------
// 每位使用者各自一份，保留最近 10 則訊息（5 組問答）。
// 這是「一般對話」的記憶，和聚會的聊天紀錄（party.js）完全分開。
const MAX_HISTORY = 10
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000 // 這麼久沒對話就忘記
const IMAGE_TURNS = 3 // 圖片最多跟著幾次追問一起送給模型
const IMAGE_TTL_MS = 10 * 60 * 1000 // 圖片最多留多久
const NO_REPLY = '（這則訊息沒有成功回覆）'

// userId -> { messages, updatedAt, image: { turnsLeft, expiresAt } | null, fresh }
const histories = new Map()

// 把記憶裡的圖片換成文字佔位，之後的請求就不會再重送
const stripMedia = (messages, placeholder = '（先前傳送的圖片已省略）') =>
  messages.map((item) =>
    Array.isArray(item.content)
      ? {
          ...item,
          content: item.content.map((c) =>
            c.type === 'image_url' ? { type: 'text', text: placeholder } : c,
          ),
        }
      : item,
  )

// 一次請求裡「對話記憶＋這次的訊息」的總長度上限（可用 .env 的 MEMORY_MAX_CHARS 調整）。
// 模型讀多久看的是 token：數字表格這類內容每個字約 1 個 token；讀取速度平常每秒約 500 個，
// 但實測過有一段時間只剩一半。6,000 字在慢的時候約 23 秒讀完，加上輸出約 10 秒，
// 離 48 秒的生成期限還有 15 秒左右（10,000 字在慢的那段時間實測 46 秒，幾乎沒有餘裕）。
// 記憶太長時（例如連續傳了幾個長檔案），從最舊的對話開始捨棄。
const MAX_PROMPT_CHARS = envNumber('MEMORY_MAX_CHARS', 6000)
// 圖片沒有字數，但模型重新看一次要 15 秒左右（實測），不能和長篇文字一起送。
// 算長度時把一張圖當成上限的一半：後面的對話累積超過另一半，圖片那一輪就會被捨棄
const IMAGE_COST_CHARS = Math.floor(MAX_PROMPT_CHARS / 2)

const lengthOf = (message) =>
  typeof message.content === 'string'
    ? message.content.length
    : message.content.reduce(
        (sum, part) => sum + (part.type === 'text' ? part.text.length : IMAGE_COST_CHARS),
        0,
      )

// 回傳放得下的那一段記憶（保留最新的）
const fitHistory = (messages, userMessage) => {
  let total = messages.reduce((sum, message) => sum + lengthOf(message), lengthOf(userMessage))
  let start = 0
  while (start < messages.length && total > MAX_PROMPT_CHARS) {
    total -= lengthOf(messages[start])
    start += 1
  }
  // 從使用者的訊息開始留，不要讓記憶的第一則是沒頭沒尾的回答
  while (start < messages.length && messages[start].role !== 'user') start += 1
  return start ? messages.slice(start) : messages
}

// 沒有成功回答時，使用者那則訊息在記憶裡最多留這麼多字。
// 很長的內容（例如文字檔）如果整份留著，之後每一句話都得連它一起重讀，會一直很慢甚至逾時。
const FAILED_KEEP_CHARS = 500

// 把沒有成功回答的訊息整理成可以留在記憶裡的樣子：
// 圖片換成一句說明（免得有問題的圖片害之後每次請求都失敗），太長的文字只留開頭
const forMemory = (message) => ({
  ...message,
  content: message.content.map((part) => {
    if (part.type === 'image_url') {
      return { type: 'text', text: '（使用者傳了一張圖片，但沒有處理成功）' }
    }
    if (part.text.length <= FAILED_KEEP_CHARS) return part
    return {
      type: 'text',
      text: `${part.text.slice(0, FAILED_KEEP_CHARS)}…（這則內容共 ${part.text.length.toLocaleString('en-US')} 字，沒有處理成功，後面省略）`,
    }
  }),
})

// 取出某位使用者的記憶；圖片的追問次數或保留時間到了，就順手把它拿掉
const getState = (userId) => {
  const state = histories.get(userId)
  if (!state || Date.now() - state.updatedAt > HISTORY_TTL_MS) return { messages: [], image: null }
  if (state.image && (state.image.turnsLeft <= 0 || Date.now() > state.image.expiresAt)) {
    return { messages: stripMedia(state.messages), image: null }
  }
  return state
}

// 把一組問答寫進記憶。同一位使用者的訊息是排隊一則一則處理的（見 index.js），所以這裡不會同時寫入
const remember = (userId, previous, userMessage, answer, image) => {
  histories.set(userId, {
    messages: [...previous, userMessage, { role: 'assistant', content: answer }].slice(
      -MAX_HISTORY,
    ),
    updatedAt: Date.now(),
    image,
    // 這一則回答還沒確認有送到使用者手上（見 markUndelivered）
    fresh: answer !== NO_REPLY,
  })
}

export const clearHistory = (userId) => histories.delete(userId)

// LINE 沒有把回答送達時呼叫：使用者沒看到那則回答，記憶裡就不能當作說過
export const markUndelivered = (userId) => {
  const state = histories.get(userId)
  if (!state?.fresh) return false
  state.fresh = false
  state.messages = [...state.messages.slice(0, -1), { role: 'assistant', content: NO_REPLY }]
  return true
}

// 清掉太久沒對話的記憶，免得越積越多
export const sweepHistories = (now = Date.now()) => {
  for (const [userId, state] of histories) {
    if (now - state.updatedAt > HISTORY_TTL_MS) histories.delete(userId)
  }
  return histories.size
}
setInterval(sweepHistories, 10 * 60 * 1000).unref()

// parts 可包含文字與圖片；會帶上該使用者的歷史對話。
// options：deadline、signal（說明見 complete），tag 是日誌用的標記。
export const askAI = async (userId, parts, { tag, ...options } = {}) => {
  const stored = histories.get(userId)
  if (stored) stored.fresh = false
  if (parts.some((part) => part.inlineData && !isImage(part))) {
    return '目前的 AI 模型只能讀文字和圖片，語音和 PDF 無法處理。'
  }
  const withImage = hasMedia(parts)
  if (withImage && (await supports('vision')) === false) {
    return `目前使用的模型（${MODEL}）看不懂圖片，請改用文字描述。`
  }

  const state = getState(userId)
  const userMessage = { role: 'user', content: toContent(parts) }
  // 新傳了圖片：舊圖片換成文字佔位，只留最新一張（這次請求也不再重送舊圖片）。
  // 記憶太長的話，只留放得下的最新那一段
  const previous = fitHistory(withImage ? stripMedia(state.messages) : state.messages, userMessage)
  // 沒有成功回答時要記下來的版本：圖片不留，太長的文字只留開頭
  const unanswered = forMemory(userMessage)
  const keptImage = withImage ? null : state.image

  let result
  try {
    result = await complete(
      [{ role: 'system', content: SYSTEM_PROMPT }, ...previous, userMessage],
      options,
    )
  } catch (error) {
    logFailure(tag, error)
    // 被取消的不用記。其他失敗要把使用者說的話留在記憶裡，下一句才接得上
    if (error.kind !== 'cancelled') remember(userId, previous, unanswered, NO_REPLY, keptImage)
    throw error
  }
  logCall(tag, result)
  if (!result.text) {
    remember(userId, previous, unanswered, NO_REPLY, keptImage)
    return '我不知道怎麼回答'
  }
  remember(
    userId,
    previous,
    userMessage,
    result.text,
    withImage
      ? { turnsLeft: IMAGE_TURNS, expiresAt: Date.now() + IMAGE_TTL_MS }
      : state.image && { ...state.image, turnsLeft: state.image.turnsLeft - 1 },
  )
  return result.text
}
