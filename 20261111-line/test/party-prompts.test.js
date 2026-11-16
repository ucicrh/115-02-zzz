// 聚會的角色檔與提示詞組裝：不啟動機器人、不呼叫模型，只測 party.js 的載入與組裝
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DOTENV_CONFIG_PATH = 'test/no-such.env'
const PROMPTS = fileURLToPath(new URL('../prompts', import.meta.url))
const AVATARS = fileURLToPath(new URL('../avatars', import.meta.url))
const party = await import('../party.js')
const { MEMBERS, buildPartyPrompt, loadPartyPrompts } = party

const temps = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
// 做一個暫時的 prompts 資料夾；files 沒給的檔案就用專案裡正式的那一份
const makeDir = (files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'party-prompts-'))
  temps.push(dir)
  for (const name of ['personas.json', 'party_mode_prompt.md']) {
    const content = name in files ? files[name] : readFileSync(join(PROMPTS, name), 'utf8')
    if (content !== null) writeFileSync(join(dir, name), content)
  }
  return dir
}
const personas = () => JSON.parse(readFileSync(join(PROMPTS, 'personas.json'), 'utf8'))
const withPersonas = (change) => {
  const data = personas()
  change(data)
  return makeDir({ 'personas.json': JSON.stringify(data) })
}

test('正式的角色檔：六位角色都載入，簡介、字數範圍、輸出上限與頭像齊全', () => {
  assert.equal(party.getPartyLoadError(), null)
  assert.deepEqual(
    MEMBERS.map((member) => member.name),
    ['老周', '老馮', '小楷', '阿湛', '小蔡', '老錢'],
  )
  for (const member of MEMBERS) {
    assert.ok(member.intro.length > 0 && member.intro.length <= 20)
    assert.ok(member.length.sentences[0] <= member.length.sentences[1])
    assert.ok(member.maxTokens >= 60 && member.maxTokens <= 160, `${member.name} ${member.maxTokens}`)
    assert.match(member.avatar, /^[a-z]+\.png$/)
    assert.ok(existsSync(join(AVATARS, member.avatar)), `avatars/${member.avatar} 存在`)
  }
  assert.match(loadPartyPrompts(PROMPTS).avatarBaseUrl, /^https:\/\/.+\/avatars$/)
  // 輸出上限跟著字數範圍走：話最多的老周最高，一句話的阿湛最低
  const tokens = Object.fromEntries(MEMBERS.map((member) => [member.name, member.maxTokens]))
  assert.ok(tokens.老周 > tokens.老錢 && tokens.老錢 > tokens.阿湛)
})

test('組裝：只有一位發言者時，提示詞裡只有他的角色卡', () => {
  for (const speaker of MEMBERS) {
    const { system } = buildPartyPrompt({ speakers: [speaker] })
    assert.ok(system.includes(`【${speaker.name}】${speaker.intro}`))
    assert.ok(system.includes(`這一次你扮演「${speaker.name}」。`))
    for (const other of MEMBERS.filter((member) => member !== speaker)) {
      assert.ok(!system.includes(`【${other.name}】`), `${speaker.name} 的提示詞裡有 ${other.name} 的卡`)
      assert.ok(!system.includes(other.identity), '沒有別人的身分描述')
      assert.ok(!system.includes(other.tone), '沒有別人的語氣描述')
      for (const example of other.examples) assert.ok(!system.includes(example))
    }
  }
})

test('組裝：多位候選人時只放這幾位的卡；single 模式用同一個函式', () => {
  const cast = MEMBERS.slice(0, 3)
  const choose = buildPartyPrompt({ speakers: cast })
  const all = buildPartyPrompt({ speakers: cast, all: true })
  for (const { system } of [choose, all]) {
    for (const member of cast) assert.ok(system.includes(`【${member.name}】`))
    for (const member of MEMBERS.slice(3)) assert.ok(!system.includes(`【${member.name}】`))
  }
  assert.ok(choose.system.includes('從下面 3 位候選人裡選一位來扮演'))
  assert.ok(all.system.includes('依序扮演下面 3 位角色'))
  // single 模式沒有「這一輪已經發言」這一段
  assert.ok(!all.context.includes('這一輪'))
})

test('組裝：佔位符全部被換掉；沒有查詢結果、沒有禁用片語時不會留下佔位符', () => {
  const empty = buildPartyPrompt({ speakers: [MEMBERS[0]], userTexts: ['你好'], said: [] })
  assert.ok(!/\{[a-z_]+\}/.test(empty.system), '沒有殘留的佔位符')
  assert.ok(!empty.system.includes('tool_result'))
  assert.ok(empty.system.includes('查詢結果：\n（這一輪沒有查詢結果）'))
  assert.ok(empty.system.includes('禁用片語：\n（目前沒有）'))
  assert.ok(!empty.system.includes('user_name'))
  assert.ok(empty.system.includes('對話中稱呼使用者為「你」'))

  const filled = buildPartyPrompt({
    speakers: [MEMBERS[1]],
    recentDialogue: ['我：前一句', '老周：回前一句'],
    topicState: '聚餐地點',
    userTexts: ['那就這樣'],
    said: [{ member: MEMBERS[0], text: '好啊' }],
    bannedPhrases: ['保持精彩'],
    // 填進去的內容長得像佔位符也不會被二次替換
    toolResult: '台積電收盤 {persona_cards} 元',
  })
  assert.ok(filled.system.includes('查詢結果：\n台積電收盤 {persona_cards} 元'))
  assert.ok(filled.system.includes('禁用片語：\n- 保持精彩'))
  assert.equal(filled.system.split('【老馮】').length - 1, 1, '角色卡只出現一次')
  assert.equal(
    filled.context,
    [
      '聊天紀錄（舊到新）：\n我：前一句\n老周：回前一句',
      '目前的話題焦點：聚餐地點',
      '使用者最新訊息：\n我：那就這樣',
      '這一輪已經發言（依序）：\n老周：好啊',
    ].join('\n\n'),
  )
})

