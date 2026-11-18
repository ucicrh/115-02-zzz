const a1 = 1
let a2 = 2
const a3 = [100, 200]

const print = () => {
  console.log('a', a1)
  console.log('a', a2)
  console.log('a', a3)
}

// 預設匯出，一個檔案只能有一個
// 只能匯出一個變數
export default {
  a1, a2, a3, print
}