// Gemini API：一般生成與帶對話記憶的問答
// 免費方案每個模型各有每日額度（例如 gemini-2.5-flash 一天只有 20 次），
// 所以依序嘗試多個模型：前一個額度用完或已下架，就自動換下一個。
// 可在 .env 用 GEMINI_MODEL 指定，多個模型以逗號分隔。
const MODELS = (
  process.env.GEMINI_MODEL ||
  'gemini-3.8-flash,gemini-flash-latest,gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-2.5-flash'
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

const request = async (contents) => {
  const available = MODELS.filter((model) => (skipUntil.get(model) || 0) < Date.now())
  let lastError = ''
  // 全部都在冷卻中時還是全部試一次，額度可能已經恢復
  for (const model of available.length ? available : MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
        }),
      },
    )
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
    // 429 額度用完、404 模型已下架：換下一個模型；其他錯誤直接回報
    if (res.status !== 429 && res.status !== 404) throw new Error(lastError)
    console.warn(`${model} 無法使用（${res.status}），改用下一個模型`)
    skipUntil.set(model, Date.now() + SKIP_MS)
  }
  throw new QuotaError(lastError)
}

// 單次生成，不讀也不寫對話記憶
export const generate = (text) => request([{ role: 'user', parts: [{ text }] }])

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
