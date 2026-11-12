// 聚會模式：AI 扮演六位朋友，使用者每說一句話，就輪最多三位出來聊天。
// 有兩種產生方式，用 .env 的 PARTY_MODE 切換：
//   sequential：每位角色各呼叫一次 AI，後面的人看得到前面的人剛說的話（對話比較連貫，但比較慢）
//   single：一次呼叫產生三個人的話（比較快）
// 沒設定時用 sequential。
import { generateJsonDetailed } from './OpenAI.js'

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
    persona:
      '大嗓門、自來熟的健身教練。講話直白不修飾，情緒都寫在臉上，什麼話題都能扯到運動和吃蛋白質，第一次見面就想揪人出去。神經大條，常沒發現別人尷尬。',
  },
  {
    name: '小雯',
    avatar: 'wen.png',
    intro: '護理師',
    persona:
      '內向怕生的護理師。話很少、很客氣，常說「不好意思」「那個…」，不敢反駁別人，被點名會緊張。但一聽到有人不舒服或太累，就會忍不住小聲關心。',
  },
  {
    name: 'Kevin',
    avatar: 'kevin.png',
    intro: '工程師',
    persona:
      '冷淡、惜字如金的軟體工程師。只講事實和數據，愛糾正別人說錯的地方，完全不會看氣氛，也不會安慰人。句子很短、沒有語氣詞和表情符號，偶爾冒出一句很冷的笑話。',
  },
  {
    name: '美玲姐',
    avatar: 'meiling.png',
    intro: '行銷主管',
    persona:
      '強勢、嘴快的行銷主管，年紀最大。習慣主導話題和幫大家做決定，愛打聽別人的工作、收入和感情狀況，像在面試人。有話直說、愛吐槽，但其實是刀子嘴豆腐心。',
  },
  {
    name: '小宇',
    avatar: 'yu.png',
    intro: '大學生',
    persona:
      '年紀最小的大學生，屁孩一個。滿口網路梗和表情符號，愛起鬨、愛亂接話，沒大沒小，最愛抓別人剛說的話來吐槽。窮學生，聽到要花錢就哀號。',
  },
  {
    name: '艾莉',
    avatar: 'ellie.png',
    intro: '插畫家',
    persona:
      '慢半拍、活在自己世界的插畫家。說話輕飄飄的，常用「…」，看事情的角度很怪，別人在講實際的事，她注意到的是那件事的顏色、氣味或感覺。對錢和計畫沒概念，不喜歡人多和吵鬧。',
  },
]

// 每位角色的稱呼、說話長度與輸出上限（sequential 模式用）
const SPEECH = {
  阿哲: { call: '阿哲', length: '一到兩句，音量大、驚嘆號多', maxTokens: 110 },
  小雯: { call: '小雯', length: '一句，很短，常欲言又止', maxTokens: 70 },
  Kevin: { call: 'Kevin', length: '一句，短而平，用句號結尾', maxTokens: 60 },
  美玲姐: { call: '美玲', length: '一到兩句，語速快、直接下結論', maxTokens: 110 },
  小宇: { call: '小宇', length: '一到兩句，可以用一個表情符號', maxTokens: 110 },
  艾莉: { call: '艾莉', length: '一句，慢慢的，可以用「…」', maxTokens: 90 },
}
const callName = (member) => SPEECH[member.name].call

// 原本就認識的成員；沒列到的都是今天第一次見面
const ACQUAINTED = [
  ['阿哲', '小宇', '只見過一次（小宇上過阿哲的健身體驗課），認識但不熟'],
  ['美玲姐', 'Kevin', '以前待過同一家公司的不同部門，只是點頭之交'],
]

const SPEAKERS_PER_TURN = 3 // LINE 一次最多回 5 則訊息
const MAX_LINES = 30 // 保留最近幾句聊天紀錄
const MAX_CALLS = 3 // 每一輪最多呼叫 AI 幾次（含重試）
const TURN_MS = 45 * 1000 // 整輪時限；LINE 的回覆權杖約一分鐘後失效
const STAGE_MS = [40 * 1000, 15 * 1000, 15 * 1000] // 各階段單次呼叫的時限；第一次可能要等模型載入
const MIN_STAGE_MS = 4 * 1000 // 剩下的時間比這個少就不再呼叫
const WARM_UP_TURNS = 6 // 聊了這麼多輪之後，初次見面的人才不那麼拘謹
const JSON_OVERHEAD_TOKENS = 120 // 訊息以外的欄位（焦點、承接檢查）大約會用掉的 token

