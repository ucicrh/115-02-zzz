// 外部資料：天氣（Open-Meteo）、匯率（open.er-api.com）、新聞（Google 新聞 RSS），都不需要 API key
import { generate } from './gemini.js'

const getJson = async (url) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  return res.json()
}

// ---------- 天氣 ----------
// Open-Meteo 的地名查詢對中文不可靠（「台北」查不到、「高雄」會查到四川），台灣縣市直接內建座標
const TAIWAN_CITIES = {
  台北: [25.033, 121.5654],
  新北: [25.012, 121.4657],
  基隆: [25.1276, 121.7392],
  桃園: [24.9936, 121.301],
  新竹: [24.8138, 120.9675],
  苗栗: [24.5602, 120.8214],
  台中: [24.1477, 120.6736],
  彰化: [24.0809, 120.5385],
  南投: [23.9096, 120.6839],
  雲林: [23.7117, 120.543],
  嘉義: [23.4801, 120.4491],
  台南: [22.9999, 120.227],
  高雄: [22.6273, 120.3014],
  屏東: [22.669, 120.4862],
  宜蘭: [24.757, 121.7533],
  花蓮: [23.9911, 121.6112],
  台東: [22.7583, 121.1444],
  澎湖: [23.5711, 119.5793],
  金門: [24.4493, 118.3767],
  馬祖: [26.1608, 119.9517],
  連江: [26.1608, 119.9517],
}

const searchPlace = async (name) => {
  const data = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh`,
  )
  const place = data.results?.[0]
  if (!place) return null
  return {
    name: place.country ? `${place.name}（${place.country}）` : place.name,
    latitude: place.latitude,
    longitude: place.longitude,
  }
}

const geocode = async (input) => {
  const key = input.replace(/臺/g, '台').replace(/[市縣]$/, '')
  if (TAIWAN_CITIES[key]) {
    const [latitude, longitude] = TAIWAN_CITIES[key]
    return { name: key, latitude, longitude }
  }
  const found = await searchPlace(input)
  if (found) return found
  // 中文查不到時，請 AI 把地名轉成英文再查一次
  const english = await generate(
    `請把地名「${input}」翻成英文地名，只輸出英文地名本身，不要任何其他文字。`,
  )
  return english ? searchPlace(english) : null
}

export const getWeatherByCoords = async (latitude, longitude, name) => {
  const data = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&timezone=auto&forecast_days=3',
  )
  return {
    name,
    current: {
      temperature: data.current.temperature_2m,
      feelsLike: data.current.apparent_temperature,
      humidity: data.current.relative_humidity_2m,
      wind: data.current.wind_speed_10m,
      code: data.current.weather_code,
    },
    days: data.daily.time.map((date, i) => ({
      date,
      code: data.daily.weather_code[i],
      max: data.daily.temperature_2m_max[i],
      min: data.daily.temperature_2m_min[i],
      rainChance: data.daily.precipitation_probability_max[i],
    })),
  }
}

// 找不到地點時回傳 null
export const getWeather = async (placeName) => {
  const place = await geocode(placeName)
  if (!place) return null
  return getWeatherByCoords(place.latitude, place.longitude, place.name)
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
  const res = await fetch(url)
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
