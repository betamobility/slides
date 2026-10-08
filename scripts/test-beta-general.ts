// Verify the actual built general template and editable PPTX mapping.
import {readFileSync,writeFileSync,existsSync,mkdtempSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
if(import.meta.url.endsWith('.ts')){
 const dir=mkdtempSync(join(tmpdir(),'beta-general-test-'));const file=join(dir,'test.mjs')
 execFileSync('slides/node_modules/.bin/esbuild',[fileURLToPath(import.meta.url),'--bundle','--platform=node','--format=esm','--log-level=warning','--outfile='+file])
 execFileSync(process.execPath,[file],{stdio:'inherit'});process.exit(0)
}
const {validateDoc}=await import('../slides/src/validate.ts')
const {mapDeck}=await import('../slides/src/export/pptx.ts')
const html=readFileSync('beta/templates/general.bento.html','utf8')
const doc=JSON.parse(html.match(/<script type="application\/bento\+json" id="bento-doc">([\s\S]*?)<\/script>/)![1])
assert.equal(doc.slides.length,23);assert.equal(doc.layouts.length,23)
assert.equal(doc.template,true);assert.ok(!doc.docId&&!doc.collab)
assert.equal(doc.beta.tokens,'1.3.1');assert.equal(doc.theme.background,'#FFFFFF')
const findings=validateDoc(doc).findings;const errors=findings.filter((f:any)=>f.severity==='error');assert.deepEqual(errors,[])
for(const slide of [...doc.slides,...doc.layouts]){
 const ids=new Set();for(const e of slide.elements){assert.ok(!ids.has(e.id));ids.add(e.id);assert.ok(e.x>=0&&e.y>=0&&e.x+e.w<=1280.01&&e.y+e.h<=720.01,slide.id+':'+e.id);assert.notEqual(e.role,'kicker');if(e.type==='image')assert.ok(doc.assets[e.src.slice(6)])}
 const logo=slide.elements.find((e:any)=>e.id==='beta-logo');assert.equal(logo.x,128/3);assert.equal(logo.h,64/3);assert.ok(Math.abs(720-logo.y-logo.h-32)<.01)
}
const {pptx,report}=await mapDeck(doc)
const file=join(tmpdir(),'Beta-General-v131.pptx');await pptx.writeFile({fileName:file})
const xmls=execFileSync('unzip',['-Z1',file],{encoding:'utf8'}).split('\n').filter(s=>/^ppt\/slides\/slide\d+.xml$/.test(s));assert.equal(xmls.length,23)
const xml=execFileSync('unzip',['-p',file,'ppt/slides/slide1.xml'],{encoding:'utf8'});assert.ok(xml.includes('Better places.'));assert.ok(xml.includes('<p:sp>'))
assert.ok(!report.some(r=>['image-remote','unknown:svg'].includes(r.reason)))
writeFileSync(join(tmpdir(),'beta-general-export-report.json'),JSON.stringify(report,null,2))
console.log('PASS: 23 layouts, fit, logo geometry, no eyebrows, native validation, editable 23-slide PPTX. '+file)
assert.ok(findings.filter((f:any)=>f.severity==='warning').every((f:any)=>f.code==='unknown-key'&&f.path==='beta')); console.log('Only informational fixed-canvas margin notes and the documented beta provenance key remain.')