// ---------- single 模式：一次產生三個人的話 ----------
const SINGLE_SYSTEM_PROMPT = `你要扮演一場朋友聚會裡的多位成員，和使用者在 LINE 群組聊天。成員如下：
${MEMBERS.map((member) => `- ${member.name}：${member.persona}`).join('\n')}

彼此的關係：
- 這場聚會是使用者約的。每位成員都是使用者的朋友，跟使用者很熟，但來自不同的圈子，成員之間並不熟。
- 阿哲和小宇只見過一次（小宇去上過阿哲的健身體驗課），算認識但不熟。
- 美玲姐和 Kevin 以前待過同一家公司的不同部門，只是點頭之交。
- 小雯和艾莉是第一次見到其他所有成員。其餘沒提到的成員之間也都是第一次見面。
- 不熟的人之間會比較客氣、有距離：會問對方做什麼工作、怎麼認識使用者，偶爾接不上話或有點尷尬，不會亂取綽號，也不會提到共同的往事（因為沒有）。
- 聊天紀錄越長，成員之間可以慢慢變熟一點，但不要突然變成老朋友。

規則：
- 使用者在聊天紀錄裡標示為「我」。
- 每位成員一則訊息，一到兩句話，越短越像真人，不要寫成完整的書面句子。
- 用台灣人平常在 LINE 上跟朋友聊天的口語：多用「欸」「啦」「吧」「耶」「喔」「齁」「蛤」「真的假的」「超」「有夠」「傻眼」「笑死」這類語氣詞和說法，可以省略主詞。
- 不要像客服、老師或文章那樣說話：不要用「建議你」「記得要」「根據」「如果…的話」這種說教或條列式的句型，也不要每句都給建議。
- 只用台灣的繁體字和台灣用語，不可以出現簡體字或中國用語（例如要說「影片」不說「視頻」、「品質」不說「質量」、「超讚」不說「給力」）。
- 英文最多夾一兩個單字，不要整句英文。
- 每個人的語氣、句子長短和關注的事情要差很多，光看內容就猜得出是誰說的，不要每個人都熱情又健談。
- 這是一段連貫的對話，不是每個人各自回答使用者。每一輪只圍繞一個焦點：使用者剛剛說的那件事。
- 第一位發言者直接回應使用者說的話。第二位要接第一位的話（附和、反駁、吐槽或追問），第三位再接前面兩位的話，三則連起來要像同一段對話，讀得出誰在回誰。
- 接話時要提到前一個人說的具體內容，不要只是各自發表對主題的看法，也不要重複別人說過的內容。
- 不要自己開新話題。聊天紀錄裡正在聊的事要延續下去，前面說過的細節（地點、決定、誰說了什麼）要記得、不要矛盾，直到使用者換話題為止。
- 個性要表現在「怎麼回應這個話題」上，不是各說各話。例如艾莉會用她奇怪的角度看同一件事，Kevin 會挑這件事裡的數據或錯誤。
- 每一輪最多一個人向使用者提問，而且要跟正在聊的事有關。其他人不要用問句結尾。
- 用繁體中文，不要用 Markdown，訊息開頭不要寫自己的名字。`

const SINGLE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { name: { type: 'STRING' }, text: { type: 'STRING' } },
    required: ['name', 'text'],
  },
}

// ---------- sequential 模式：每位角色各呼叫一次 ----------
const STYLE_RULES = `稱呼規則：
- 初次見面：只用名字稱呼對方，不加「哥」「姐」「親愛的」「寶貝」這類親密稱呼，不取綽號，語氣比較客氣、有點距離。
- 一般熟悉：用名字，或聊天紀錄裡已經出現過的稱呼。
- 熟識：可以用暱稱，但只能用聊天紀錄裡出現過的。
- 稱呼使用者一律用「你」。
- 不可以捏造不存在的共同經歷或親密關係（例如「上次我們一起…」），除非聊天紀錄裡真的有。

說話方式：
- 用台灣人平常在 LINE 上跟朋友聊天的口語，越短越像真人，不要寫成完整的書面句子，可以省略主詞。語氣詞（欸、啦、齁、蛤、耶、喔）用多用少照人設決定。
- 不要像客服、老師或文章那樣說話：不要用「建議你」「記得要」「如果…的話」這種說教句型，也不要每次都給建議。
- 只用台灣的繁體字和台灣用語，不可以出現簡體字或中國用語（例如要說「影片」不說「視頻」、「品質」不說「質量」）。
- 不要夾英文。只有本來就用英文講的專有名詞可以（例如 AI、LINE、WiFi、App）。
- 不要用「我覺得」開頭，也不要用「確實」「沒錯」「說得對」「對啊」這類附和當開場，直接講內容。
- 不要用 Markdown，不要加引號，訊息開頭不要寫名字。`

