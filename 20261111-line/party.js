// 聚會模式：AI 扮演一群老同學，使用者每說一句話，就輪最多三位出來聊天。
// 角色放在 prompts/personas.json，共用的提示詞放在 prompts/party_mode_prompt.md，
// 這支程式裡沒有任何角色的文字。改了這兩個檔案要重新啟動機器人才會生效。
// 有兩種產生方式，用 .env 的 PARTY_MODE 切換：
//   sequential：每位角色各呼叫一次 AI，後面的人看得到前面的人剛說的話（對話比較連貫，但比較慢）
//   single：一次呼叫產生三個人的話（比較快）
// 沒設定時用 sequential。
//
// 這裡的聊天紀錄是「聚會」專用的，和一般對話的記憶（OpenAI.js）完全分開。
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateJsonDetailed, isModelLoaded, MODEL } from './OpenAI.js'

// ---------- 載入角色與共用提示詞 ----------
// 可用環境變數 PARTY_PROMPTS_DIR 換成別的資料夾（測試用）
const PROMPTS_DIR = process.env.PARTY_PROMPTS_DIR
  ? resolve(process.env.PARTY_PROMPTS_DIR)
  : fileURLToPath(new URL('./prompts', import.meta.url))
const PERSONAS_FILE = 'personas.json'
const TEMPLATE_FILE = 'party_mode_prompt.md'
const PLACEHOLDERS = ['role_instruction', 'persona_cards', 'tool_result', 'banned_phrases']
const PLACEHOLDER_PATTERN = /\{([a-z_]+)\}/g
const MIN_MEMBERS = 3
const MAX_NAME_LENGTH = 20 // LINE 發話者名稱的上限

// 每位角色的輸出上限：照字數範圍的上限估算（中文大約一個字一個 token），再留一點餘裕。
// 角色可以在 personas.json 用 max_tokens 另外指定。JSON 的其他欄位另外計算（見 JSON_OVERHEAD_TOKENS）。
const MIN_SPEECH_TOKENS = 60
const MAX_SPEECH_TOKENS = 160
const speechTokens = (length) =>
  Math.min(
    MAX_SPEECH_TOKENS,
    Math.max(MIN_SPEECH_TOKENS, length.sentences[1] * length.chars[1] + 10),
  )

const fail = (message) => {
  throw new Error(message)
}
const isText = (value) => typeof value === 'string' && value.trim() !== ''
const isRange = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((n) => Number.isInteger(n) && n > 0) &&
  value[0] <= value[1]
const textList = (value, where) => {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(isText)) fail(`${where} 必須是文字陣列`)
  return value.map((item) => item.trim())
}

const toMember = (raw, index) => {
  const where = `${PERSONAS_FILE} 第 ${index + 1} 位角色`
  if (!raw || typeof raw !== 'object') fail(`${where} 不是物件`)
  for (const field of ['id', 'name', 'intro', 'identity', 'tone', 'wants']) {
    if (!isText(raw[field])) fail(`${where} 缺少 ${field}`)
  }
  const name = raw.name.trim()
  if (name.length > MAX_NAME_LENGTH) fail(`${where} 的 name 超過 ${MAX_NAME_LENGTH} 個字`)
  if (/[：:\n]/.test(name) || name === '我') fail(`${where} 的 name 不能是「我」，也不能有冒號或換行`)
  if (!isRange(raw.length?.sentences) || !isRange(raw.length?.chars_per_sentence)) {
    fail(`${where} 的 length 要有 sentences 與 chars_per_sentence，各是 [最少, 最多]`)
  }
  const length = { sentences: raw.length.sentences, chars: raw.length.chars_per_sentence }
  if (raw.max_tokens !== undefined && !(Number.isInteger(raw.max_tokens) && raw.max_tokens > 0)) {
    fail(`${where} 的 max_tokens 必須是正整數`)
  }
  if (raw.avatar !== undefined && !isText(raw.avatar)) fail(`${where} 的 avatar 必須是檔名`)
  const relations = raw.relations ?? {}
  if (typeof relations !== 'object' || !Object.values(relations).every(isText)) {
    fail(`${where} 的 relations 必須是「角色 id：關係描述」`)
  }
  return {
    id: raw.id.trim(),
    name,
    intro: raw.intro.trim(),
    identity: raw.identity.trim(),
    tone: raw.tone.trim(),
    wants: raw.wants.trim(),
    length,
    maxTokens: raw.max_tokens ?? speechTokens(length),
    catchphrases: textList(raw.catchphrases, `${where} 的 catchphrases`),
    doesntKnow: textList(raw.doesnt_know, `${where} 的 doesnt_know`),
    examples: textList(raw.examples, `${where} 的 examples`),
    antiExamples: textList(raw.anti_examples, `${where} 的 anti_examples`),
    mentionExclude: textList(raw.mention_exclude, `${where} 的 mention_exclude`),
    relations,
    avatar: raw.avatar?.trim() || null,
  }
}

