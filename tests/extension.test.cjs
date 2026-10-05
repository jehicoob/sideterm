const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHarness} = require('./mock-vscode.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) {if (Date.now() > end) throw Error('timeout'); await sleep(20);}
}
function ready(h) {h.receive({type: 'ready', rendererId: 'test-renderer-1'});}
async function session(h) {
  await h.commands.get('sideterm.new')();
  const created = h.messages.findLast(m => m.type === 'created');
  assert.ok(created); h.receive({type: 'prepared', id: created.session.id, cols: 80, rows: 24});
  await until(() => h.stats().sessions.find(s => s.id === created.session.id)?.state === 'running');
  return created.session.id;
}

test('activation is lazy, registration is a sidebar webview, native terminal APIs untouched', async () => {
  const h = createHarness();
  try {assert.equal(h.stats().pid, undefined); assert.equal(h.stats().sessions.length, 0); assert.equal(h.registrationOptions.webviewOptions.retainContextWhenHidden, true); assert.ok(h.commands.has('sideterm.new'));}
  finally {await h.stop();}
});
test('one shared broker for two shells; selecting tabs does not create a process', async () => {
  const h = createHarness(); ready(h);
  try {
    const a = await session(h), pid = h.stats().pid, b = await session(h);
    assert.equal(h.stats().pid, pid); assert.notEqual(h.stats().sessions[0].pid, h.stats().sessions[1].pid);
    h.receive({type: 'select', id: a}); h.receive({type: 'select', id: b});
    assert.equal(h.stats().pid, pid);
  } finally {await h.stop();}
});
test('no process until the renderer acknowledges terminal creation', async () => {
  const h = createHarness(); ready(h);
  try {await h.commands.get('sideterm.new')(); assert.equal(h.stats().pid, undefined); assert.equal(h.stats().sessions[0].state, 'preparing');}
  finally {await h.stop();}
});
test('restricted workspaces do not start sessions', async () => {
  const h = createHarness(); ready(h); h.vscode.workspace.isTrusted = false;
  try {await h.commands.get('sideterm.new')(); assert.equal(h.stats().sessions.length, 0); assert.equal(h.stats().pid, undefined); assert.ok(h.logs.some(x => x.includes('confianza')));}
  finally {await h.stop();}
});
test('maximum tab limit is enforced before process creation', async () => {
  const h = createHarness(); ready(h); h.config.sideterm.maxSessions = 1;
  try {await session(h); await h.commands.get('sideterm.new')(); assert.equal(h.stats().sessions.length, 1); assert.ok(h.logs.some(x => x.includes('Límite')));}
  finally {await h.stop();}
});
test('close cancellation preserves shell and confirmation shuts down idle broker', async () => {
  const h = createHarness(); ready(h);
  try {
    await session(h); h.answers.confirm = false; await h.commands.get('sideterm.close')(); assert.equal(h.stats().sessions.length, 1);
    h.answers.confirm = true; await h.commands.get('sideterm.close')(); assert.equal(h.stats().sessions.length, 0); assert.equal(h.stats().pid, undefined);
  } finally {await h.stop();}
});
test('multiline paste cancellation never forwards commands', async () => {
  const h = createHarness(); ready(h);
  try {
    const id = await session(h); h.answers.confirm = false; h.answers.clipboard = 'echo one\necho two\n';
    await h.commands.get('sideterm.paste')(); assert.equal(h.messages.filter(m => m.type === 'paste').length, 0);
    h.answers.confirm = true; await h.commands.get('sideterm.paste')(); assert.equal(h.messages.findLast(m => m.type === 'paste').id, id);
  } finally {await h.stop();}
});
test('multi-root selection passes the selected absolute working directory', async () => {
  const h = createHarness(); ready(h); h.answers.roots = 2; h.answers.pick = 1;
  try {await session(h); assert.equal(h.stats().sessions[0].cwd, h.roots[1]); assert.ok(h.prompts.some(p => p.type === 'pick'));}
  finally {await h.stop();}
});
test('hidden view preserves running sessions and closing all stops them', async () => {
  const h = createHarness(); ready(h);
  try {await session(h); const pid = h.stats().pid; h.visibility(false); await sleep(50); h.visibility(true); assert.equal(h.stats().pid, pid); await h.commands.get('sideterm.closeAll')(); assert.equal(h.stats().pid, undefined);}
  finally {await h.stop();}
});
test('renderer reload terminates otherwise unreachable sessions', async () => {
  const h = createHarness(); ready(h);
  try {await session(h); h.receive({type: 'ready', rendererId: 'replacement-renderer'}); await until(() => !h.stats().pid); assert.equal(h.stats().sessions.length, 0); assert.ok(h.messages.some(m => m.type === 'notice'));}
  finally {await h.stop();}
});
test('malformed and oversized input cannot grow the helper queue', async () => {
  const h = createHarness(); ready(h);
  try {const id = await session(h); h.receive(null); h.receive({type: 'input', id, text: 'a'.repeat(300000)}); h.receive({type: 'ack', id, bytes: 10000000}); await sleep(50); assert.equal(h.stats().sessions[0].state, 'running'); assert.ok(h.stats().sessions[0].outstanding <= 131072);}
  finally {await h.stop();}
});
test('HTML has restrictive CSP, local-only resources and no workspace interpolation', async () => {
  const h = createHarness();
  try {const html = h.view.webview.html; assert.match(html, /default-src 'none'/); assert.match(html, /connect-src 'none'/); assert.match(html, /nonce-/); assert.ok(!html.includes(h.roots[0])); assert.equal(h.view.webview.options.localResourceRoots.length, 1);}
  finally {await h.stop();}
});
test('new terminal during previous helper shutdown is not spuriously marked exited', async () => {
  const h = createHarness(); ready(h);
  try {
    const first = await session(h);
    const close = h.provider.closeSession(first, false);
    await h.commands.get('sideterm.new')();
    const second = h.messages.findLast(m => m.type === 'created').session.id;
    h.receive({type: 'prepared', id: second, cols: 80, rows: 24});
    await close;
    await until(() => h.stats().sessions.some(s => s.id === second && s.state === 'running'));
    assert.equal(h.messages.filter(m => m.type === 'ended' && m.id === second).length, 0);
  } finally {await h.stop();}
});