const relation = (a, b, turns) => {
  const known = ACQUAINTED.find(
    ([x, y]) => (x === a.name && y === b.name) || (x === b.name && y === a.name),
  )
  if (known) return `一般熟悉：${known[2]}`
  return turns >= WARM_UP_TURNS
    ? '一般熟悉：今天才認識，已經聊了一陣子，沒那麼拘謹了'
    : '初次見面：今天第一次見到'
}

const describe = (member, turns) =>
  `【${member.name}】
人設：${member.persona}
說話長度：${SPEECH[member.name].length}
跟其他人的熟悉程度：
- 使用者 —— 熟識：是你的好朋友
${MEMBERS.filter((other) => other !== member)
  .map((other) => `- ${callName(other)}（${other.intro}）—— ${relation(member, other, turns)}`)
  .join('\n')}`

// candidates 只有一位時就是扮演那一位；有多位時由 AI 選一位
const buildSystem = (candidates, turns) =>
  `${
    candidates.length === 1
      ? `你正在扮演「${candidates[0].name}」`
      : `你要從下面 ${candidates.length} 位候選人裡選一位來扮演`
  }，在一場朋友聚會的 LINE 群組裡聊天。這場聚會是使用者約的，使用者在聊天紀錄裡標示為「我」；成員來自不同的圈子，彼此大多不熟。
你只能寫這一位角色自己的一則訊息，不可以替其他人發言，也不可以改寫或捏造別人說過的話。

${candidates.map((member) => describe(member, turns)).join('\n\n')}

${STYLE_RULES}`

// 紀錄裡的發話者改用稱呼（美玲姐 → 美玲），免得不熟的人跟著叫「姐」
const asCalled = (line) => {
  const member = MEMBERS.find((item) => line.startsWith(`${item.name}：`))
  return member ? callName(member) + line.slice(member.name.length) : line
}

const buildContext = (party, userText, said, focus) =>
  [
    `聊天紀錄（舊到新）：\n${party.lines.length ? party.lines.map(asCalled).join('\n') : '（聚會剛開始，還沒有紀錄）'}`,
    `目前的話題焦點：${focus || '（還沒有）'}`,
    `使用者最新訊息：\n我：${userText}`,
    said.length
      ? `這一輪已經發言（依序）：\n${said.map((item) => `${callName(item.member)}：${item.text}`).join('\n')}`
      : '這一輪還沒有人發言。',
  ].join('\n\n')

const isQuestion = (text) => /[?？]/.test(text)

