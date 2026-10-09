const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
function event() {
  const listeners = new Set();
  return { subscribe(listener) { listeners.add(listener); return {dispose() {listeners.delete(listener);}}; }, fire(value) { for (const listener of [...listeners]) listener(value); } };
}
function createHarness(options = {}) {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sideterm-fixture-'));
  const roots = ['backend prueba', 'frontend café'].map(name => {const file = path.join(temp, name); fs.mkdirSync(file); return file;});
  let baseUrl = 'http://127.0.0.1:43291';
  const messages = [], logs = [], prompts = [], commands = new Map();
  const answers = { confirm: true, rename: 'Agente principal', pick: 0, clipboard: '', roots: 1 };
  const config = {sideterm: {shell: '/bin/bash', shellArgs: ['--noprofile', '--norc', '-i'], pythonPath: '/usr/bin/python3', scrollback: 1000, maxSessions: 6, confirmClose: true, confirmMultilinePaste: true, cursorBlink: false}, 'terminal.integrated': {fontSize: 14, fontFamily: 'monospace'}};
  const incoming = event(), disposed = event(), visibility = event(), changed = event();
  function uri(file) { return {fsPath: file, scheme: 'file', toString() {return 'file://' + file;}}; }
  const view = {
    visible: true, show() {}, dispose() {disposed.fire();},
    onDidDispose: disposed.subscribe, onDidChangeVisibility: visibility.subscribe,
    webview: {
      html: '', options: {}, get cspSource() {return baseUrl;},
      asWebviewUri(value) { return {toString() {return baseUrl + '/' + path.relative(root, value.fsPath).replaceAll(path.sep, '/');}}; },
      onDidReceiveMessage: incoming.subscribe,
      async postMessage(message) {messages.push(message); return true;}
    }
  };
  const vscode = {
    version: 'mock-public-api-1.85', Uri: {file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts))},
    ThemeIcon: class {constructor(id) {this.id = id;}},
    window: {
      createTreeView(id, options) { harness.treeViews.set(id, options); return {dispose() {harness.treeViews.delete(id);}}; },
      createOutputChannel() {return {appendLine(value) {logs.push(value);}, show() {}, dispose() {}};},
      registerWebviewViewProvider(_id, provider, registrationOptions) { harness.registrationOptions = registrationOptions; provider.resolveWebviewView(view); harness.provider = provider; return {dispose() {}}; },
      async showErrorMessage(message) {logs.push('ERROR: ' + message);},
      async showWarningMessage(message, opts, ...items) {prompts.push({message, opts, items}); return answers.confirm ? items[0] : undefined;},
      async showInformationMessage(message, opts, ...items) {prompts.push({message, opts, items}); return answers.confirm ? items[0] : undefined;},
      async showInputBox(opts) {prompts.push({type: 'rename', opts}); return answers.rename;},
      async showQuickPick(items, opts) {prompts.push({type: 'pick', items, opts}); return items[answers.pick];},
      async showOpenDialog() {return [uri(roots[0])];}
    },
    commands: {registerCommand(id, action) {commands.set(id, action); return {dispose() {commands.delete(id);}};}, async executeCommand(id, ...args) {if (commands.has(id)) return commands.get(id)(...args);}},
    workspace: {
      isTrusted: true,
      get workspaceFolders() {return roots.slice(0, answers.roots).map((file, index) => ({name: path.basename(file), uri: uri(file), index}));},
      getConfiguration(section) {return {get(key, fallback) {return config[section]?.[key] ?? fallback;}};},
      onDidChangeConfiguration: changed.subscribe
    },
    env: {remoteName: 'wsl', appName: 'VS Code fixture', clipboard: {async readText() {return answers.clipboard;}, async writeText(value) {answers.clipboard = value;}}}
  };
  const harness = {root, roots, view, vscode, messages, logs, prompts, commands, answers, config, treeViews: new Map(),
    setBaseUrl(url) {baseUrl = url;}, receive(message) {incoming.fire(message);},
    visibility(value) {view.visible = value; visibility.fire();},
    configChanged() {changed.fire({affectsConfiguration() {return true;}});},
    stats() {return {pid: harness.provider?.bridge.pid, sessions: [...(harness.provider?.sessions.values() || [])].map(s => ({id: s.id, name: s.name, pid: s.pid, state: s.state, cwd: s.cwd, cols: s.cols, rows: s.rows, outstanding: s.outstanding})), logs, prompts, answers, rendererReady: harness.provider?.rendererReady};},
    async stop() {await harness.module.deactivate(); fs.rmSync(temp, {recursive: true, force: true});}
  };
  const previous = Module._load;
  Module._load = function(id, ...rest) {return id === 'vscode' ? vscode : previous.call(this, id, ...rest);};
  for (const file of ['extension.js', 'api.js']) delete require.cache[path.join(root, 'dist', file)];
  try {harness.module = require(path.join(root, 'dist', 'extension.js'));}
  finally {Module._load = previous;}
  harness.context = {extensionPath: root, extensionUri: uri(root), subscriptions: []};
  harness.module.activate(harness.context);
  return harness;
}
module.exports = {createHarness};
