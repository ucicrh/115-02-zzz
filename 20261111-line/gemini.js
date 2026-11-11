// Gemini API：一般生成與帶對話記憶的問答
// 免費方案每個模型各有每日額度（例如 gemini-2.5-flash 一天只有 20 次），
// 所以依序嘗試多個模型：前一個額度用完或已下架，就自動換下一個。
// 可在 .env 用 GEMINI_MODEL 指定，多個模型以逗號分隔。
const MODELS = (
  process.env.GEMINI_MODEL ||
  'gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.8-flash,gemini-flash-latest,gemini-2.5-flash'
)
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean)

const SYSTEM_PROMPT =
  '你是 LINE 上的助理，請用繁體中文簡潔回答。回覆會顯示在 LINE 聊天室，不支援 Markdown，請用純文字。'

// 所有模型的額度都用完時丟出，讓呼叫端能顯示對應的訊息
export class QuotaError extends Error {}

// 額度用完的模型先跳過一段時間，不要每次都重試
const SKIP_MS = 10 * 60 * 1000
const skipUntil = new Map()

// 模型有時會卡住不回應，單次最多等這麼久就換下一個
const TIMEOUT_MS = 15 * 1000
// LINE 的回覆權杖約一分鐘後失效，整體超過這個時間就不再嘗試
const TOTAL_MS = 50 * 1000
// 429 額度用完、404 模型已下架、5xx 伺服器忙碌：換下一個模型；其他錯誤直接回報
const RETRY_STATUS = [429, 404, 500, 502, 503, 504]

// options.system 可換掉預設的系統提示；options.generationConfig 可要求 JSON 輸出等
const request = async (contents, options = {}) => {
  const startedAt = Date.now()
  const available = MODELS.filter((model) => (skipUntil.get(model) || 0) < Date.now())
  let lastError = ''
  let quotaOnly = true
  // 全部都在冷卻中時還是全部試一次，額度可能已經恢復
  for (const model of available.length ? available : MODELS) {
    const remaining = TOTAL_MS - (Date.now() - startedAt)
    if (remaining <= 0) break
    let res
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, remaining)),
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: options.system || SYSTEM_PROMPT }] },
            contents,
            ...(options.generationConfig ? { generationConfig: options.generationConfig } : {}),
          }),
        },
      )
    } catch (error) {
      // 逾時或連線失敗
      lastError = `Gemini ${model} 沒有回應：${error.message}`
      quotaOnly = false
      console.warn(`${model} 沒有回應，改用下一個模型`)
      skipUntil.set(model, Date.now() + SKIP_MS)
      continue
    }
    if (res.ok) {
      const data = await res.json()
      return (
        data.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || '')
          .join('')
          .trim() || ''
      )
    }
    lastError = `Gemini ${model} ${res.status}: ${await res.text()}`
    if (!RETRY_STATUS.includes(res.status)) throw new Error(lastError)
    if (res.status !== 429) quotaOnly = false
    console.warn(`${model} 無法使用（${res.status}），改用下一個模型`)
    skipUntil.set(model, Date.now() + SKIP_MS)
  }
  // 只有「全部都是額度用完」才算額度問題，其餘當成一般錯誤
  if (quotaOnly && lastError) throw new QuotaError(lastError)
  throw new Error(lastError || 'Gemini 沒有可用的模型')
}

// 單次生成，不讀也不寫對話記憶
export const generate = (text) => request([{ role: 'user', parts: [{ text }] }])

// 單次生成並要求照 schema 輸出 JSON，回傳解析後的結果；解析失敗回傳 null
export const generateJson = async (text, { system, schema }) => {
  const answer = await request([{ role: 'user', parts: [{ text }] }], {
    system,
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
  })
  try {
    return JSON.parse(answer)
  } catch {
    return null
  }
}

// ---------- 對話記憶 ----------
// 每位使用者保留最近 10 則訊息（5 組問答），格式即 Gemini 的 contents
const MAX_HISTORY = 10
const histories = new Map()

const getHistory = (userId) => histories.get(userId) || []

const hasMedia = (parts) => parts.some((p) => p.inlineData)

// 只保留「最新一份」圖片／語音／檔案，舊的換成文字佔位，避免每次請求越來越大
const stripMedia = (history) =>
  history.map((item) =>
    hasMedia(item.parts)
      ? {
          ...item,
          parts: item.parts.map((p) => (p.inlineData ? { text: '（先前傳送的檔案已省略）' } : p)),
        }
      : item,
  )

const saveHistory = (userId, userParts, answer) => {
  const previous = hasMedia(userParts) ? stripMedia(getHistory(userId)) : getHistory(userId)
  histories.set(
    userId,
    [
      ...previous,
      { role: 'user', parts: userParts },
      { role: 'model', parts: [{ text: answer }] },
    ].slice(-MAX_HISTORY),
  )
}

export const clearHistory = (userId) => histories.delete(userId)

// parts 為 Gemini 的內容陣列，可包含文字、圖片、語音、PDF；會帶上該使用者的歷史對話
export const askGemini = async (userId, parts) => {
  const answer = await request([...getHistory(userId), { role: 'user', parts }])
  if (!answer) return '我不知道怎麼回答'
  saveHistory(userId, parts, answer)
  return answer
}
