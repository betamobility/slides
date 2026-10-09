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
assert.equal(doc.slides.length,35);assert.equal(doc.layouts.length,35)
assert.equal(doc.template,true);assert.ok(!doc.docId&&!doc.collab)
assert.equal(doc.beta.tokens,'1.4.0');assert.equal(doc.theme.background,'#FFFFFF')
const findings=validateDoc(doc).findings;const errors=findings.filter((f:any)=>f.severity==='error');assert.deepEqual(errors,[])
for(const slide of [...doc.slides,...doc.layouts]){
 const ids=new Set();for(const e of slide.elements){assert.ok(!ids.has(e.id));ids.add(e.id);assert.ok(e.x>=0&&e.y>=0&&e.x+e.w<=1280.01&&e.y+e.h<=720.01,slide.id+':'+e.id);assert.notEqual(e.role,'kicker');assert.notEqual(e.id,'page');if(e.type==='image')assert.ok(doc.assets[e.src.slice(6)])}
 const logo=slide.elements.find((e:any)=>e.id==='beta-logo');assert.equal(logo.x,128/3);assert.equal(logo.h,64/3);assert.ok(Math.abs(720-logo.y-logo.h-32)<.01)
}
assert.ok(!doc.slides.some((s:any)=>s.id==='image-callouts'));
assert.ok(doc.slides.some((s:any)=>s.id==='image-full-left'));
assert.ok(doc.slides.flatMap((s:any)=>s.elements).some((e:any)=>e.type==='image'&&e.radius===32));
assert.deepEqual(doc.slides.find((s:any)=>s.id==='chart').elements.find((e:any)=>e.type==='chart').option.series[0].itemStyle.borderRadius,[8,8,0,0]);
assert.equal(doc.slides.find((s:any)=>s.id==='text').elements.find((e:any)=>e.id==='body').fontSize,28);
assert.equal(doc.slides.find((s:any)=>s.id==='text').elements.find((e:any)=>e.id==='title').fontSize,46);
const {pptx,report}=await mapDeck(doc)
const file=join(tmpdir(),'Beta-General-v131.pptx');await pptx.writeFile({fileName:file})
const xmls=execFileSync('unzip',['-Z1',file],{encoding:'utf8'}).split('\n').filter(s=>/^ppt\/slides\/slide\d+.xml$/.test(s));assert.equal(xmls.length,35)
const xml=execFileSync('unzip',['-p',file,'ppt/slides/slide1.xml'],{encoding:'utf8'});assert.ok(xml.includes('Better places.'));assert.ok(xml.includes('<p:sp>'))
assert.ok(!report.some(r=>['image-remote','unknown:svg'].includes(r.reason)))
writeFileSync(join(tmpdir(),'beta-general-export-report.json'),JSON.stringify(report,null,2))
console.log('PASS: 35 layouts, fit, logo geometry, no eyebrows, native validation, editable 35-slide PPTX. '+file)
assert.ok(findings.filter((f:any)=>f.severity==='warning').every((f:any)=>f.code==='unknown-key'&&f.path==='beta')); console.log('Only informational fixed-canvas margin notes and the documented beta provenance key remain.')

assert.deepEqual(doc.fonts.filter((f:any)=>f.family==='Geist').map((f:any)=>f.weight),['300','400','500','600','700']);
assert.ok(doc.fonts.some((f:any)=>f.family==='DM Mono'));
for(const slide of doc.slides)for(const e of slide.elements){if(e.role==='metadata'||e.role==='source')assert.ok(e.fontFamily.includes('DM Mono'));if(e.type==='table')assert.equal(e.style.radius,0)}

const chartFiles=execFileSync('unzip',['-Z1',file],{encoding:'utf8'}).split('\n').filter(s=>/^ppt\/charts\/chart\d+\.xml$/.test(s));
const horizontal=chartFiles.map(f=>execFileSync('unzip',['-p',file,f],{encoding:'utf8'})).find(x=>x.includes('<c:barDir val="bar"'));
assert.ok(horizontal?.includes('Walking routes')&&horizontal.includes('Wayfinding'),'horizontal PPTX retains category labels and orientation');
