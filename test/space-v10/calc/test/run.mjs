import { add } from '../add.js'
import assert from 'node:assert/strict'
assert.equal(add(2, 3), 5, '2+3 应为 5')
assert.equal(add(-1, 1), 0, '-1+1 应为 0')
console.log('ALL GREEN')