test('dynamic path and foreground labels reach host tab metadata', async () => {
  const h = createHarness(); ready(h);
  try {
    const id = await session(h);
    h.receive({type:'input', id, text:'cd /\n'});
    await until(() => h.stats().sessions.find(s=>s.id===id)?.cwd==='/',3500);
    assert.equal(h.stats().sessions[0].name,'bash · /');
    h.receive({type:'input', id, text:'sleep 30\n'});
    await until(() => h.stats().sessions[0].name==='sleep · /',3500);
    h.receive({type:'input', id, text:'\x03'});
    await until(() => h.stats().sessions[0].name==='bash · /',3500);
  } finally { await h.stop(); }
});
test('manual rename keeps changing cwd, blank and command restore automatic', async () => {
  const h = createHarness(); ready(h);
  try {
    const id = await session(h);
    await h.commands.get('sideterm.rename')();
    assert.ok(h.stats().sessions[0].name.startsWith('Agente principal · '));
    h.receive({type:'input',id,text:'cd /\n'});
    await until(()=>h.stats().sessions[0].name==='Agente principal · /',3500);
    h.answers.rename=''; await h.commands.get('sideterm.rename')();
    assert.equal(h.stats().sessions[0].name,'bash · /');
    h.answers.rename='Otro';await h.commands.get('sideterm.rename')();
    await h.commands.get('sideterm.resetName')();
    assert.equal(h.stats().sessions[0].name,'bash · /');
  } finally { await h.stop(); }
});
test('minimum tab width is configurable and clamped live', async () => {
  const h = createHarness(); ready(h);
  try {
    assert.equal(h.messages.findLast(m=>m.type==='config').config.tabMinWidth,140);
    h.config.sideterm.tabMinWidth=180; h.configChanged();
    assert.equal(h.messages.findLast(m=>m.type==='config').config.tabMinWidth,180);
    h.config.sideterm.tabMinWidth=9999; h.configChanged();
    assert.equal(h.messages.findLast(m=>m.type==='config').config.tabMinWidth,320);
  } finally { await h.stop(); }
});
