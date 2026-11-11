import 'dotenv/config'
import linebot from 'linebot'
import { askGemini, clearHistory, QuotaError } from './gemini.js'
import { TASKS, HELP_TEXT, parseCommand } from './commands.js'
import { getWeather, getWeatherByCoords, getRates, parseRateQuery, getNews } from './services.js'
import { weatherCard, rateOverviewCard, rateConvertCard, newsCard } from './flex.js'

const bot = linebot({
  channelId: process.env.CHANNEL_ID,
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
})

// ---------- 回覆 ----------
const messageButton = (label, text = label) => ({
  type: 'action',
  action: { type: 'message', label, text },
})

const DEFAULT_BUTTONS = ['OCR', '翻譯', '解題', '摘要', '改寫', '天氣', '匯率', '新聞', 'help'].map(
  (label) => messageButton(label),
)

// messages 可以是字串、訊息物件或陣列；快速按鈕會掛在最後一則訊息下方
const reply = (event, messages, buttons = DEFAULT_BUTTONS) => {
  const list = [messages].flat().map((message) =>
    // LINE 單則文字上限 5000 字
    typeof message === 'string' ? { type: 'text', text: message.slice(0, 5000) } : message,
  )
  if (buttons?.length) list[list.length - 1].quickReply = { items: buttons }
  return event.reply(list)
}

// ---------- 天氣、匯率、新聞 ----------
// 穿著與帶傘建議用規則產生，不呼叫 AI，省下免費額度
const adviseWeather = ({ current, days }) => {
  const today = days[0]
  const feels = current.feelsLike
  let clothing = '天氣炎熱，穿短袖並注意防曬、多補充水分。'
  if (feels < 12) clothing = '天氣寒冷，建議穿厚外套。'
  else if (feels < 18) clothing = '有點涼，建議穿外套。'
  else if (feels < 24) clothing = '氣溫舒適，薄長袖或加件薄外套就可以。'
  else if (feels < 29) clothing = '天氣溫暖，穿短袖即可。'

  let umbrella = '降雨機率低，不用帶傘。'
  if (today.rainChance >= 60) umbrella = '降雨機率高，出門記得帶傘。'
  else if (today.rainChance >= 30) umbrella = '可能會下雨，建議帶把傘備用。'

  const gap = today.max - today.min >= 8 ? '早晚溫差大，留意保暖。' : ''
  return `${clothing}${umbrella}${gap}`
}

const replyWeather = async (event, weather) => {
  if (!weather) {
    await reply(event, '找不到這個地點，請換個寫法試試，例如「天氣 台北」。')
    return
  }
  await reply(event, weatherCard(weather, adviseWeather(weather)))
}

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

// ---------- 圖片、語音、檔案 ----------
const MAX_FILE_SIZE = 15 * 1024 * 1024
const MAX_TEXT_LENGTH = 200000
const TEXT_EXTENSIONS = ['txt', 'md', 'csv', 'json', 'log', 'html', 'xml']

const inlinePart = async (event, mimeType) => {
  const buffer = await event.message.content()
  return { inlineData: { mimeType, data: buffer.toString('base64') } }
}

// 把訊息內容轉成 Gemini 的 part，並決定沒選功能時的預設功能；不支援時回傳 { error }
const readMedia = async (event) => {
  const { type, fileName = '', fileSize = 0 } = event.message
  if (type === 'image') {
    return { part: await inlinePart(event, 'image/jpeg'), defaultTask: '描述' }
  }
  if (type === 'audio') {
    // LINE 的語音訊息是 m4a
    return { part: await inlinePart(event, 'audio/mp4'), defaultTask: '逐字稿' }
  }
  const extension = fileName.split('.').pop().toLowerCase()
  if (extension !== 'pdf' && !TEXT_EXTENSIONS.includes(extension)) {
    return { error: `目前只能讀 PDF 和文字檔（${TEXT_EXTENSIONS.join('、')}）。` }
  }
  if (fileSize > MAX_FILE_SIZE) {
    return { error: '檔案太大了，請傳 15MB 以內的檔案。' }
  }
  if (extension === 'pdf') {
    return { part: await inlinePart(event, 'application/pdf'), defaultTask: '摘要' }
  }
  const content = (await event.message.content()).toString('utf8').slice(0, MAX_TEXT_LENGTH)
  return { part: { text: `檔案「${fileName}」的內容：\n\n${content}` }, defaultTask: '摘要' }
}

