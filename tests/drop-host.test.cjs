const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {randomUUID}=require('node:crypto');
const {createHarness}=require('./mock-vscode.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<250;n++){if(fn())return;await sleep(20);}throw Error('timeout');}
async function start(h){h.receive({type:'ready',rendererId:'drop-test'});await h.commands.get('sideterm.new')();const id=h.messages.findLast(m=>m.type==='created').session.id;h.receive({type:'prepared',id,cols:80,rows:24});await until(()=>h.stats().sessions.find(s=>s.id===id)?.state==='running');return id;}
async function rpc(h,id,action,data={}){const requestId=randomUUID();h.receive({type:'fileDrop',id,action,requestId,...data});await until(()=>h.messages.some(m=>m.type==='fileDropResult'&&m.requestId===requestId));return h.messages.find(m=>m.type==='fileDropResult'&&m.requestId===requestId);}
test('drag inserts only explicit file, never active editor or clipboard, with no Enter',async()=>{
 const h=createHarness();try{
 Object.defineProperty(h.vscode.window,'activeTextEditor',{get(){throw Error('MUST NOT READ EDITOR');}});
 h.vscode.env.clipboard.readText=async()=>{throw Error('MUST NOT READ CLIPBOARD');};
 const id=await start(h);const p=path.join(h.roots[0],"café ' prueba.md");fs.writeFileSync(p,'dropped');
 assert.equal((await rpc(h,id,'paths',{refs:[{kind:'path',value:p}]})).ok,true);
 const paste=h.messages.findLast(m=>m.type==='paste');assert.equal(paste.id,id);assert.equal(paste.text,require('../dist/dropPaths').quoteShellPath(p)+' ');assert.ok(!/[\r\n]/.test(paste.text));
 }finally{await h.stop();}
});
test('missing drop data cannot fall back to editor, selection or workspace file',async()=>{
 const h=createHarness();try{const id=await start(h);assert.equal((await rpc(h,id,'paths',{refs:[]})).ok,false);assert.ok(!h.messages.some(m=>m.type==='paste'));}finally{await h.stop();}
});
test('failed member means nothing is inserted from a multi-file batch',async()=>{
 const h=createHarness();try{const id=await start(h);const p=path.join(h.roots[0],'ok');fs.writeFileSync(p,'ok');assert.equal((await rpc(h,id,'paths',{refs:[{kind:'path',value:p},{kind:'path',value:p+'-absent'}]})).ok,false);assert.ok(!h.messages.some(m=>m.type==='paste'));}finally{await h.stop();}
});
test('copy requires consent; cancelled drop does not copy or paste',async()=>{
 const h=createHarness();try{const id=await start(h);h.answers.confirm=false;const r=await rpc(h,id,'begin',{files:[{name:'a.png',size:1}]});assert.equal(r.cancelled,true);assert.ok(!h.messages.some(m=>m.type==='paste'));assert.equal(h.provider.dropStore.upload,undefined);}finally{await h.stop();}
});
test('binary transfer pastes only completed temporary path to captured target tab',async()=>{
 const h=createHarness();try{
 const id=await start(h);const bytes=Buffer.from([0,1,2,255]);const b=await rpc(h,id,'begin',{files:[{name:'drop.png',size:bytes.length}]});assert.equal(b.ok,true);
 assert.equal((await rpc(h,id,'chunk',{uploadId:b.uploadId,index:0,offset:0,data:bytes.toString('base64')})).ok,true);
 assert.ok(!h.messages.some(m=>m.type==='paste'));
 await h.commands.get('sideterm.new')(); // Change active tab after transfer starts; keep the original target.
 assert.equal((await rpc(h,id,'finish',{uploadId:b.uploadId})).ok,true);
 const paste=h.messages.findLast(m=>m.type==='paste');assert.equal(paste.id,id);
 const filename=paste.text.slice(1,-2);assert.deepEqual(fs.readFileSync(filename),bytes);
 await h.provider.closeSession(id,false);assert.ok(!fs.existsSync(filename));
 }finally{await h.stop();}
});
test('unknown or exited destination does not send the drop to the next active tab',async()=>{
 const h=createHarness();try{await start(h);const r=await rpc(h,'other','paths',{refs:[{kind:'path',value:h.roots[0]}]});assert.equal(r.ok,false);assert.ok(!h.messages.some(m=>m.type==='paste'));}finally{await h.stop();}
});

test('temporary cleanup errors never prevent PTY shutdown',async()=>{
 const h=createHarness();try{await start(h);const original=h.provider.dropStore.dispose.bind(h.provider.dropStore);h.provider.dropStore.dispose=async()=>{throw Error('simulated cleanup failure');};await h.provider.endAll(false);assert.equal(h.stats().pid,undefined);assert.equal(h.stats().sessions.length,0);assert.ok(h.logs.some(x=>x.includes('copias temporales')));h.provider.dropStore.dispose=original;}finally{await h.stop();}
});