// 讀取並檢查角色檔與共用提示詞，回傳 { members, template, avatarBaseUrl }；有問題就丟出說明原因的錯誤
export const loadPartyPrompts = (folder = PROMPTS_DIR) => {
  const read = (file) => {
    try {
      return readFileSync(join(folder, file), 'utf8')
    } catch (error) {
      return fail(`讀不到 ${file}（${error.code || error.message}）`)
    }
  }
  let data
  try {
    data = JSON.parse(read(PERSONAS_FILE).replace(/^\uFEFF/, ''))
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${PERSONAS_FILE} 不是合法的 JSON（${error.message}）`)
    throw error
  }
  if (!Array.isArray(data?.personas)) fail(`${PERSONAS_FILE} 裡沒有 personas 陣列`)
  const avatarBaseUrl = data.avatar_base_url
  if (avatarBaseUrl !== undefined && !/^https:\/\/\S+$/.test(avatarBaseUrl)) {
    fail(`${PERSONAS_FILE} 的 avatar_base_url 必須是 https 網址`)
  }
  const members = data.personas.map(toMember)
  if (members.length < MIN_MEMBERS) fail(`${PERSONAS_FILE} 至少要有 ${MIN_MEMBERS} 位角色`)
  for (const field of ['id', 'name']) {
    const values = members.map((member) => member[field])
    const repeated = values.find((value, index) => values.indexOf(value) !== index)
    if (repeated) fail(`${PERSONAS_FILE} 有重複的 ${field}：${repeated}`)
  }
  for (const member of members) {
    for (const id of Object.keys(member.relations)) {
      if (id === member.id || !members.some((other) => other.id === id)) {
        fail(`${PERSONAS_FILE}：${member.name} 的 relations 提到不存在的角色 id「${id}」`)
      }
    }
  }

  const template = read(TEMPLATE_FILE).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
  const used = [...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1])
  const unknown = used.find((name) => !PLACEHOLDERS.includes(name))
  if (unknown) fail(`${TEMPLATE_FILE} 有不認得的佔位符 {${unknown}}`)
  const missing = PLACEHOLDERS.find((name) => !used.includes(name))
  if (missing) fail(`${TEMPLATE_FILE} 缺少佔位符 {${missing}}`)
  return { members, template, avatarBaseUrl: avatarBaseUrl?.replace(/\/+$/, '') ?? null }
}

// 啟動時載入一次。失敗只寫日誌、讓聚會無法開始，不影響機器人的其他功能
let loaded = { members: [], template: '', avatarBaseUrl: null }
let loadError = null
try {
  loaded = loadPartyPrompts()
} catch (error) {
  loadError = error.message
  console.error(`[聚會] 角色設定載入失敗，聚會模式無法使用：${loadError}`)
}
export const MEMBERS = loaded.members
const TEMPLATE = loaded.template
// 頭像網址是這個位置加上角色的 avatar 檔名（LINE 需要公開的 https 圖片網址）。
// 位置寫在 personas.json 的 avatar_base_url，也可以用環境變數 AVATAR_BASE_URL 蓋過去。
// 沒設定 avatar 的角色、或兩邊都沒給位置時不帶頭像，LINE 會顯示官方帳號自己的頭像。
const AVATAR_BASE_URL = (process.env.AVATAR_BASE_URL || loaded.avatarBaseUrl || '').replace(/\/+$/, '')
// 角色設定載入失敗的原因；正常時是 null
export const getPartyLoadError = () => loadError

const envMs = (name, fallback) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const SPEAKERS_PER_TURN = 3 // LINE 一次最多回 5 則訊息
const MAX_LINES = 30 // 保留最近幾句聊天紀錄
const MAX_RETRIES = 1 // 每一輪最多重試幾次。重試不算發言名額，所以一輪最多呼叫 AI 3 + 1 次
// 時間分配。整輪的期限由 index.js 依「收到訊息的時間」算好傳進來，這裡只決定每次呼叫能用多少。
const STAGE_MS = envMs('PARTY_STAGE_MS', 15 * 1000) // 模型已載入時，一次呼叫最多等多久
const RESERVE_MS = envMs('PARTY_RESERVE_MS', 7 * 1000) // 替後面每一位發言者保留的時間
const MIN_STAGE_MS = envMs('PARTY_MIN_STAGE_MS', 5 * 1000) // 剩下的時間比這個少就不再呼叫
const DEFAULT_TURN_MS = 45 * 1000 // 呼叫端沒給期限時的整輪時限
const PARTY_TTL_MS = 6 * 60 * 60 * 1000 // 聚會這麼久沒人說話就自動結束
const JSON_OVERHEAD_TOKENS = 120 // 訊息以外的欄位（焦點、承接檢查）大約會用掉的 token

// ---------- 提示詞組裝（sequential 與 single 共用） ----------
const range = ([min, max], unit) => (min === max ? `${min} ${unit}` : `${min}–${max} ${unit}`)

// 兩個人的關係：雙方在 personas.json 寫的都算數；都沒寫就是一般的老同學
const relationOf = (member, other) => {
  const mine = member.relations[other.id]
  const theirs = other.relations[member.id]
  if (mine && theirs && mine !== theirs) return `${mine}；他對你：${theirs}`
  if (mine || theirs) return mine || `他對你：${theirs}`
  return '老同學，很熟'
}

// 一位角色的角色卡
const describe = (member) =>
  [
    `【${member.name}】${member.intro}`,
    `身分：${member.identity}`,
    `語氣：${member.tone}`,
    `長度：${range(member.length.sentences, '句')}，每句約 ${range(member.length.chars, '字')}`,
    ...(member.catchphrases.length
      ? [`常用語（每三句最多一次）：${member.catchphrases.join('、')}`]
      : []),
    `此刻想要：${member.wants}`,
    ...(member.doesntKnow.length ? [`不懂的：${member.doesntKnow.join('、')}`] : []),
    ...(member.examples.length
      ? [`範例台詞（只是示範語氣，不要照抄）：\n${member.examples.map((line) => `- ${line}`).join('\n')}`]
      : []),
    ...(member.antiExamples.length ? [`不要這樣：${member.antiExamples.join('；')}`] : []),
    `跟其他人的關係：\n${MEMBERS.filter((other) => other !== member)
      .map((other) => `- ${other.name}（${other.intro}）—— ${relationOf(member, other)}`)
      .join('\n')}`,
  ].join('\n')

const roleInstruction = (speakers, all) => {
  if (all) return `這一次你要依序扮演下面 ${speakers.length} 位角色，每人各寫一則訊息。`
  return speakers.length === 1
    ? `這一次你扮演「${speakers[0].name}」。`
    : `這一次你要從下面 ${speakers.length} 位候選人裡選一位來扮演。`
}

// 組出一次呼叫要用的提示詞，回傳 { system, context }。
//   speakers        這次呼叫用得到的角色：只有一位就是扮演他；有多位時由 AI 從裡面選一位，
//                   all 為 true 則是每一位都要發言（single 模式）。角色卡只放這幾位的。
//   recentDialogue  聊天紀錄（['我：…', '老周：…']）；topicState：目前的話題焦點
//   userTexts       使用者這一輪說的話；said：這一輪已經發言的人（[{ member, text }]）
//   bannedPhrases   禁用片語；toolResult：查詢結果。沒有就填固定的說明文字，不會留下佔位符。
// system 放共用世界觀、規則和角色卡（每一輪都一樣的部分），context 放會變動的對話內容。
export const buildPartyPrompt = ({
  speakers,
  all = false,
  recentDialogue = [],
  topicState = '',
  userTexts = [],
  said = null,
  bannedPhrases = [],
  toolResult = '',
}) => {
  const values = {
    role_instruction: roleInstruction(speakers, all),
    persona_cards: speakers.map(describe).join('\n\n'),
    tool_result: String(toolResult || '').trim() || '（這一輪沒有查詢結果）',
    banned_phrases: bannedPhrases.length
      ? bannedPhrases.map((phrase) => `- ${phrase}`).join('\n')
      : '（目前沒有）',
  }
  const context = [
    `聊天紀錄（舊到新）：\n${recentDialogue.length ? recentDialogue.join('\n') : '（聚會剛開始，還沒有紀錄）'}`,
    `目前的話題焦點：${topicState || '（還沒有）'}`,
    `使用者最新訊息：\n${userTexts.map((text) => `我：${text}`).join('\n')}`,
    ...(said === null
      ? []
      : [
          said.length
            ? `這一輪已經發言（依序）：\n${said.map((item) => `${item.member.name}：${item.text}`).join('\n')}`
            : '這一輪還沒有人發言。',
        ]),
  ].join('\n\n')
  // 一次換完所有佔位符，填進去的內容不會再被當成佔位符處理
  return { system: TEMPLATE.replace(PLACEHOLDER_PATTERN, (_, name) => values[name]), context }
}

// single 模式（一次產生所有人的話）的任務說明
const singleTask = (speakers) =>
  `你的任務：產生接下來的訊息，依序由「${speakers.map((member) => member.name).join('、')}」發言，每人一則，name 欄位填角色的名字。
- 這是一段連貫的對話，不是每個人各自回答使用者。每一輪只圍繞一個焦點：使用者剛剛說的那件事。
- 第一位直接回應使用者說的話。第二位要接第一位的話（附和、反駁、吐槽或追問），第三位再接前面兩位的話，連起來要像同一段對話，讀得出誰在回誰。
- 接話時要提到前一個人說的具體內容，不要只是各自發表看法，也不要重複別人說過的內容。
- 不要自己開新話題。聊天紀錄裡正在聊的事要延續下去，前面說過的細節要記得、不要矛盾，直到使用者換話題為止。
- 每一輪最多一個人向使用者提問，而且要跟正在聊的事有關。其他人不要用問句結尾。`

const SINGLE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { name: { type: 'STRING' }, text: { type: 'STRING' } },
    required: ['name', 'text'],
  },
}

const isQuestion = (text) => /[?？]/.test(text)

// ---------- 由程式把關的規則（不是只寫在提示詞裡請 AI 自己遵守） ----------

// 使用者訊息裡點到名字的成員，照出現的先後排列。
// 角色可以用 mention_exclude 列出「含有名字但不是在叫他」的詞，這些詞先遮掉再找名字
const mentionIndex = (member, text) => {
  let masked = text
  for (const word of member.mentionExclude) masked = masked.replaceAll(word, '\n'.repeat(word.length))
  return masked.toLowerCase().indexOf(member.name.toLowerCase())
}
const mentionedMembers = (text) =>
  MEMBERS.map((member) => ({ member, index: mentionIndex(member, text) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.member)

// 這一輪最多幾個人接話：道別、道謝或只是應一聲的時候，不需要三個人都出來說話
const BRIEF_REPLY =
  /^(好+|好喔|好啊|好的|好吧|ok|okay|嗯+|喔+|哦+|是喔|對啊?|真的|了解|收到|知道了|哈+|笑死|讚|酷|xd+)[\s!！~～。.…]*$/i
const CLOSING_WORDS = /謝謝|感謝|謝啦|感恩|掰掰|拜拜|bye|晚安|再見|先走|先這樣|下次見|下次聊/i
const CLOSING_MAX_LENGTH = 15
const planSpeakers = (text) => {
  const brief =
    BRIEF_REPLY.test(text) ||
    (CLOSING_WORDS.test(text) && text.length <= CLOSING_MAX_LENGTH && !isQuestion(text))
  return brief ? 2 : SPEAKERS_PER_TURN
}

// 兩句話有多像（0～1）：拿掉標點和表情符號後，比對「相鄰兩個字」的組合有多少是一樣的
const pairs = (text) => {
  const clean = text.replace(/[\s\p{P}\p{S}]/gu, '')
  const result = new Set()
  for (let i = 0; i < clean.length - 1; i++) result.add(clean.slice(i, i + 2))
  return result
}
const MIN_PAIRS = 4 // 太短的話（例如「哈哈」「不好意思…」）本來就容易撞在一起，不拿來比
const similarity = (a, b) => {
  const x = pairs(a)
  const y = pairs(b)
  if (x.size < MIN_PAIRS || y.size < MIN_PAIRS) return 0
  let shared = 0
  for (const pair of x) if (y.has(pair)) shared += 1
  return (2 * shared) / (x.size + y.size)
}
const REPEAT_SIMILARITY = 0.8 // 相似到這個程度（幾乎一模一樣）才當作重複發言
const RECENT_LINES = 8 // 也跟最近幾句聊天紀錄比

// 跟這一輪前面的人、或最近聊天紀錄裡成員說過的話幾乎一樣，就算重複
const isRepeat = (text, said, lines) =>
  [
    ...said.map((item) => item.text),
    ...lines
      .slice(-RECENT_LINES)
      .filter((line) => !line.startsWith('我：'))
      .map((line) => line.slice(line.indexOf('：') + 1)),
  ].some((other) => similarity(text, other) >= REPEAT_SIMILARITY)

// 把結尾那句問使用者的問句拿掉。前面還有其他內容才拿；整則都是問句、或問的是其他成員，就原樣保留
const ENDS_WITH_QUESTION = /[?？][^\p{L}\p{N}]*$/u
const SENTENCE_BREAK = /[。！!？?，,\n…～~]/
const dropLastQuestion = (text) => {
  const end = text.search(ENDS_WITH_QUESTION)
  if (end < 0) return text
  let start = end
  while (start > 0 && !SENTENCE_BREAK.test(text[start - 1])) start -= 1
  const question = text.slice(start, end)
  if (MEMBERS.some((member) => question.includes(member.name))) return text
  const kept = text
    .slice(0, start)
    .trim()
    .replace(/[，,]$/, '')
  return kept.replace(/[^\p{L}\p{N}]/gu, '').length >= 4 ? kept : text
}
const stripTrailingQuestions = (text) => {
  let result = text
  for (let i = 0; i < 3; i++) {
    const next = dropLastQuestion(result)
    if (next === result) break
    result = next
  }
  return result
}

// 各個發言位置（0＝第一位）的任務說明與輸出格式。
//   candidates 有多位時由 AI 從裡面選一位，輸出會多一個 speaker 欄位
//   canAsk：這一位可不可以問使用者問題，由程式依「這一輪、上一輪有沒有人問過」決定
const buildTask = (position, candidates, said, focus, canAsk) => {
  const names = candidates.map((member) => member.name)
  if (position === 0) {
    return {
      schema: {
        type: 'OBJECT',
        properties: {
          focus_topic: { type: 'STRING' },
          speaker: { type: 'STRING', enum: names },
          text: { type: 'STRING' },
          wrap_up: { type: 'BOOLEAN' },
        },
        required: ['focus_topic', 'speaker', 'text', 'wrap_up'],
        propertyOrdering: ['focus_topic', 'speaker', 'text', 'wrap_up'],
      },
      task: `你的任務（這一輪第一位發言）：
1. focus_topic：用十個字以內寫出這一輪的話題焦點。使用者如果是在接續目前的話題，就沿用原本的焦點；提出新的事情，才換成新的焦點。
2. speaker：從候選人（${names.join('、')}）裡，選出最適合回應這句話的人。
3. text：用這個人的身分，直接回應使用者最新訊息。只講一個重點，不要一次講完所有觀點，留空間給後面的人接話。${canAsk ? '可以問使用者一個跟焦點有關的問題。' : '這次不要問使用者問題，也不要用問句結尾。'}
4. wrap_up：這個話題是否到此就夠了、不需要其他人再接話。只有使用者是單純打招呼、道謝或道別，而你已經回應完的時候才填 true，其他情況一律填 false。

寫之前先確認：有沒有回應到使用者真正在說的事？有沒有跟聊天紀錄裡講過的內容矛盾？有沒有偏離焦點？`,
    }
  }

  const speaker = candidates[0]
  const previous = said.map((item) => item.member.name)
  const last = previous[previous.length - 1]
  const askRule = canAsk
    ? '可以問使用者一個跟焦點有關的問題，也可以不問。'
    : '這一輪已經有人提問了，你不要再問使用者問題，也不要用問句結尾。'
  const checks = `寫之前先確認：${last} 實際說了什麼？他的核心觀點是什麼？我有沒有在回應這個觀點？有沒有跟前面的內容矛盾？有沒有偏離焦點「${focus}」？`

  if (position === 1) {
    // 剩下的候選人不只一位時，由 AI 選出比較適合接話的那一位
    const choose = candidates.length > 1
    const fields = ['previous_point', ...(choose ? ['speaker'] : []), 'stance', 'text', 'wrap_up']
    const steps = [
      `previous_point：用一句話寫出 ${last} 剛剛那則訊息的核心觀點。`,
      ...(choose
        ? [
            `speaker：從候選人（${names.join('、')}）裡，選出最適合接這句話的人。`,
            'stance：用這個人的身分，決定要怎麼接他的話。照人設決定，不需要認同他。',
          ]
        : ['stance：你要怎麼接他的話。照你的人設決定，不需要認同他。']),
      `text：接 ${last} 的話。要提到他說的具體內容，讓人看得出你是在回他；不要只是重新回答使用者的問題，也不要重複他講過的內容。如果你反對，要說出反對的是哪一點、為什麼。${askRule}`,
      'wrap_up：你說完之後，這段對話是否已經自然收尾、不需要第三個人再說話。通常填 false。',
    ]
    return {
      schema: {
        type: 'OBJECT',
        properties: {
          previous_point: { type: 'STRING' },
          ...(choose ? { speaker: { type: 'STRING', enum: names } } : {}),
          stance: { type: 'STRING', enum: ['同意', '補充', '質疑', '反駁', '吐槽'] },
          text: { type: 'STRING' },
          wrap_up: { type: 'BOOLEAN' },
        },
        required: fields,
        propertyOrdering: fields,
      },
      task: `你的任務（這一輪第二位發言${choose ? '' : `，你是${speaker.name}`}）：
${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}

${checks}`,
    }
  }

  return {
    schema: {
      type: 'OBJECT',
      properties: {
        previous_point: { type: 'STRING' },
        stance: { type: 'STRING', enum: ['調和', '延伸', '不同觀點', '收束'] },
        text: { type: 'STRING' },
      },
      required: ['previous_point', 'stance', 'text'],
      propertyOrdering: ['previous_point', 'stance', 'text'],
    },
    task: `你的任務（這一輪第三位、也是最後一位發言，你是${speaker.name}）：
1. previous_point：用一句話寫出 ${previous.join(' 和 ')} 各自的立場。
2. stance：你要怎麼接。可以調和兩人、延伸下去、提出不一樣的角度，或自然地把話題收個尾。不需要認同任何人。
3. text：要讓人看得出你聽懂了前面兩個人在講什麼，並提到其中至少一個人說的具體內容。不要重複前兩位已經講完的內容，也不要只是重新回答使用者的問題。如果你反對，要說出反對的是誰的哪一點、為什麼。${askRule}

${checks}`,
  }
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NAME_PATTERN = [...MEMBERS.map((member) => escapeRegExp(member.name)), '我'].join('|')

// 去掉模型多寫的名字開頭、引號；如果接著寫了別人的台詞，從那裡截斷
const cleanText = (text) => {
  let result = String(text || '')
    .trim()
    .replace(new RegExp(`^(${NAME_PATTERN})\\s*[：:]\\s*`), '')
    .replace(/^[「『"]+|[」』"]+$/g, '')
  const forged = result.search(new RegExp(`\\n\\s*(${NAME_PATTERN})\\s*[：:]`))
  if (forged > 0) result = result.slice(0, forged)
  return result.trim()
}

// ---------- 呼叫 AI ----------
// 這些失敗是暫時性的，值得再試一次：單次逾時、連線中斷、Ollama 內部錯誤、輸出不是合法 JSON。
// 其他的（來不及、被取消、連不上 Ollama、請求本身有問題）重試也沒用。
const RETRYABLE = new Set(['timeout', 'network', 'server', 'invalid'])

// 決定這次呼叫最晚要在什麼時候結束、最多能用多久；回傳 null 表示時間不夠，不要呼叫。
//   later：後面還有幾位要發言；first：這一輪是不是還沒有人說過話
// 回傳的 deadline 是絕對時間，排隊等模型的時間也算在裡面；timeoutMs 則從輪到之後才開始算。
const planCall = (turn, later, first) => {
  const now = Date.now()
  // 模型還沒載入：第一次呼叫得等它載入完（實測 30 秒以上），這時沒辦法替後面的人留時間
  if (first && turn.cold) {
    return turn.deadline - now >= MIN_STAGE_MS ? { deadline: turn.deadline } : null
  }
  // 平常：先扣掉留給後面每一位的時間。
  // 不夠扣的話就少留一位（等於這一輪少一個人發言），直到這次呼叫有足夠的時間為止
  for (let reserve = later; reserve >= 0; reserve--) {
    const deadline = turn.deadline - reserve * RESERVE_MS
    if (deadline - now >= MIN_STAGE_MS) return { deadline, timeoutMs: STAGE_MS }
  }
  return null
}

// 呼叫一次 AI，並把排隊時間、生成時間、token 用量、是否逾時或重試記進 turn.log。
// 回傳 { data }；失敗時 data 是 null，reason 是原因（OpenAI.js 的錯誤種類，或 invalid＝輸出無法解析）。
const callModel = async (
  turn,
  label,
  { system, prompt, schema, maxTokens, deadline, timeoutMs, retry = false },
) => {
  const entry = {
    label,
    retry,
    model: MODEL,
    waitMs: 0,
    ms: 0,
    limitMs: timeoutMs ?? null,
    input: null,
    output: null,
    ok: false,
    reason: null,
  }
  turn.log.push(entry)
  const head = `[聚會 ${turn.tag}] ${label}${retry ? '（重試）' : ''}｜${MODEL}`
  try {
    const result = await generateJsonDetailed(prompt, {
      system,
      schema,
      maxTokens,
      deadline,
      timeoutMs,
      signal: turn.signal,
      minMs: MIN_STAGE_MS,
    })
    turn.calls += 1
    if (retry) turn.retries += 1
    Object.assign(entry, {
      waitMs: result.waitMs,
      ms: result.ms,
      input: result.usage.input,
      output: result.usage.output,
      ok: Boolean(result.data),
      reason: result.data ? null : 'invalid',
    })
    const problem = result.data
      ? ''
      : result.finish === 'length'
        ? '｜輸出被截斷，無法解析'
        : '｜輸出無法解析'
    console.log(
      `${head}｜排隊 ${result.waitMs}ms｜生成 ${result.ms}ms｜輸入 ${result.usage.input} / 輸出 ${result.usage.output} tokens${problem}`,
    )
    return result.data ? { data: result.data } : { data: null, reason: 'invalid' }
  } catch (error) {
    const reason = error.kind || 'unknown'
    // 還沒輪到就放棄的（來不及、排隊已滿、排隊時被取消）沒有真的用到模型，不算一次呼叫
    const reached = !(
      reason === 'deadline' ||
      reason === 'busy' ||
      (reason === 'cancelled' && !error.ms)
    )
    if (reached) {
      turn.calls += 1
      if (retry) turn.retries += 1
    }
    if (reason === 'timeout') turn.timeouts += 1
    if (reason !== 'cancelled') turn.error = error
    Object.assign(entry, { waitMs: error.waitMs ?? 0, ms: error.ms ?? 0, reason })
    console.warn(
      `${head}｜失敗：${reason}｜排隊 ${entry.waitMs}ms｜生成 ${entry.ms}ms｜${error.message}`,
    )
    return { data: null, reason }
  }
}

// 產生一位角色的發言。candidates 只有一位時就是那一位，有多位時由 AI 選最適合的。
//   said：這一輪前面的人說了什麼；later：後面還有幾位要發言；canAsk：可不可以問使用者問題
// 回傳 { reply: { member, text, wrapUp, focus } }；失敗時 reply 是 null，reason 是原因。
const generateCharacterReply = async (
  turn,
  { candidates, said, focus, later, canAsk, retry = false },
) => {
  const position = said.length
  const first = position === 0
  let plan = planCall(turn, later, first)
  if (!plan) return { reply: null, reason: 'deadline' }

  const { schema, task } = buildTask(position, candidates, said, focus, canAsk)
  const label = `第${'一二三'[position]}位 ${candidates.map((member) => member.name).join('/')}`
  const { system, context } = buildPartyPrompt({
    speakers: candidates,
    recentDialogue: turn.party.lines,
    topicState: focus,
    userTexts: turn.texts,
    said,
  })
  const request = {
    system,
    prompt: `${context}\n\n${task}`,
    schema,
    maxTokens: Math.max(...candidates.map((member) => member.maxTokens)) + JSON_OVERHEAD_TOKENS,
    retry,
  }
  let result = await callModel(turn, label, { ...request, ...plan })
  // 排隊排到保留給後面的時間都用掉了（這時還沒用到模型）：不再替後面的人留時間，用整輪剩下的再排一次
  if (!result.data && result.reason === 'deadline' && plan.deadline < turn.deadline) {
    plan = planCall(turn, 0, first)
    if (plan) result = await callModel(turn, label, { ...request, ...plan })
  }
  if (!result.data) return { reply: null, reason: result.reason }
  turn.cold = false // 有回應就表示模型已經載入

  let text = cleanText(result.data.text)
  // 不該問使用者問題的時候，結尾的問句由程式拿掉，不只靠提示詞
  if (!canAsk) text = stripTrailingQuestions(text)
  if (!text) return { reply: null, reason: 'invalid' }
  return {
    reply: {
      member: candidates.find((member) => member.name === result.data.speaker) || candidates[0],
      text,
      wrapUp: result.data.wrap_up === true,
      focus: String(result.data.focus_topic || focus || '').slice(0, 30),
    },
  }
}

// cast 是這一輪的候選人（最多三位），named 是其中被使用者點到名字的人。
// 後面的人一定要看得到前面的人說了什麼，所以依序等待，不能同時呼叫。
const sequentialReply = async (turn, cast, named) => {
  const said = []
  let pool = cast // 這一輪還沒說過話的候選人
  let called = named // 被點名、還沒說過話的人
  while (said.length < turn.planned && pool.length) {
    if (turn.signal.aborted) break
    if (said.length && said[said.length - 1].wrapUp) {
      turn.reason = '提前收尾'
      break
    }
    const first = said.length === 0
    const args = {
      // 還有被點名的人就先輪到他們，否則從剩下的候選人裡由 AI 選
      candidates: called.length ? called : pool,
      said,
      focus: first ? turn.party.focus : turn.focus,
      later: Math.min(turn.planned - said.length, pool.length) - 1,
      // 一輪最多一個人問使用者問題；上一輪已經問過的話，這一輪第一位也不問
      canAsk: first ? !turn.party.asked : !said.some((item) => isQuestion(item.text)),
    }
    let outcome = await generateCharacterReply(turn, args)
    // 暫時性的失敗重試一次。整輪只有一次機會，而且重試不佔發言名額
    if (
      !outcome.reply &&
      RETRYABLE.has(outcome.reason) &&
      turn.retries < MAX_RETRIES &&
      !turn.signal.aborted
    ) {
      outcome = await generateCharacterReply(turn, { ...args, retry: true })
    }
    // 還是失敗：保留已經產生的訊息，這一輪到此為止
    if (!outcome.reply) {
      turn.reason = outcome.reason === 'deadline' ? '時間不夠' : `生成失敗（${outcome.reason}）`
      break
    }

    const { reply } = outcome
    pool = pool.filter((member) => member !== reply.member)
    called = called.filter((member) => member !== reply.member)
    // 跟前面說過的話幾乎一樣：這一則不要，換下一位
    if (isRepeat(reply.text, said, turn.party.lines)) {
      turn.dropped += 1
      console.log(`[聚會 ${turn.tag}] ${reply.member.name} 的發言和前面重複，捨棄`)
      continue
    }
    said.push(reply)
    if (first) turn.focus = reply.focus
  }
  if (!turn.reason) turn.reason = said.length >= turn.planned ? '完成' : '候選人都輪過了'
  return said
}

const singleReply = async (turn, candidates) => {
  const label = `單次 ${candidates.map((member) => member.name).join('/')}`
  const { system, context } = buildPartyPrompt({
    speakers: candidates,
    all: true,
    recentDialogue: turn.party.lines,
    topicState: turn.party.focus,
    userTexts: turn.texts,
  })
  const request = {
    system,
    prompt: `${context}\n\n${singleTask(candidates)}`,
    schema: SINGLE_SCHEMA,
  }
  // 一次呼叫就要產生所有人的話，整輪剩下的時間都給它；暫時性的失敗重試一次
  let result = { data: null, reason: 'deadline' }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (turn.signal.aborted || turn.deadline - Date.now() < MIN_STAGE_MS) break
    result = await callModel(turn, label, {
      ...request,
      deadline: turn.deadline,
      retry: attempt > 0,
    })
    if (result.data || !RETRYABLE.has(result.reason)) break
  }
  if (!result.data) {
    turn.reason = result.reason === 'deadline' ? '時間不夠' : `生成失敗（${result.reason}）`
  } else {
    turn.reason = '完成'
  }
  // 只採用這一輪該發言的成員，順序照輪到的順序
  return candidates
    .map((member) => ({
      member,
      text: (Array.isArray(result.data) ? result.data : [])
        .find((item) => item?.name === member.name)
        ?.text?.trim(),
    }))
    .filter((item) => item.text)
}

const partyMode = () => process.env.PARTY_MODE || 'sequential'

// userId -> 一場聚會的狀態：
//   lines     聊天紀錄 ['我：…', '老周：…']
//   order     成員索引，越前面越久沒發言
//   focus     目前的話題焦點；turns：已經聊了幾輪
//   asked     上一輪有沒有人問使用者問題
//   closing   使用者已經說要結束（還沒輪到處理那則訊息）
//   current   正在生成的那一輪；updatedAt：最後有動靜的時間；lastTurn：最近一輪的統計
const parties = new Map()

export const isInParty = (userId) => parties.has(userId)

// 使用者已經說要結束聚會（之後排到的聚會訊息都不必再處理）
export const isPartyClosing = (userId) => parties.get(userId)?.closing === true

// 最近一輪的統計（模式、呼叫次數、每次呼叫的時間與 token），測試與除錯用
export const getLastTurn = (userId) => parties.get(userId)?.lastTurn

// 使用者說要結束聚會時立刻呼叫，不必等前面排隊的訊息處理完：
// 正在生成的那一輪馬上停下來，還在排隊的聚會訊息之後也不會再處理。
export const interruptParty = (userId) => {
  const party = parties.get(userId)
  if (!party) return false
  party.closing = true
  party.current?.controller.abort()
  return true
}

// 開始一場聚會，回傳開場白。角色設定載入失敗時不會開始，回傳的是說明文字（isInParty 仍是 false）
export const startParty = (userId) => {
  // 重新開始時，舊聚會還在生成的那一輪作廢
  interruptParty(userId)
  if (loadError) {
    parties.delete(userId)
    console.error(`[聚會] 無法開始聚會：${loadError}`)
    return '聚會模式目前無法啟動：角色設定檔讀取失敗（原因寫在機器人的日誌裡）。其他功能不受影響。'
  }
  parties.set(userId, {
    lines: [],
    order: MEMBERS.map((_, i) => i),
    focus: '',
    turns: 0,
    asked: false,
    closing: false,
    current: null,
    updatedAt: Date.now(),
  })
  return `🎉 聚會開始！今天來的有：\n${MEMBERS.map((member) => `・${member.name}（${member.intro}）`).join('\n')}\n\n都是多年的老同學，彼此很熟。隨便說句話，大家就會輪流回你。想離開時傳「結束聚會」。`
}

// 結束聚會（正在生成的那一輪也一起作廢）；本來不在聚會中則回傳 false
export const endParty = (userId) => {
  interruptParty(userId)
  return parties.delete(userId)
}

// 清掉這場聚會的聊天紀錄與話題，成員和輪替順序不變；不在聚會中則回傳 false
export const clearPartyMemory = (userId) => {
  const party = parties.get(userId)
  if (!party) return false
  party.lines = []
  party.focus = ''
  party.turns = 0
  party.asked = false
  party.updatedAt = Date.now()
  return true
}

// 太久沒人說話的聚會自動結束，免得越積越多
export const sweepParties = (now = Date.now()) => {
  for (const [userId, party] of parties) {
    if (!party.current && now - party.updatedAt > PARTY_TTL_MS) parties.delete(userId)
  }
  return parties.size
}
setInterval(sweepParties, 10 * 60 * 1000).unref()

const toMessage = (member, text) => ({
  type: 'text',
  text: text.slice(0, 5000),
  sender: {
    name: member.name,
    ...(member.avatar && AVATAR_BASE_URL
      ? { iconUrl: `${AVATAR_BASE_URL}/${member.avatar}` }
      : {}),
  },
})

// 這一輪是不是還有效：聚會還在、使用者沒說要結束、也沒被取消。
// 生成需要時間，這段期間聚會可能已經結束，所以送出訊息之前要再確認一次。
export const isPartyTurnActive = (userId, turn) =>
  Boolean(turn) && parties.get(userId) === turn.party && !turn.party.closing && !turn.signal.aborted

// 一輪結束後更新聊天紀錄，每一輪只會寫一次。delivered 表示訊息有沒有送到使用者手上：
//   有送到 → 使用者說的話和成員的發言都寫進紀錄，說過話的人排到隊伍最後
//   沒送到（生成失敗、LINE 回覆失敗）→ 只記使用者說的話，成員的發言不算數
//   聚會已經結束或重新開始 → 這一輪作廢，什麼都不寫
export const finishPartyTurn = (userId, turn, delivered) => {
  if (!turn || turn.finished) return false
  turn.finished = true
  const { party } = turn
  if (party.current === turn) party.current = null
  if (parties.get(userId) !== party || party.closing) return false

  const userLines = turn.texts.map((text) => `我：${text}`)
  party.updatedAt = Date.now()
  if (!delivered || turn.said.length === 0) {
    party.lines = [...party.lines, ...userLines].slice(-MAX_LINES)
    return false
  }
  party.lines = [
    ...party.lines,
    ...userLines,
    ...turn.said.map((item) => `${item.member.name}：${item.text}`),
  ].slice(-MAX_LINES)
  // 說過話的人排到隊伍最後，這一輪沒輪到的人下一輪優先
  const spoken = turn.said.map((item) => MEMBERS.indexOf(item.member))
  party.order = [...party.order.filter((index) => !spoken.includes(index)), ...spoken]
  party.focus = turn.focus
  party.turns += 1
  party.asked = turn.said.some((item) => isQuestion(item.text))
  return true
}

// 產生一輪回覆。texts 是使用者這一輪說的話（字串或陣列；連續傳來的幾則會合併成一輪）。
// options：
//   deadline  整輪生成最晚要在什麼時候結束（絕對時間，從收到訊息起算，由 index.js 決定）
//   signal    取消用；turnId、user：寫在日誌裡的輪次編號與遮罩過的使用者代號
// 回傳這一輪的資料，其中 messages 是要送出的 LINE 訊息（每則帶有成員的名稱與頭像）。
// 訊息送出之後一定要呼叫 finishPartyTurn()，聊天紀錄才會更新。
// 被取消時（例如使用者結束了聚會）回傳 null；一則都沒產生則丟出錯誤。
export const partyReply = async (userId, texts, { deadline, signal, turnId, user } = {}) => {
  const party = parties.get(userId)
  if (!party) throw new Error('聚會模式：目前沒有進行中的聚會')
  const startedAt = Date.now()
  // 這一輪專用的取消開關：使用者結束聚會，或呼叫端取消時都會觸發
  const controller = new AbortController()
  if (signal?.aborted || party.closing) controller.abort()
  else signal?.addEventListener('abort', () => controller.abort(), { once: true })

  const turn = {
    party,
    texts: [texts].flat().map((text) => String(text)),
    tag: `t=${turnId || startedAt.toString(36)}${user ? ` u=${user}` : ''}`,
    mode: partyMode(),
    deadline: deadline ?? startedAt + DEFAULT_TURN_MS,
    controller,
    signal: controller.signal,
    cold: false, // 模型還沒載入（第一次成功呼叫後就改回 false）
    planned: SPEAKERS_PER_TURN, // 這一輪最多幾個人說話
    calls: 0, // 實際用到模型的次數（含重試）
    retries: 0,
    timeouts: 0,
    dropped: 0, // 因為重複而捨棄的發言
    log: [],
    focus: party.focus,
    error: null,
    reason: '', // 這一輪怎麼結束的
    said: [],
    messages: [],
    finished: false,
  }
  party.current = turn

  if (!turn.signal.aborted) {
    const joined = turn.texts.join('\n')
    turn.planned = planSpeakers(joined)
    // 這一輪的候選人：被點名的優先，其餘照「最久沒發言」補到三位
    const named = mentionedMembers(joined)
    const idle = party.order.map((index) => MEMBERS[index])
    const cast = [...named, ...idle.filter((member) => !named.includes(member))].slice(
      0,
      SPEAKERS_PER_TURN,
    )
    // 模型還沒載入的話，第一次呼叫要等它載入，時間的分法不一樣（見 planCall）
    turn.cold = (await isModelLoaded()) === false
    const coldStart = turn.cold
    turn.said =
      turn.mode === 'single'
        ? await singleReply(turn, cast)
        : await sequentialReply(
            turn,
            cast,
            cast.filter((member) => named.includes(member)),
          )
    turn.cold = coldStart
  }
  if (turn.signal.aborted) turn.reason = '已取消'

  const ms = Date.now() - startedAt
  party.lastTurn = {
    mode: turn.mode,
    calls: turn.calls,
    retries: turn.retries,
    timeouts: turn.timeouts,
    dropped: turn.dropped,
    ms,
    cold: turn.cold,
    planned: turn.planned,
    focus: turn.focus,
    speakers: turn.signal.aborted ? 0 : turn.said.length,
    reason: turn.reason,
    log: turn.log,
  }
  // 日誌只記時間、次數和結果，不記聊天內容與話題
  console.log(
    `[聚會 ${turn.tag}] 本輪 ${turn.mode}｜${MODEL}｜${turn.cold ? '模型冷啟動｜' : ''}${party.lastTurn.speakers} 則（最多 ${turn.planned}）｜呼叫 ${turn.calls} 次（重試 ${turn.retries}、逾時 ${turn.timeouts}）｜共 ${ms}ms｜${turn.reason}`,
  )

  // 被取消：不發言。聚會還在的話（不是使用者結束的），使用者說的話仍然留在紀錄裡
  if (turn.signal.aborted) {
    finishPartyTurn(userId, turn, false)
    return null
  }
  // 一則都沒有：使用者說的話照樣留在紀錄裡，再把錯誤丟出去，由 index.js 回覆錯誤訊息
  if (turn.said.length === 0) {
    finishPartyTurn(userId, turn, false)
    throw turn.error || new Error('聚會模式：AI 沒有回傳可用的訊息')
  }
  turn.messages = turn.said.map((item) => toMessage(item.member, item.text))
  return turn
}