// ---------- 事件處理 ----------
// 記錄使用者選了哪個功能，下一則圖片／語音／檔案會套用（用完即重置）
const pendingTask = new Map()

const NOT_A_PLACE = /今天|明天|後天|現在|最近|這幾天|什麼|如何|怎樣|怎麼|好|嗎/

const handleText = async (event, userId, text) => {
  if (/^(help|說明|幫助|\?|？)$/i.test(text)) {
    await reply(event, HELP_TEXT)
    return
  }
  if (/^(清除|重置|reset)$/i.test(text)) {
    clearHistory(userId)
    pendingTask.delete(userId)
    await reply(event, '已清除之前的對話記憶。')
    return
  }

  // 「天氣」「天氣 台北」「台北天氣」
  const weatherMatch = text.match(/^天氣(?:\s+(.+))?$/) || text.match(/^()(.{1,10}?)的?天氣$/)
  const place = weatherMatch && (weatherMatch[1] || weatherMatch[2] || '')
  if (weatherMatch && !place) {
    await reply(event, '想查哪裡的天氣？請輸入「天氣 城市」，或按下方按鈕傳送位置。', [
      { type: 'action', action: { type: 'location', label: '傳送我的位置' } },
      ...['台北', '台中', '高雄'].map((city) => messageButton(city, `天氣 ${city}`)),
    ])
    return
  }
  if (place && !(weatherMatch[2] && NOT_A_PLACE.test(place))) {
    await replyWeather(event, await getWeather(place))
    return
  }

  const rateMatch = text.match(/^匯率(?:\s+(.+))?$/)
  if (rateMatch) {
    await replyRate(event, rateMatch[1] || '')
    return
  }

  const newsMatch = text.match(/^新聞(?:\s+(.+))?$/)
  if (newsMatch) {
    await replyNews(event, newsMatch[1] || '')
    return
  }

  const command = parseCommand(text)
  if (!command) {
    // 一般對話
    pendingTask.delete(userId)
    await reply(event, await askGemini(userId, [{ text }]))
  } else if (command.rest) {
    // 指令後面直接帶文字：直接處理
    pendingTask.delete(userId)
    const instruction = TASKS[command.task].build(command.option)
    await reply(event, await askGemini(userId, [{ text: `${instruction}\n\n${command.rest}` }]))
  } else {
    // 只有指令：等使用者傳圖片、語音或檔案
    pendingTask.set(userId, command)
    await reply(
      event,
      `已選擇「${command.task}」，請傳圖片、語音或 PDF 給我（或在指令後面直接輸入文字）。`,
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
  const pending = pendingTask.get(userId) || { task: media.defaultTask }
  pendingTask.delete(userId)
  const instruction = TASKS[pending.task].build(pending.option)
  await reply(event, await askGemini(userId, [media.part, { text: instruction }]))
}

bot.on('follow', async (event) => {
  try {
    await reply(event, `歡迎加入！\n\n${HELP_TEXT}`)
  } catch (error) {
    console.error(error)
  }
})

bot.on('message', async (event) => {
  const userId = event.source.userId
  const { type } = event.message
  try {
    if (type === 'text') {
      await handleText(event, userId, event.message.text.trim())
    } else if (type === 'image' || type === 'audio' || type === 'file') {
      await handleMedia(event, userId)
    } else if (type === 'location') {
      const { latitude, longitude, title } = event.message
      await replyWeather(event, await getWeatherByCoords(latitude, longitude, title || '你的位置'))
    } else {
      await reply(event, '我看不懂這種訊息，請傳文字、圖片、語音、PDF 或位置給我。')
    }
  } catch (error) {
    console.error(error)
    const message =
      error instanceof QuotaError
        ? '今天的 AI 免費額度用完了，請晚點再試。天氣、匯率、新聞卡片仍然可以使用。'
        : '處理時發生錯誤，請稍後再試。'
    await reply(event, message).catch(() => {})
  }
})

// 雲端平台會用環境變數 PORT 指定埠號，本機沒有設定時用 3000
const port = process.env.PORT || 3000
bot.listen('/', port, () => {
  console.log(`bot 啟動，埠號 ${port}`)
})
