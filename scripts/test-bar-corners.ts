import assert from 'node:assert/strict'
import { barCornerPath } from '../kernel/src/bar-corners.ts'
assert.equal(barCornerPath(10,20,40,100,[8,8,0,0]), 'M18,20H42Q50,20 50,28V120Q50,120 50,120H10Q10,120 10,120V28Q10,20 18,20Z')
// Small values must retain their full baseline and never be rounded away.
assert.equal(barCornerPath(0,0,10,4,[8,8,0,0]), 'M2,0H8Q10,0 10,2V4Q10,4 10,4H0Q0,4 0,4V2Q0,0 2,0Z')
assert.ok(!barCornerPath(0,0,10,0,[8,8,0,0]).includes('NaN'))
assert.equal(barCornerPath(0,0,10,10,[-1,NaN,0,0]),barCornerPath(0,0,10,10,[0,0,0,0]))
console.log('PASS: independent bar corners, square bases, short and zero bars')
