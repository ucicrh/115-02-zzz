// 設定聊天室底部的 Rich Menu（只需要執行一次，換圖或改按鈕時再執行）
//   node richmenu.js         建立選單並設為所有人的預設選單
//   node richmenu.js delete  移除這支程式建立的選單
import 'dotenv/config'
import { readFile } from 'node:fs/promises'

const MENU_NAME = 'ai-assistant-menu'
const IMAGE_PATH = new URL('./richmenu.png', import.meta.url)

// 圖片是 1200x810、3x3 格，每格按下去會送出對應的文字
const WIDTH = 1200
const HEIGHT = 810
const COLUMNS = 3
const ROWS = 3
const BUTTONS = ['OCR', '翻譯', '解題', '摘要', '改寫', '天氣', '匯率', '新聞', 'help']

const call = async (url, options = {}) => {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}`, ...options.headers },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${url} ${res.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

const deleteMenus = async (exceptId) => {
  const { richmenus = [] } = await call('https://api.line.me/v2/bot/richmenu/list')
  for (const menu of richmenus) {
    if (menu.name !== MENU_NAME || menu.richMenuId === exceptId) continue
    await call(`https://api.line.me/v2/bot/richmenu/${menu.richMenuId}`, { method: 'DELETE' })
    console.log('已刪除選單', menu.richMenuId)
  }
}

const createMenu = async () => {
  const cellWidth = WIDTH / COLUMNS
  const cellHeight = HEIGHT / ROWS
  const { richMenuId } = await call('https://api.line.me/v2/bot/richmenu', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: { width: WIDTH, height: HEIGHT },
      selected: true,
      name: MENU_NAME,
      chatBarText: '功能選單',
      areas: BUTTONS.map((text, i) => ({
        bounds: {
          x: (i % COLUMNS) * cellWidth,
          y: Math.floor(i / COLUMNS) * cellHeight,
          width: cellWidth,
          height: cellHeight,
        },
        action: { type: 'message', text },
      })),
    }),
  })
  console.log('已建立選單', richMenuId)

  await call(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: await readFile(IMAGE_PATH),
  })
  console.log('已上傳圖片')

  await call(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST' })
  console.log('已設為預設選單')

  // 清掉之前建立的舊選單
  await deleteMenus(richMenuId)
}

try {
  if (process.argv[2] === 'delete') {
    await deleteMenus()
    console.log('完成')
  } else {
    await createMenu()
    console.log('完成，重新進入聊天室就會看到選單')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
