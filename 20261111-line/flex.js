// Flex Message 卡片：天氣、匯率、新聞
import { CURRENCY_NAMES, convert } from './services.js'

const COLOR = { primary: '#2B6CB0', text: '#1A202C', sub: '#718096', line: '#E2E8F0' }

const header = (title, subtitle) => ({
  type: 'box',
  layout: 'vertical',
  backgroundColor: COLOR.primary,
  paddingAll: 'lg',
  contents: [
    { type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true },
    ...(subtitle ? [{ type: 'text', text: subtitle, color: '#FFFFFFCC', size: 'xs' }] : []),
  ],
})

const separator = { type: 'separator', margin: 'lg', color: COLOR.line }

// ---------- 天氣 ----------
// WMO 天氣代碼
const WEATHER_CODES = {
  0: ['☀️', '晴'],
  1: ['🌤️', '大致晴朗'],
  2: ['⛅', '多雲'],
  3: ['☁️', '陰'],
  45: ['🌫️', '霧'],
  48: ['🌫️', '霧'],
  51: ['🌦️', '毛毛雨'],
  53: ['🌦️', '毛毛雨'],
  55: ['🌦️', '毛毛雨'],
  56: ['🌧️', '凍雨'],
  57: ['🌧️', '凍雨'],
  61: ['🌧️', '小雨'],
  63: ['🌧️', '雨'],
  65: ['🌧️', '大雨'],
  66: ['🌧️', '凍雨'],
  67: ['🌧️', '凍雨'],
  71: ['🌨️', '小雪'],
  73: ['🌨️', '雪'],
  75: ['🌨️', '大雪'],
  77: ['🌨️', '雪'],
  80: ['🌦️', '陣雨'],
  81: ['🌦️', '陣雨'],
  82: ['⛈️', '強陣雨'],
  85: ['🌨️', '陣雪'],
  86: ['🌨️', '陣雪'],
  95: ['⛈️', '雷雨'],
  96: ['⛈️', '雷雨夾冰雹'],
  99: ['⛈️', '雷雨夾冰雹'],
}

export const describeWeather = (code) => WEATHER_CODES[code] || ['🌡️', '—']

const DAY_LABELS = ['今天', '明天', '後天']

export const weatherCard = (weather, advice) => {
  const { name, current, days } = weather
  const [icon, description] = describeWeather(current.code)
  return {
    type: 'flex',
    altText: `${name}天氣：${description} ${Math.round(current.temperature)}°C`,
    contents: {
      type: 'bubble',
      header: header(`${name}天氣`, '即時與三日預報'),
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            contents: [
              {
                type: 'text',
                text: `${Math.round(current.temperature)}°C`,
                size: '3xl',
                weight: 'bold',
                color: COLOR.text,
                flex: 0,
              },
              {
                type: 'text',
                text: `${icon} ${description}`,
                size: 'lg',
                color: COLOR.text,
                margin: 'lg',
              },
            ],
          },
          {
            type: 'text',
            text: `體感 ${Math.round(current.feelsLike)}°C・濕度 ${current.humidity}%・風速 ${Math.round(current.wind)} km/h`,
            size: 'xs',
            color: COLOR.sub,
            margin: 'sm',
            wrap: true,
          },
          separator,
          ...days.map((day, i) => {
            const [dayIcon, dayDescription] = describeWeather(day.code)
            return {
              type: 'box',
              layout: 'horizontal',
              margin: 'md',
              contents: [
                {
                  type: 'text',
                  text: DAY_LABELS[i] || day.date.slice(5),
                  size: 'sm',
                  color: COLOR.sub,
                  flex: 2,
                },
                {
                  type: 'text',
                  text: `${dayIcon} ${dayDescription}`,
                  size: 'sm',
                  color: COLOR.text,
                  flex: 4,
                },
                {
                  type: 'text',
                  text: `${Math.round(day.min)}~${Math.round(day.max)}°`,
                  size: 'sm',
                  color: COLOR.text,
                  align: 'end',
                  flex: 3,
                },
                {
                  type: 'text',
                  text: `☔${day.rainChance ?? '-'}%`,
                  size: 'sm',
                  color: COLOR.sub,
                  align: 'end',
                  flex: 3,
                },
              ],
            }
          }),
          ...(advice
            ? [
                separator,
                {
                  type: 'text',
                  text: advice,
                  size: 'sm',
                  color: COLOR.text,
                  wrap: true,
                  margin: 'lg',
                },
              ]
            : []),
        ],
      },
    },
  }
}

