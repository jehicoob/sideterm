const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const {DropStore,validateDropFiles,MAX_FILE_BYTES}=require('../dist/dropStore');
test('staging validates names, count and total before any copying',()=>{
 for(const value of [[{name:'../a',size:1}],[{name:'a/b',size:1}],[{name:'x\ny',size:1}],[{name:'.',size:0}],[{name:'x',size:MAX_FILE_BYTES+1}],[]]) assert.throws(()=>validateDropFiles(value));
 assert.deepEqual(validateDropFiles([{name:"café ' imagen.png",size:0}]),[{name:"café ' imagen.png",size:0}]);
});
test('acknowledged binary chunks yield exact bytes, private permissions and cleanup',async()=>{
 const store=new DropStore();
 try{
 const bytes=Buffer.alloc(65536+777);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
 const {uploadId}=await store.begin('a',[{name:'image.bin',size:bytes.length},{name:'empty.txt',size:0}]);
 await store.chunk('a',uploadId,0,0,bytes.subarray(0,65536).toString('base64'));
 await store.chunk('a',uploadId,0,65536,bytes.subarray(65536).toString('base64'));
 const paths=await store.finish('a',uploadId);
 assert.deepEqual(fs.readFileSync(paths[0]),bytes);assert.equal(fs.statSync(paths[1]).size,0);
 assert.equal(fs.statSync(paths[0]).mode&0o777,0o600);assert.equal(fs.statSync(require('path').dirname(paths[0])).mode&0o777,0o700);
 await store.clearSession('a');assert.ok(!fs.existsSync(paths[0]));
 }finally{await store.dispose();}
});
test('wrong session, offsets, incomplete transfer and replay are refused',async()=>{
 const s=new DropStore();try{
 const {uploadId}=await s.begin('a',[{name:'a.txt',size:2}]);
 await assert.rejects(s.begin('b',[{name:'x',size:0}]));
 await assert.rejects(s.chunk('b',uploadId,0,0,'YQ=='));
 await assert.rejects(s.chunk('a',uploadId,0,1,'YQ=='));
 await assert.rejects(s.finish('a',uploadId));
 await s.chunk('a',uploadId,0,0,'YWI=');
 await assert.rejects(s.chunk('a',uploadId,0,0,'YWI='));
 await s.cancel(uploadId);await assert.rejects(s.finish('a',uploadId));
 }finally{await s.dispose();}
});
test('closing one session does not remove another session copied files',async()=>{
 const s=new DropStore();try{
 const a=await s.begin('a',[{name:'a',size:0}]);const pa=await s.finish('a',a.uploadId);
 const b=await s.begin('b',[{name:'b',size:0}]);const pb=await s.finish('b',b.uploadId);
 await s.clearSession('a');assert.ok(!fs.existsSync(pa[0]));assert.ok(fs.existsSync(pb[0]));
 await s.dispose();assert.ok(!fs.existsSync(pb[0]));
 }finally{await s.dispose();}
});
