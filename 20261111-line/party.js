// 聚會模式：AI 扮演六位朋友，使用者每說一句話，就輪三位出來聊天
import { generateJson } from './gemini.js'

// 頭像放在 GitHub 上（LINE 需要公開的 https 圖片網址），可用環境變數換成別的位置
const AVATAR_BASE_URL =
  process.env.AVATAR_BASE_URL ||
  'https://raw.githubusercontent.com/ucicrh/115-02-zzz/main/20261111-line/avatars'

// 想改人設就改這裡；name 會顯示成訊息的發話者（上限 20 字）
export const MEMBERS = [
  {
    name: '阿哲',
    avatar: 'zhe.png',
    intro: '健身教練',
    persona: '熱血的健身教練，愛運動、講話直接又有活力，喜歡揪大家出去玩，常被小宇鬧。',
  },
  {
    name: '小雯',
    avatar: 'wen.png',
    intro: '護理師',
    persona: '溫柔體貼的護理師，擅長傾聽，會關心對方的感受和身體狀況，說話輕聲細語。',
  },
  {
    name: 'Kevin',
    avatar: 'kevin.png',
    intro: '工程師',
    persona: '理性的軟體工程師，愛講冷知識和數據，偶爾夾雜英文單字，是個冷面笑匠。',
  },
  {
    name: '美玲姐',
    avatar: 'meiling.png',
    intro: '行銷主管',
    persona: '直率的行銷主管，是大家的大姐，愛吐槽也愛給實際的建議，很照顧人。',
  },
  {
    name: '小宇',
    avatar: 'yu.png',
    intro: '大學生',
    persona: '搞笑擔當的大學生，愛玩梗、愛用網路用語，反應快，喜歡鬧阿哲。',
  },
  {
    name: '艾莉',
    avatar: 'ellie.png',
    intro: '插畫家',
    persona: '文青插畫家，喜歡旅行、咖啡和電影，說話慢條斯理，常有與眾不同的觀點。',
  },
]

const SPEAKERS_PER_TURN = 3 // LINE 一次最多回 5 則訊息
const MAX_LINES = 30 // 保留最近幾句聊天紀錄

const SYSTEM_PROMPT = `你要扮演一場朋友聚會裡的多位成員，和使用者在 LINE 群組聊天。成員如下：
${MEMBERS.map((member) => `- ${member.name}：${member.persona}`).join('\n')}

規則：
- 使用者是大家的朋友，在聊天紀錄裡標示為「我」。
- 每位成員一則訊息，一到三句話，口語、自然，像真人在 LINE 上聊天。
- 每個人的語氣和關注的事情要明顯不同，符合各自的人設。
- 可以回應使用者，也可以接其他成員的話、互相吐槽，不要重複別人說過的內容。
- 偶爾向使用者提問，讓話題能繼續下去。
- 用繁體中文，不要用 Markdown，訊息開頭不要寫自己的名字。`

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { name: { type: 'STRING' }, text: { type: 'STRING' } },
    required: ['name', 'text'],
  },
}

// userId -> { lines: ['我：…', '阿哲：…'], next: 下一位發言者的索引 }
const parties = new Map()

export const isInParty = (userId) => parties.has(userId)

export const startParty = (userId) => {
  parties.set(userId, { lines: [], next: 0 })
  return `🎉 聚會開始！今天來的有：\n${MEMBERS.map((member) => `・${member.name}（${member.intro}）`).join('\n')}\n\n隨便說句話，大家就會輪流回你。想離開時傳「結束聚會」。`
}

export const endParty = (userId) => parties.delete(userId)

const toMessage = (member, text) => ({
  type: 'text',
  text: text.slice(0, 5000),
  sender: { name: member.name, iconUrl: `${AVATAR_BASE_URL}/${member.avatar}` },
})

// 回傳這一輪要送出的 LINE 訊息陣列（每則帶有該成員的名稱與頭像）
export const partyReply = async (userId, text) => {
  const party = parties.get(userId)
  const speakers = Array.from(
    { length: SPEAKERS_PER_TURN },
    (_, i) => MEMBERS[(party.next + i) % MEMBERS.length],
  )
  const lines = [...party.lines, `我：${text}`]

  const result = await generateJson(
    `聊天紀錄：\n${lines.join('\n')}\n\n請產生接下來的訊息，依序由「${speakers.map((member) => member.name).join('、')}」發言，每人一則。`,
    { system: SYSTEM_PROMPT, schema: SCHEMA },
  )

  // 只採用這一輪該發言的成員，順序照輪到的順序
  const replies = speakers
    .map((member) => ({
      member,
      text: (Array.isArray(result) ? result : [])
        .find((item) => item?.name === member.name)
        ?.text?.trim(),
    }))
    .filter((item) => item.text)
  if (replies.length === 0) throw new Error('聚會模式：AI 沒有回傳可用的訊息')

  party.lines = [...lines, ...replies.map((item) => `${item.member.name}：${item.text}`)].slice(
    -MAX_LINES,
  )
  party.next = (party.next + SPEAKERS_PER_TURN) % MEMBERS.length
  return replies.map((item) => toMessage(item.member, item.text))
}