// ---------- 匯率 ----------
const formatNumber = (value) =>
  value >= 1
    ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : value.toPrecision(4)

const currencyLabel = (code) => (CURRENCY_NAMES[code] ? `${CURRENCY_NAMES[code]} ${code}` : code)

const updatedText = (date) =>
  `更新時間 ${date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'short' })}`

const footnote = (text) => ({ type: 'text', text, size: 'xxs', color: COLOR.sub, margin: 'lg' })

const OVERVIEW_CURRENCIES = ['USD', 'EUR', 'JPY', 'CNY', 'HKD', 'KRW', 'GBP', 'AUD']

// 常用貨幣對新台幣
export const rateOverviewCard = ({ rates, updated }) => ({
  type: 'flex',
  altText: `匯率：1 美金 = ${formatNumber(convert(1, 'USD', 'TWD', rates))} 新台幣`,
  contents: {
    type: 'bubble',
    header: header('匯率', '1 單位外幣可換多少新台幣'),
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        ...OVERVIEW_CURRENCIES.map((code, i) => ({
          type: 'box',
          layout: 'horizontal',
          margin: i ? 'md' : 'none',
          contents: [
            { type: 'text', text: currencyLabel(code), size: 'sm', color: COLOR.text, flex: 3 },
            {
              type: 'text',
              text: formatNumber(convert(1, code, 'TWD', rates)),
              size: 'sm',
              weight: 'bold',
              color: COLOR.text,
              align: 'end',
              flex: 2,
            },
          ],
        })),
        separator,
        footnote(`${updatedText(updated)}，僅供參考`),
        footnote('換算範例：「匯率 100 美金 日幣」'),
      ],
    },
  },
})

export const rateConvertCard = ({ amount, from, to }, { rates, updated }) => {
  const result = formatNumber(convert(amount, from, to, rates))
  return {
    type: 'flex',
    altText: `${amount} ${from} = ${result} ${to}`,
    contents: {
      type: 'bubble',
      header: header('匯率換算', `${currencyLabel(from)} → ${currencyLabel(to)}`),
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: `${amount.toLocaleString('en-US')} ${from} =`,
            size: 'md',
            color: COLOR.sub,
          },
          {
            type: 'text',
            text: `${result} ${to}`,
            size: 'xxl',
            weight: 'bold',
            color: COLOR.text,
            wrap: true,
          },
          separator,
          footnote(`1 ${from} = ${formatNumber(convert(1, from, to, rates))} ${to}`),
          footnote(`${updatedText(updated)}，僅供參考`),
        ],
      },
    },
  }
}

// ---------- 新聞 ----------
// 每則標題點了會開啟新聞連結
export const newsCard = (items, keyword) => ({
  type: 'flex',
  altText: `${keyword ? `「${keyword}」新聞` : '焦點新聞'}：${items[0].title}`.slice(0, 400),
  contents: {
    type: 'bubble',
    header: header(keyword ? `「${keyword}」新聞` : '焦點新聞', '點標題閱讀全文'),
    body: {
      type: 'box',
      layout: 'vertical',
      contents: items.flatMap((item, i) => [
        ...(i ? [separator] : []),
        {
          type: 'box',
          layout: 'vertical',
          margin: i ? 'lg' : 'none',
          action: { type: 'uri', label: '閱讀全文', uri: item.link },
          contents: [
            {
              type: 'text',
              text: item.title,
              size: 'sm',
              color: COLOR.text,
              wrap: true,
              maxLines: 3,
            },
            ...(item.source
              ? [{ type: 'text', text: item.source, size: 'xxs', color: COLOR.sub, margin: 'xs' }]
              : []),
          ],
        },
      ]),
    },
  },
})
