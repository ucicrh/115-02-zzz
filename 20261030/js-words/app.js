const main = document.getElementById('main')
const stat = document.getElementById('stat')
const search = document.getElementById('search')
const catSel = document.getElementById('cat')
const lvSel = document.getElementById('lv')
const knownSel = document.getElementById('known')

let mode = 'list'
let cardIdx = 0
let cardFlipped = false
let quiz = null
let score = { right: 0, total: 0 }

// 已熟單字存在 localStorage,以「單字|中文」當 key
const keyOf = item => `${item.w}|${item.zh}`
let known = new Set()
try { known = new Set(JSON.parse(localStorage.getItem('js-words-known') || '[]')) } catch (e) { }
const save = () => {
    try { localStorage.setItem('js-words-known', JSON.stringify([...known])) } catch (e) { }
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// 分類下拉選單
const cats = [...new Set(WORDS.map(item => item.cat))]
catSel.innerHTML = '<option value="">全部分類</option>' + cats.map(c => `<option>${c}</option>`).join('')

// 依篩選條件取得單字
function filtered() {
    const kw = search.value.trim().toLowerCase()
    return WORDS.filter(item => {
        if (catSel.value && item.cat !== catSel.value) return false
        if (+lvSel.value && item.lv !== +lvSel.value) return false
        const isKnown = known.has(keyOf(item))
        if (knownSel.value === 'known' && !isKnown) return false
        if (knownSel.value === 'unknown' && isKnown) return false
        if (kw && !`${item.w} ${item.abbr || ''} ${item.zh} ${item.ex}`.toLowerCase().includes(kw)) return false
        return true
    })
}

function updateStat(list) {
    stat.textContent = `共 ${WORDS.length} 字 · 已熟 ${known.size} 字 · 目前顯示 ${list.length} 字`
}

function render() {
    const list = filtered()
    updateStat(list)
    if (!list.length) {
        main.innerHTML = '<p class="empty">沒有符合的單字</p>'
        return
    }
    if (mode === 'list') renderList(list)
    else if (mode === 'card') renderCard(list)
    else renderQuiz(list)
}

function renderList(list) {
    main.innerHTML = list.map(item => {
        const k = keyOf(item)
        return `<div class="row ${known.has(k) ? 'done' : ''}">
            <input type="checkbox" data-k="${esc(k)}" ${known.has(k) ? 'checked' : ''} title="標記為已熟">
            <div class="w">${esc(item.w)} ${item.abbr ? `<span class="abbr">(${esc(item.abbr)})</span>` : ''}</div>
            <div class="zh">${esc(item.zh)}</div>
            <div><code>${esc(item.ex)}</code></div>
            <div class="tag">${esc(item.cat)}<br>Lv.${item.lv}</div>
        </div>`
    }).join('')
}

function renderCard(list) {
    if (cardIdx >= list.length) cardIdx = 0
    const item = list[cardIdx]
    const front = `<div class="big">${esc(item.w)}</div>
        ${item.abbr ? `<div class="abbr">簡寫:${esc(item.abbr)}</div>` : ''}
        <div class="hint">點擊翻面</div>`
    const back = `<div class="big">${esc(item.zh)}</div>
        <div><code>${esc(item.ex)}</code></div>
        <div class="hint">${esc(item.cat)} · Lv.${item.lv}</div>`
    const k = keyOf(item)
    main.innerHTML = `<div class="flash">
        <div class="score">${cardIdx + 1} / ${list.length}</div>
        <div class="face" id="face">${cardFlipped ? back : front}</div>
        <div class="ctrl">
            <button class="btn" id="prev">上一個</button>
            <button class="btn" id="mark">${known.has(k) ? '取消已熟' : '標記已熟'}</button>
            <button class="btn primary" id="next">下一個</button>
        </div>
    </div>`
    const go = step => {
        cardIdx = (cardIdx + step + list.length) % list.length
        cardFlipped = false
        render()
    }
    document.getElementById('face').onclick = () => { cardFlipped = !cardFlipped; render() }
    document.getElementById('prev').onclick = () => go(-1)
    document.getElementById('next').onclick = () => go(1)
    document.getElementById('mark').onclick = () => {
        known.has(k) ? known.delete(k) : known.add(k)
        save()
        render()
    }
}

function renderQuiz(list) {
    if (list.length < 4) {
        main.innerHTML = '<p class="empty">測驗至少需要 4 個單字,請放寬篩選條件</p>'
        return
    }
    if (!quiz || !list.includes(quiz.item)) {
        const item = list[Math.floor(Math.random() * list.length)]
        // 選項:正確中文 + 3 個其他單字的中文(不重複)
        const wrongs = WORDS.filter(o => o.zh !== item.zh).sort(() => Math.random() - .5)
        const zhs = [...new Set(wrongs.map(o => o.zh))].slice(0, 3)
        quiz = { item, opts: [item.zh, ...zhs].sort(() => Math.random() - .5), answered: false }
    }
    main.innerHTML = `<div class="quiz">
        <div class="score">答對 ${score.right} / ${score.total}</div>
        <div class="q">${esc(quiz.item.w)}</div>
        ${quiz.opts.map(o => `<button class="opt" data-o="${esc(o)}">${esc(o)}</button>`).join('')}
        <div class="ctrl"><button class="btn primary" id="nextq" ${quiz.answered ? '' : 'disabled'}>下一題</button></div>
    </div>`
    document.getElementById('nextq').onclick = () => { quiz = null; render() }
}

// 事件委派:單字表勾選、測驗選項
main.addEventListener('change', e => {
    const k = e.target.dataset.k
    if (!k) return
    e.target.checked ? known.add(k) : known.delete(k)
    save()
    render()
})

main.addEventListener('click', e => {
    const btn = e.target.closest('.opt')
    if (!btn || quiz.answered) return
    quiz.answered = true
    score.total++
    const correct = quiz.item.zh
    if (btn.dataset.o === correct) {
        score.right++
        btn.classList.add('right')
    } else {
        btn.classList.add('wrong')
        document.querySelectorAll('.opt').forEach(o => {
            if (o.dataset.o === correct) o.classList.add('right')
        })
    }
    document.getElementById('nextq').disabled = false
    document.querySelector('.score').textContent = `答對 ${score.right} / ${score.total}`
})

document.querySelectorAll('nav button').forEach(btn => {
    btn.onclick = () => {
        mode = btn.dataset.mode
        document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b === btn))
        cardIdx = 0
        cardFlipped = false
        quiz = null
        render()
    }
})

;[search, catSel, lvSel, knownSel].forEach(el => {
    el.addEventListener('input', () => { cardIdx = 0; cardFlipped = false; quiz = null; render() })
})

render()
