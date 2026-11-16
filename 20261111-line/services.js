// 外部資料：匯率（open.er-api.com）、新聞（Google 新聞 RSS），都不需要 API key

// 對外查詢最多等多久。沒有上限的話，對方不回應時這則訊息會一直卡住
const FETCH_TIMEOUT_MS = 8 * 1000

// 錯誤訊息只留網址的主機和路徑：查詢參數裡可能有使用者輸入的內容，不該寫進日誌
const describeUrl = (url) => {
  const { origin, pathname } = new URL(url)
  return `${origin}${pathname}`
}

const getJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${describeUrl(url)} ${res.status}`)
  return res.json()
}

// ---------- 匯率 ----------
export const CURRENCY_NAMES = {
  TWD: '新台幣',
  USD: '美金',
  JPY: '日圓',
  EUR: '歐元',
  CNY: '人民幣',
  HKD: '港幣',
  KRW: '韓元',
  GBP: '英鎊',
  AUD: '澳幣',
  CAD: '加幣',
  SGD: '新加坡幣',
  THB: '泰銖',
  VND: '越南盾',
  CHF: '瑞士法郎',
  MYR: '馬幣',
  IDR: '印尼盾',
  PHP: '菲律賓披索',
  NZD: '紐幣',
}

// 使用者可能輸入的別名
const CURRENCY_ALIASES = {
  台幣: 'TWD',
  臺幣: 'TWD',
  新臺幣: 'TWD',
  美元: 'USD',
  日幣: 'JPY',
  日元: 'JPY',
  韓幣: 'KRW',
  韓圜: 'KRW',
  澳元: 'AUD',
  加元: 'CAD',
  新幣: 'SGD',
  泰幣: 'THB',
  港元: 'HKD',
  瑞郎: 'CHF',
  披索: 'PHP',
  紐元: 'NZD',
}
for (const [code, name] of Object.entries(CURRENCY_NAMES)) CURRENCY_ALIASES[name] = code

// 名稱長的先比對，避免「台幣」搶走「新台幣」
const CURRENCY_PATTERN = new RegExp(
  [...Object.keys(CURRENCY_ALIASES).sort((a, b) => b.length - a.length), '[A-Za-z]{3}'].join('|'),
  'g',
)

const RATE_CACHE_MS = 60 * 60 * 1000
let rateCache = null

export const getRates = async () => {
  if (rateCache && Date.now() - rateCache.fetchedAt < RATE_CACHE_MS) return rateCache
  const data = await getJson('https://open.er-api.com/v6/latest/USD')
  if (data.result !== 'success') throw new Error('匯率 API 回傳失敗')
  rateCache = {
    rates: data.rates, // 1 美金可換多少該貨幣
    updated: new Date(data.time_last_update_unix * 1000),
    fetchedAt: Date.now(),
  }
  return rateCache
}

// 解析「100 美金 日幣」「USD TWD」「日幣」；沒寫貨幣回傳 null，寫了但不認得則 unknown 為該字串
export const parseRateQuery = (text, rates) => {
  const amountMatch = text.match(/\d[\d,]*(?:\.\d+)?/)
  const amount = amountMatch ? Number(amountMatch[0].replace(/,/g, '')) : 1
  const codes = []
  for (const [word] of text.matchAll(CURRENCY_PATTERN)) {
    const code = CURRENCY_ALIASES[word] || word.toUpperCase()
    if (!rates[code]) return { unknown: word }
    codes.push(code)
  }
  if (codes.length === 0) return null
  const from = codes[0]
  const to = codes[1] || (from === 'TWD' ? 'USD' : 'TWD')
  return { amount, from, to }
}

export const convert = (amount, from, to, rates) => (amount * rates[to]) / rates[from]

// ---------- 新聞 ----------
const decodeEntities = (text) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()

const pick = (xml, pattern) => decodeEntities(xml.match(pattern)?.[1] || '')

// keyword 為空時取焦點新聞
export const getNews = async (keyword, count = 5) => {
  const locale = 'hl=zh-TW&gl=TW&ceid=TW:zh-Hant'
  const url = keyword
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&${locale}`
    : `https://news.google.com/rss?${locale}`
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Google 新聞 ${res.status}`)
  const xml = await res.text()
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, item]) => {
      const source = pick(item, /<source[^>]*>([\s\S]*?)<\/source>/)
      let title = pick(item, /<title>([\s\S]*?)<\/title>/)
      // 標題結尾會帶「 - 來源」，重複了就拿掉
      if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -source.length - 3)
      return { title, source, link: pick(item, /<link>([\s\S]*?)<\/link>/) }
    })
    .filter((item) => item.title && /^https:\/\//.test(item.link) && item.link.length <= 1000)
    .slice(0, count)
}
