// import 自訂變數名 from 來源
// import apple from './a.js'  --> 引用 a.js 檔案
// import apple from 'a.js'    --> 引用 a.js 套件

// 引用 a.js 的 export default，取名叫 apple
import apple from './a.js'

// 一次引用 b.js 的所有 export，取名叫 banana
import * as banana from './b.js'
// 引用指定 b.js 的 export
import { b1, b2 } from './b.js'
// 引用指定 b.js 的 export，並重新取名
import { b1 as bb1 } from './b.js'

console.log('index', apple.a1)
console.log('index', apple.a2)
console.log('index', apple.a3)

// 盡量不要修改匯入的變數
// 因為只會 = 只會改到這份檔案，不會改到原始檔案
// 陣列或物件操作會修改到原始檔案的值
apple.a1 = 100
apple.a2 = 200
// apple.a3 = [300, 400]
// apple.a3.push(300)
apple.a3[0] = 300
console.log('index', apple.a1)
console.log('index', apple.a2)
console.log('index', apple.a3)
apple.print()

console.log('index', banana.b1)
console.log('index', banana.b2)
console.log('index', banana.b3)
// 不能修改
// TypeError: Cannot assign to read only property 'b1' of object '[object Module]'
// banana.b1 = 100
// TypeError: Assignment to constant variable.
// b1 = 100
// 但是可以陣列或物件操作
banana.b3.push(300)
console.log('index', banana.b3)
banana.print()