// 三個階段各自的任務說明與輸出格式
const buildTask = (stage, candidates, said, focus) => {
  if (stage === 0) {
    return {
      schema: {
        type: 'OBJECT',
        properties: {
          focus_topic: { type: 'STRING' },
          speaker: { type: 'STRING', enum: candidates.map((member) => member.name) },
          text: { type: 'STRING' },
          wrap_up: { type: 'BOOLEAN' },
        },
        required: ['focus_topic', 'speaker', 'text', 'wrap_up'],
        propertyOrdering: ['focus_topic', 'speaker', 'text', 'wrap_up'],
      },
      task: `你的任務（這一輪第一位發言）：
1. focus_topic：用十個字以內寫出這一輪的話題焦點。使用者如果是在接續目前的話題，就沿用原本的焦點；提出新的事情，才換成新的焦點。
2. speaker：從候選人（${candidates.map((member) => member.name).join('、')}）裡，選出最適合回應這句話的人。
3. text：用這個人的身分，直接回應使用者最新訊息。只講一個重點，不要一次講完所有觀點，留空間給後面的人接話。可以問使用者一個跟焦點有關的問題。
4. wrap_up：這個話題是否到此就夠了、不需要其他人再接話。只有使用者是單純打招呼、道謝或道別，而你已經回應完的時候才填 true，其他情況一律填 false。

寫之前先確認：有沒有回應到使用者真正在說的事？有沒有跟聊天紀錄裡講過的內容矛盾？有沒有偏離焦點？`,
    }
  }

  const speaker = candidates[0]
  const previous = said.map((item) => callName(item.member))
  const last = previous[previous.length - 1]
  const askRule = said.some((item) => isQuestion(item.text))
    ? '這一輪已經有人提問了，你不要再問使用者問題，也不要用問句結尾。'
    : '可以問使用者一個跟焦點有關的問題，也可以不問。'
  const checks = `寫之前先確認：${last} 實際說了什麼？他的核心觀點是什麼？我有沒有在回應這個觀點？有沒有跟前面的內容矛盾？有沒有偏離焦點「${focus}」？`

  if (stage === 1) {
    return {
      schema: {
        type: 'OBJECT',
        properties: {
          previous_point: { type: 'STRING' },
          stance: { type: 'STRING', enum: ['同意', '補充', '質疑', '反駁', '吐槽'] },
          text: { type: 'STRING' },
          wrap_up: { type: 'BOOLEAN' },
        },
        required: ['previous_point', 'stance', 'text', 'wrap_up'],
        propertyOrdering: ['previous_point', 'stance', 'text', 'wrap_up'],
      },
      task: `你的任務（這一輪第二位發言，你是${speaker.name}）：
1. previous_point：用一句話寫出 ${last} 剛剛那則訊息的核心觀點。
2. stance：你要怎麼接他的話。照你的人設決定，不需要認同他。
3. text：接 ${last} 的話。要提到他說的具體內容，讓人看得出你是在回他；不要只是重新回答使用者的問題，也不要重複他講過的內容。如果你反對，要說出反對的是哪一點、為什麼。${askRule}
4. wrap_up：你說完之後，這段對話是否已經自然收尾、不需要第三個人再說話。通常填 false。

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

const NAME_PATTERN = [...MEMBERS.flatMap((member) => [member.name, callName(member)]), '我'].join(
  '|',
)

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

// 呼叫一次 AI 並記錄時間、模型與 token 用量；超過次數或時間上限、或呼叫失敗時回傳 null
const callModel = async (turn, label, { system, prompt, schema, maxTokens, timeoutMs }) => {
  const remaining = turn.deadline - Date.now()
  if (turn.calls >= MAX_CALLS || remaining < MIN_STAGE_MS) return null
  turn.calls += 1
  const startedAt = Date.now()
  try {
    const { data, model, usage } = await generateJsonDetailed(prompt, {
      system,
      schema,
      maxTokens,
      timeoutMs: Math.min(timeoutMs, remaining),
    })
    const ms = Date.now() - startedAt
    turn.log.push({ label, model, ms, input: usage.input, output: usage.output, ok: Boolean(data) })
    console.log(
      `[聚會] ${label}｜${model}｜${ms}ms｜輸入 ${usage.input} / 輸出 ${usage.output} tokens${data ? '' : '｜輸出無法解析'}`,
    )
    return data
  } catch (error) {
    const ms = Date.now() - startedAt
    turn.error = error
    turn.log.push({ label, model: null, ms, input: null, output: null, ok: false })
    console.warn(`[聚會] ${label}｜失敗（${ms}ms）：${error.message}`)
    return null
  }
}

// 產生一位角色的發言。candidates 只有一位時就是那一位，有多位時（第一階段）由 AI 選最適合的。
// 回傳 { member, text, wrapUp, focus }，失敗回傳 null。
const generateCharacterReply = async (turn, { party, candidates, userText, said, focus }) => {
  const stage = said.length
  const { schema, task } = buildTask(stage, candidates, said, focus)
  const data = await callModel(
    turn,
    `第${'一二三'[stage]}位 ${candidates.map((member) => member.name).join('/')}`,
    {
      system: buildSystem(candidates, party.turns),
      prompt: `${buildContext(party, userText, said, focus)}\n\n${task}`,
      schema,
      maxTokens:
        Math.max(...candidates.map((member) => SPEECH[member.name].maxTokens)) +
        JSON_OVERHEAD_TOKENS,
      timeoutMs: STAGE_MS[stage],
    },
  )
  const text = cleanText(data?.text)
  if (!text) return null
  return {
    member: candidates.find((member) => member.name === data.speaker) || candidates[0],
    text,
    wrapUp: data.wrap_up === true,
    focus: String(data.focus_topic || focus || '').slice(0, 30),
  }
}

const sequentialReply = async (turn, party, candidates, userText) => {
  const said = []
  // 第一位：失敗時在呼叫次數上限內重試一次
  let first = null
  for (let attempt = 0; attempt < 2 && !first; attempt++) {
    first = await generateCharacterReply(turn, {
      party,
      candidates,
      userText,
      said,
      focus: party.focus,
    })
  }
  if (!first) return said
  said.push(first)
  turn.focus = first.focus

  // 第二、三位：一定要看得到前面的人說了什麼，所以依序等待，不能同時呼叫
  for (const member of candidates.filter((candidate) => candidate !== first.member)) {
    if (said[said.length - 1].wrapUp) break
    const reply = await generateCharacterReply(turn, {
      party,
      candidates: [member],
      userText,
      said,
      focus: turn.focus,
    })
    // 後面的人失敗時，保留已經產生的訊息
    if (!reply) break
    said.push(reply)
  }
  return said
}

const singleReply = async (turn, party, candidates, userText) => {
  const lines = [...party.lines, `我：${userText}`]
  const result = await callModel(
    turn,
    `單次 ${candidates.map((member) => member.name).join('/')}`,
    {
      system: SINGLE_SYSTEM_PROMPT,
      prompt: `聊天紀錄：\n${lines.join('\n')}\n\n請產生接下來的訊息，依序由「${candidates.map((member) => member.name).join('、')}」發言，每人一則。`,
      schema: SINGLE_SCHEMA,
      timeoutMs: TURN_MS,
    },
  )
  // 只採用這一輪該發言的成員，順序照輪到的順序
  return candidates
    .map((member) => ({
      member,
      text: (Array.isArray(result) ? result : [])
        .find((item) => item?.name === member.name)
        ?.text?.trim(),
    }))
    .filter((item) => item.text)
}

const partyMode = () => process.env.PARTY_MODE || 'sequential'

// userId -> { lines: ['我：…', '阿哲：…'], order: 成員索引（越前面越久沒發言）, focus, turns, lastTurn }
const parties = new Map()

export const isInParty = (userId) => parties.has(userId)

// 最近一輪的統計（模式、呼叫次數、每次呼叫的時間與 token），測試與除錯用
export const getLastTurn = (userId) => parties.get(userId)?.lastTurn

export const startParty = (userId) => {
  parties.set(userId, { lines: [], order: MEMBERS.map((_, i) => i), focus: '', turns: 0 })
  return `🎉 聚會開始！今天來的有：\n${MEMBERS.map((member) => `・${member.name}（${member.intro}）`).join('\n')}\n\n他們都是你的朋友，但彼此還不太熟，有些人是第一次見面。隨便說句話，大家就會輪流回你。想離開時傳「結束聚會」。`
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
  const mode = partyMode()
  const startedAt = Date.now()
  const turn = { deadline: startedAt + TURN_MS, calls: 0, log: [], focus: party.focus, error: null }
  // 這一輪的候選人：最久沒發言的三位
  const candidates = party.order.slice(0, SPEAKERS_PER_TURN).map((index) => MEMBERS[index])

  const replies = await (mode === 'single' ? singleReply : sequentialReply)(
    turn,
    party,
    candidates,
    text,
  )
  party.lastTurn = {
    mode,
    calls: turn.calls,
    ms: Date.now() - startedAt,
    focus: turn.focus,
    speakers: replies.length,
    log: turn.log,
  }
  console.log(
    `[聚會] 本輪 ${mode}｜${replies.length} 則｜呼叫 ${turn.calls} 次｜共 ${party.lastTurn.ms}ms｜焦點：${turn.focus || '—'}`,
  )
  // 一則都沒有：把原本的錯誤丟出去，由 index.js 回覆錯誤訊息
  if (replies.length === 0) throw turn.error || new Error('聚會模式：AI 沒有回傳可用的訊息')

  party.lines = [
    ...party.lines,
    `我：${text}`,
    ...replies.map((item) => `${item.member.name}：${item.text}`),
  ].slice(-MAX_LINES)
  // 說過話的人排到隊伍最後，這一輪沒輪到的人下一輪優先
  const spoken = replies.map((item) => MEMBERS.indexOf(item.member))
  party.order = [...party.order.filter((index) => !spoken.includes(index)), ...spoken]
  party.focus = turn.focus
  party.turns += 1
  return replies.map((item) => toMessage(item.member, item.text))
}
