const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'); const os=require('node:os');const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {resolveDropPaths,quoteShellPath}=require('../dist/dropPaths');
const env={wsl:true,distro:'Ubuntu-22.04',authorities:['wsl+Ubuntu-22.04'],check:async()=>{}};
const ref=(value,kind='path')=>({kind,value});
test('explicit POSIX paths preserve spaces, apostrophes, accents, deduplicate only same path',async()=>{
 assert.deepEqual(await resolveDropPaths([ref('/home/a/mi café.txt'),ref('/home/a/mi café.txt'),ref("/home/b/a'b.png")],env),['/home/a/mi café.txt',"/home/b/a'b.png"]);
});
test('URI decode, selection fragment and local file URI',async()=>{
 assert.deepEqual(await resolveDropPaths([ref('vscode-remote://wsl+Ubuntu-22.04/home/a/mi%20archivo.ts#L2,4','uri'),ref('file:///tmp/%23real.txt','uri')],env),['/home/a/mi archivo.ts','/tmp/#real.txt']);
});
test('WSL Windows drive conversion uses converter instead of assuming /mnt/c',async()=>{
 let called; const e={...env,convertWindows:async x=>{called=x;return '/custom/c/Users/a b.png';}};
 assert.deepEqual(await resolveDropPaths([ref('file:///C:/Users/a%20b.png','uri')],e),['/custom/c/Users/a b.png']);
 assert.equal(called,'C:/Users/a b.png');
});
test('UNC to own WSL resolves while different distro and remote host are rejected',async()=>{
 assert.deepEqual(await resolveDropPaths([ref('\\\\wsl.localhost\\Ubuntu-22.04\\home\\a\\img.png')],env),['/home/a/img.png']);
 assert.deepEqual(await resolveDropPaths([ref('file://wsl$/Ubuntu-22.04/home/a/img.png','uri')],env),['/home/a/img.png']);
 await assert.rejects(resolveDropPaths([ref('\\\\wsl.localhost\\Debian\\home\\a')],env));
 await assert.rejects(resolveDropPaths([ref('vscode-remote://ssh-remote+other/tmp/a','uri')],env));
});
test('unsupported URLs, relative paths, controls and malformed data never get inserted',async()=>{
 for(const value of [[ref('https://site.invalid/a','uri')],[ref('untitled:Untitled-1','uri')],[ref('a.txt')],[ref('/tmp/a\nwhoami')],[ref('/tmp/\x1b[31ma')],[ref('file:///tmp/%00a','uri')],[],Array(17).fill(ref('/a'))]) await assert.rejects(resolveDropPaths(value,env));
});
test('actual filesystem validation refuses missing paths and accepts regular files and dirs',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sideterm-drop-test-'));
 try {const p=path.join(root,'a.txt');fs.writeFileSync(p,'ok');
 assert.deepEqual(await resolveDropPaths([ref(p),ref(root)],{...env,check:undefined}),[p,root]);
 await assert.rejects(resolveDropPaths([ref(p),ref(path.join(root,'absent'))],{...env,check:undefined}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('shell quoting resists expansion without executing a single user-derived command',()=>{
 const value="/tmp/file with '; echo WRONG; ' $(echo WRONG) `echo WRONG` & x.txt";
 const result=spawnSync('/bin/bash',['-c',"printf '%s' "+quoteShellPath(value)],{encoding:'utf8'});
 assert.equal(result.status,0);assert.equal(result.stdout,value);
 assert.ok(!/[\r\n]/.test(quoteShellPath(value)));assert.throws(()=>quoteShellPath('/bad\nline'));
});
