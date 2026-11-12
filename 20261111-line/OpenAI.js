// 所有 AI 功能都走本機的 Ollama（OpenAI 相容 API），只處理文字和圖片。
// 可在 .env 用 OLLAMA_MODEL 換模型、OLLAMA_BASE_URL 換位址。
import OpenAI from 'openai'

const MODEL = process.env.OLLAMA_MODEL || 'qwen3.6:35b-a3b'

const SYSTEM_PROMPT =
  '你是 LINE 上的助理，請用繁體中文簡潔回答。回覆會顯示在 LINE 聊天室，不支援 Markdown，請用純文字。'

const client = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
  // Ollama 不檢查金鑰，但 SDK 要求要有值
  apiKey: 'ollama',
  // LINE 的回覆權杖約一分鐘後失效
  timeout: 50 * 1000,
  maxRetries: 0,
})

// 送出一次請求，回傳 { text, model, usage }。
// options.timeoutMs：這次請求最多等多久；options.maxTokens：輸出上限；options.extra：其他請求參數
const complete = async (messages, { extra = {}, timeoutMs, maxTokens } = {}) => {
  const completion = await client.chat.completions.create(
    {
      model: MODEL,
      messages,
      // 關掉思考：開著的話一則簡單問答要等 10 秒以上
      reasoning_effort: 'none',
      ...extra,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    },
    timeoutMs ? { timeout: timeoutMs } : undefined,
  )
  return {
    text: completion.choices[0]?.message?.content?.trim() || '',
    model: MODEL,
    usage: {
      input: completion.usage?.prompt_tokens ?? null,
      output: completion.usage?.completion_tokens ?? null,
    },
  }
}

// ---------- 單次生成（不讀也不寫對話記憶） ----------
export const generate = async (text) => {
  const result = await complete([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: text },
  ])
  return result.text
}

// 呼叫端的 schema 型別是大寫（'ARRAY'），JSON Schema 要小寫；propertyOrdering 不是 JSON Schema 的欄位
const toJsonSchema = (schema) => {
  const result = { ...schema, type: schema.type.toLowerCase() }
  delete result.propertyOrdering
  if (schema.items) result.items = toJsonSchema(schema.items)
  if (schema.properties) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toJsonSchema(value)]),
    )
  }
  return result
}

// 單次生成並要求照 schema 輸出 JSON，回傳 { data, model, usage }；解析失敗時 data 為 null。
// 可用 maxTokens 限制輸出長度、timeoutMs 限制等待時間。
export const generateJsonDetailed = async (text, { system, schema, maxTokens, timeoutMs }) => {
  const result = await complete(
    [
      { role: 'system', content: `${system}\n\n請輸出 JSON 物件，內容放在 result 欄位。` },
      { role: 'user', content: text },
    ],
    {
      timeoutMs,
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
    // 輸出被截斷或不是合法 JSON
  }
  return { data, model: result.model, usage: result.usage }
}

// 同上，但只回傳解析後的結果
export const generateJson = async (text, options) =>
  (await generateJsonDetailed(text, options)).data

// index.js 傳進來的 part 是 { text } 或 { inlineData: { mimeType, data } }，這裡轉成 OpenAI 格式
const toContent = (parts) =>
  parts.map((part) => {
    if (!part.inlineData) return { type: 'text', text: part.text }
    const { mimeType, data } = part.inlineData
    return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }
  })

const isImage = (part) => part.inlineData?.mimeType.startsWith('image/')
const hasMedia = (parts) => parts.some((part) => part.inlineData)

// ---------- 對話記憶 ----------
// 每位使用者保留最近 10 則訊息（5 組問答）
const MAX_HISTORY = 10
const histories = new Map()

const getHistory = (userId) => histories.get(userId) || []

// 只保留「最新一張」圖片，舊的換成文字佔位，避免每次請求越來越大
const stripMedia = (history) =>
  history.map((item) =>
    Array.isArray(item.content)
      ? {
          ...item,
          content: item.content.map((c) =>
            c.type === 'image_url' ? { type: 'text', text: '（先前傳送的圖片已省略）' } : c,
          ),
        }
      : item,
  )

export const clearHistory = (userId) => histories.delete(userId)

// parts 可包含文字與圖片；會帶上該使用者的歷史對話
export const askAI = async (userId, parts) => {
  if (parts.some((part) => part.inlineData && !isImage(part))) {
    return '目前的 AI 模型只能讀文字和圖片，語音和 PDF 無法處理。'
  }
  const userMessage = { role: 'user', content: toContent(parts) }
  const { text: answer } = await complete([
    { role: 'system', content: SYSTEM_PROMPT },
    ...getHistory(userId),
    userMessage,
  ])
  if (!answer) return '我不知道怎麼回答'
  const previous = hasMedia(parts) ? stripMedia(getHistory(userId)) : getHistory(userId)
  histories.set(
    userId,
    [...previous, userMessage, { role: 'assistant', content: answer }].slice(-MAX_HISTORY),
  )
  return answer
}
