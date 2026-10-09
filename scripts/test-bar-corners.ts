import assert from 'node:assert/strict'
import { barCornerPath } from '../kernel/src/bar-corners.ts'
assert.equal(barCornerPath(10,20,40,100,[8,8,0,0]), 'M18,20H42Q50,20 50,28V120Q50,120 50,120H10Q10,120 10,120V28Q10,20 18,20Z')
// Small values must retain their full baseline and never be rounded away.
assert.equal(barCornerPath(0,0,10,4,[8,8,0,0]), 'M2,0H8Q10,0 10,2V4Q10,4 10,4H0Q0,4 0,4V2Q0,0 2,0Z')
assert.ok(!barCornerPath(0,0,10,0,[8,8,0,0]).includes('NaN'))
assert.equal(barCornerPath(0,0,10,10,[-1,NaN,0,0]),barCornerPath(0,0,10,10,[0,0,0,0]))
console.log('PASS: independent bar corners, square bases, short and zero bars')

// Exercise the actual renderer with a minimal SVG DOM, including negative bars.
class SvgNode {
  attrs: Record<string,string>={}; children: SvgNode[]=[]; style={cssText:''}; textContent=''
  tag: string
  constructor(tag: string) {this.tag=tag}
  setAttribute(k:string,v:string){this.attrs[k]=v}
  appendChild(n:SvgNode){this.children.push(n);return n}
  toString():string{return `<${this.tag} ${Object.entries(this.attrs).map(([k,v])=>`${k}="${v}"`).join(' ')}>${this.textContent}${this.children.join('')}</${this.tag}>`}
}
;(globalThis as any).document={createElementNS:(_:string,tag:string)=>new SvgNode(tag)}
;(globalThis as any).XMLSerializer=class{serializeToString(n:SvgNode){return n.toString()}}
const {chartSnapshotSvg}=await import('../kernel/src/charts.ts')
const option={grid:{left:100,right:40,top:20,bottom:40},xAxis:{type:'value',min:-10,max:10},yAxis:{type:'category',data:['Positive','Negative','Zero']},series:[{type:'bar',data:[8,-4,0],label:{show:true},itemStyle:{borderRadius:[0,8,8,0]}}]}
const svg=chartSnapshotSvg({w:500,h:300,option})
assert.ok(svg.includes('Positive')&&svg.includes('Negative'))
assert.equal((svg.match(/<path /g)||[]).length,3)
assert.ok(!svg.includes('NaN'))
assert.ok(svg.includes('>8</text>')&&svg.includes('>-4</text>'))
assert.ok(svg.includes('M280,'),'positive bar begins at zero (280), not the left edge')
assert.ok(svg.includes('M208,'),'negative value extends left from the zero baseline')
console.log('PASS: horizontal renderer labels, signed values, zero baseline and square starts')
