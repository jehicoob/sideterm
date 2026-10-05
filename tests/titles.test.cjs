const {test} = require('node:test');
const assert = require('node:assert/strict');
const {tabName, cleanTitle} = require('../dist/titles.js');
const base = {shell:'/usr/bin/zsh', cwd:'/projects/backend'};
test('title follows the actual folder rather than launch folder', () => {
  assert.equal(tabName(base), 'zsh · backend');
  assert.equal(tabName({...base,cwd:'/projects/frontend café'}), 'zsh · frontend café');
  assert.equal(tabName({...base,cwd:'/'}), 'zsh · /');
});
test('real known process outranks another application mentioned by a title', () => {
  assert.equal(tabName({...base,processName:'OpenCode',foreground:true,sequenceTitle:'Claude discussion'}),'OpenCode · backend');
  assert.equal(tabName({...base,processName:'Claude',foreground:true}),'Claude · backend');
});
test('generic interpreter can use a known OSC application title', () => {
  assert.equal(tabName({...base,processName:'node',foreground:true,sequenceTitle:'✳ Claude Code'}),'Claude · backend');
  assert.equal(tabName({...base,processName:'bun',foreground:true,sequenceTitle:'OpenCode | demo'}),'OpenCode · backend');
});
test('return to shell cannot retain a stale agent title', () => {
  assert.equal(tabName({...base,processName:'zsh',foreground:false,sequenceTitle:'Claude'}),'zsh · backend');
});
test('manual title keeps dynamic folder and can be cleared', () => {
  assert.equal(tabName({...base,processName:'OpenCode',customName:'Planificación'}),'Planificación · backend');
  assert.equal(tabName({...base,cwd:'/work/frontend',customName:'Planificación'}),'Planificación · frontend');
  assert.equal(tabName({...base,processName:'OpenCode',customName:''}),'OpenCode · backend');
});
test('display metadata strips bidi and controls and never interprets markup', () => {
  assert.equal(cleanTitle('\u202eClaude\x1b\n'), 'Claude');
  assert.equal(cleanTitle('a'.repeat(600)).length,160);
  assert.equal(tabName({...base,customName:'<img src=x>'}), '<img src=x> · backend');
});