test('組裝：已移除的舊規定不在提示詞裡，關係是雙向的', () => {
  const { system } = buildPartyPrompt({ speakers: [MEMBERS[0]] })
  for (const removed of ['初次見面', '不要夾英文', '「沒錯」「說得對」', '彼此大多不熟']) {
    assert.ok(!system.includes(removed), `不應該還有：${removed}`)
  }
  // 老周的檔案裡沒有寫他和阿湛、老錢的關係，但對方有寫，所以他的卡上也看得到
  assert.match(system, /- 阿湛（話少愛附和的學弟）—— 他對你：附和/)
  assert.match(system, /- 老錢（早起愛打卡的校友）—— 他對你：尊敬，常道謝/)
  // 雙方都沒寫的，就是一般的老同學
  const zhan = buildPartyPrompt({ speakers: [MEMBERS[3]] }).system
  assert.match(zhan, /- 老馮（熟社區和行情的學長）—— 老同學，很熟/)
})

test('載入失敗：每一種問題都有說得出原因的錯誤訊息', () => {
  const cases = [
    [makeDir({ 'personas.json': null }), /讀不到 personas\.json（ENOENT）/],
    [makeDir({ 'party_mode_prompt.md': null }), /讀不到 party_mode_prompt\.md（ENOENT）/],
    [makeDir({ 'personas.json': '{ "personas": [' }), /personas\.json 不是合法的 JSON/],
    [makeDir({ 'personas.json': '{}' }), /沒有 personas 陣列/],
    [withPersonas((data) => (data.personas.length = 2)), /至少要有 3 位角色/],
    [withPersonas((data) => delete data.personas[1].intro), /第 2 位角色 缺少 intro/],
    [withPersonas((data) => (data.personas[2].length = { sentences: [3, 1] })), /第 3 位角色 的 length/],
    [withPersonas((data) => (data.personas[1].name = data.personas[0].name)), /重複的 name：老周/],
    [withPersonas((data) => (data.personas[0].relations.nobody = '不存在')), /不存在的角色 id「nobody」/],
    [withPersonas((data) => (data.personas[0].name = '名'.repeat(21))), /name 超過 20 個字/],
    [makeDir({ 'party_mode_prompt.md': '只有 {persona_cards}' }), /缺少佔位符 \{role_instruction\}/],
    [
      makeDir({
        'party_mode_prompt.md': '{role_instruction}{persona_cards}{tool_result}{banned_phrases}{user_name}',
      }),
      /不認得的佔位符 \{user_name\}/,
    ],
    [withPersonas((data) => (data.avatar_base_url = 'http://example.com/a')), /avatar_base_url 必須是 https 網址/],
  ]
  for (const [dir, pattern] of cases) assert.throws(() => loadPartyPrompts(dir), pattern)
  // 正常的資料夾照樣載入；頭像是選填的，沒寫就是沒有頭像
  assert.equal(loadPartyPrompts(makeDir()).members.length, 6)
  const plain = loadPartyPrompts(
    withPersonas((data) => {
      delete data.avatar_base_url
      for (const persona of data.personas) delete persona.avatar
    }),
  )
  assert.equal(plain.avatarBaseUrl, null)
  assert.ok(plain.members.every((member) => member.avatar === null))
})

test('載入失敗時：機器人不會當掉，聚會回報無法啟動，日誌有原因', async () => {
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  process.env.PARTY_PROMPTS_DIR = makeDir({ 'personas.json': '這不是 JSON' })
  let broken
  try {
    // 加上查詢字串會載入另一份獨立的模組，等於用壞掉的設定重新啟動一次
    broken = await import('../party.js?broken')
  } finally {
    delete process.env.PARTY_PROMPTS_DIR
  }
  try {
    assert.match(broken.getPartyLoadError(), /personas\.json 不是合法的 JSON/)
    assert.equal(broken.MEMBERS.length, 0)
    const greeting = broken.startParty('U-load-failure')
    assert.match(greeting, /^聚會模式目前無法啟動/)
    assert.ok(!greeting.includes('JSON'), '回給使用者的話不帶技術細節')
    assert.equal(broken.isInParty('U-load-failure'), false)
    assert.equal(broken.endParty('U-load-failure'), false)
    await assert.rejects(() => broken.partyReply('U-load-failure', '有人在嗎'), /沒有進行中的聚會/)
    assert.ok(errors.some((line) => /\[聚會\] 角色設定載入失敗.*不是合法的 JSON/.test(line)))
  } finally {
    console.error = original
  }
  // 原本正常載入的那一份不受影響
  assert.match(party.startParty('U-load-ok'), /^🎉 聚會開始！今天來的有：\n・老周（愛轉科技新聞的資深學長）/)
  assert.equal(party.endParty('U-load-ok'), true)
})
