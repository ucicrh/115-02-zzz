// AI 功能指令：每個功能對應一段提示詞，可套用在文字、圖片、語音、文件上
const LANGUAGES = [
  '繁體中文',
  '簡體中文',
  '中文',
  '英文',
  '日文',
  '韓文',
  '法文',
  '德文',
  '西班牙文',
  '泰文',
  '越南文',
  '印尼文',
]
const STYLES = ['正式', '口語', '文法', '潤飾']

const MEDIA_NOTE = '若內容是圖片、語音或文件，先辨識出其中的文字再處理。'

export const TASKS = {
  OCR: {
    keywords: ['OCR', 'ocr', '辨識'],
    build: () =>
      '請辨識並逐字輸出內容中的所有文字，保留原本的換行與排版，不要加入多餘說明。若沒有文字，請回覆「未偵測到文字」。',
  },
  翻譯: {
    keywords: ['翻譯'],
    options: LANGUAGES,
    build: (lang) =>
      lang
        ? `請把內容中的文字翻譯成${lang}，只輸出譯文。${MEDIA_NOTE}`
        : `請翻譯內容中的文字：若原文是中文就翻成英文，其他語言一律翻成繁體中文。只輸出譯文。${MEDIA_NOTE}`,
  },
  解題: {
    keywords: ['解題'],
    build: () =>
      '請解答內容中的題目，列出清楚的解題步驟與最終答案，數學式請用純文字表示，用繁體中文回答。',
  },
  摘要: {
    keywords: ['摘要'],
    build: () =>
      `請用繁體中文把內容整理成重點條列（3 到 7 點），每點一行，開頭用「•」。${MEDIA_NOTE}`,
  },
  改寫: {
    keywords: ['改寫', '潤飾'],
    options: STYLES,
    build: (style) => {
      const rules = {
        正式: '改成更正式、專業的書面語氣',
        口語: '改成更口語、自然親切的說法',
        文法: '只修正錯字與文法錯誤，盡量不更動原本的用詞與語氣',
        潤飾: '潤飾得更通順流暢，保留原意',
      }
      return `請把內容中的文字${rules[style || '潤飾']}，保持原本語言，只輸出改寫後的結果。${MEDIA_NOTE}`
    },
  },
  逐字稿: {
    keywords: ['逐字稿'],
    build: () => '請把這段語音逐字轉成文字，保留原本的語言，只輸出逐字稿。',
  },
  // 以下沒有指令，是直接傳圖片時的預設功能
  描述: {
    keywords: [],
    build: () => '請描述這張圖片的內容。',
  },
}

export const HELP_TEXT = `我是 AI 助理，可以直接跟我聊天，也能用下面的功能：

📷 OCR：傳「OCR」再傳圖片，辨識圖中文字
🌐 翻譯：「翻譯 文字」，可指定語言「翻譯 日文 你好」
🧮 解題：「解題 2x+3=7」，或傳「解題」再傳題目圖片
📝 摘要：「摘要 長文」整理重點條列
✏️ 改寫：「改寫 正式 文字」，風格有正式／口語／文法／潤飾

🎤 語音：直接傳語音訊息會轉成文字；先傳「翻譯」再傳語音就是語音翻譯
📄 文件：直接傳 PDF 或文字檔會做摘要，之後可以繼續針對文件提問

☀️ 天氣：「天氣 台北」，或傳送位置訊息
💱 匯率：「匯率」看常用貨幣，「匯率 100 美金 日幣」換算
📰 新聞：「新聞」看焦點新聞，「新聞 AI」搜尋關鍵字

🎉 聚會：傳「聚會」，六位 AI 朋友會輪流跟你聊天；傳「結束聚會」離開

🧹 清除：傳「清除」忘記之前的對話

OCR、翻譯、解題、摘要、改寫都可以先傳指令，再傳圖片、語音或 PDF。直接傳圖片會描述圖片內容，傳完可以繼續追問。`

// 解析文字指令，回傳 { task, option, rest }；不是指令則為 null
export const parseCommand = (text) => {
  const input = text.trim()
  for (const [task, { keywords, options = [] }] of Object.entries(TASKS)) {
    for (const keyword of keywords) {
      if (!input.startsWith(keyword)) continue
      let rest = input.slice(keyword.length).trim()
      // 選項（語言／風格）要比長的先比對，避免「中文」搶走「繁體中文」
      const option = [...options]
        .sort((a, b) => b.length - a.length)
        .find((o) => rest.startsWith(o))
      if (option) rest = rest.slice(option.length).trim()
      return { task, option, rest }
    }
  }
  return null
}
