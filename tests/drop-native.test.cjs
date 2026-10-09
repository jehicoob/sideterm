const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {pathToFileURL}=require('node:url');
const {createHarness}=require('./mock-vscode.cjs');
const {quoteShellPath}=require('../dist/dropPaths');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<250;n++){if(fn())return;await sleep(20);}throw Error('timeout');}
async function start(h){await h.commands.get('sideterm.new')();const id=h.messages.findLast(m=>m.type==='created').session.id;h.receive({type:'prepared',id,cols:80,rows:24});await until(()=>h.stats().sessions.find(s=>s.id===id)?.state==='running');return id;}
const uriList=(...lines)=>({get(mime){return mime==='text/uri-list'?{asString:async()=>lines.join('\r\n')}:undefined;}});
const drop=(h,data)=>h.treeViews.get('sideterm.drop').dragAndDropController.handleDrop(undefined,data,{});
const uri=file=>({toString(){return pathToFileURL(file).href;}});

test('native drop view accepts only Explorer URI lists',async()=>{
 const h=createHarness();try{const c=h.treeViews.get('sideterm.drop').dragAndDropController;assert.deepEqual(c.dropMimeTypes,['text/uri-list']);assert.deepEqual(c.dragMimeTypes,[]);}finally{await h.stop();}
});
test('native drop inserts quoted paths into the active tab, without Enter or editor fallback',async()=>{
 const h=createHarness();try{
 Object.defineProperty(h.vscode.window,'activeTextEditor',{get(){throw Error('MUST NOT READ EDITOR');}});
 h.vscode.env.clipboard.readText=async()=>{throw Error('MUST NOT READ CLIPBOARD');};
 h.receive({type:'ready',rendererId:'native-drop'});await start(h);const id=await start(h);
 const a=path.join(h.roots[0],"café ' prueba.md"),b=path.join(h.roots[0],'otro.txt');fs.writeFileSync(a,'a');fs.writeFileSync(b,'b');
 await drop(h,uriList('# comentario',pathToFileURL(a).href,'',pathToFileURL(b).href));
 const paste=h.messages.findLast(m=>m.type==='paste');assert.equal(paste.id,id);
 assert.equal(paste.text,quoteShellPath(a)+' '+quoteShellPath(b)+' ');assert.ok(!/[\r\n]/.test(paste.text));
 }finally{await h.stop();}
});
test('Explorer context menu inserts the whole multi-selection, or the clicked file',async()=>{
 const h=createHarness();try{
 h.receive({type:'ready',rendererId:'explorer-menu'});const id=await start(h);
 const a=path.join(h.roots[0],'uno.ts'),b=path.join(h.roots[0],'dos.ts');fs.writeFileSync(a,'1');fs.writeFileSync(b,'2');
 await h.commands.get('sideterm.insertPath')(uri(a),[uri(a),uri(b)]);
 assert.equal(h.messages.findLast(m=>m.type==='paste').text,quoteShellPath(a)+' '+quoteShellPath(b)+' ');
 await h.commands.get('sideterm.insertPath')(uri(b));
 const paste=h.messages.findLast(m=>m.type==='paste');assert.equal(paste.id,id);assert.equal(paste.text,quoteShellPath(b)+' ');
 }finally{await h.stop();}
});
test('without a running tab nothing is inserted and the user is told why',async()=>{
 const h=createHarness();try{
 h.receive({type:'ready',rendererId:'no-tab'});const a=path.join(h.roots[0],'x.md');fs.writeFileSync(a,'x');
 await drop(h,uriList(pathToFileURL(a).href));
 assert.ok(!h.messages.some(m=>m.type==='paste'));assert.ok(h.logs.some(x=>x.includes('pestaña de SideTerm en ejecución')));
 }finally{await h.stop();}
});
test('foreign remote, empty or unreadable drops insert nothing',async()=>{
 const h=createHarness();try{
 h.receive({type:'ready',rendererId:'foreign'});await start(h);
 await drop(h,uriList('vscode-remote://ssh-remote%2Botro/home/user/a.txt'));
 await drop(h,uriList('# solo comentario'));
 await drop(h,{get(){return undefined;}});
 await drop(h,uriList(pathToFileURL(path.join(h.roots[0],'no-existe.txt')).href));
 assert.ok(!h.messages.some(m=>m.type==='paste'));assert.ok(h.logs.some(x=>x.includes('otro host remoto')));
 }finally{await h.stop();}
});
