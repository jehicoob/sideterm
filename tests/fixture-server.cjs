// Test-only HTTP fixture. Not packaged in the installed VSIX. Production uses no server.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {createHarness} = require('./mock-vscode.cjs');
const harness = createHarness();
const server = http.createServer(async (request, response) => {
  try {
    const route = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'POST') {
      let raw = ''; for await (const data of request) {raw += data; if (raw.length > 2e6) throw Error('large request');}
      const body = raw ? JSON.parse(raw) : {};
      if (route === '/input') harness.receive(body);
      else if (route === '/command') await harness.commands.get(body.command)?.();
      else if (route === '/answers') Object.assign(harness.answers, body);
      else if (route === '/config') {Object.assign(harness.config.sideterm, body); harness.configChanged();}
      else if (route === '/visibility') harness.visibility(body.visible);
      else if (route === '/trust') harness.vscode.workspace.isTrusted = body.trusted;
      else if (route === '/dispose-view') harness.view.dispose();
      else if (route === '/resolve-view') harness.provider.resolveWebviewView(harness.view);
      response.setHeader('Content-Type', 'application/json'); response.end('{}'); return;
    }
    if (route === '/messages') {response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(harness.messages.splice(0))); return;}
    if (route === '/stats') {response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(harness.stats())); return;}
    if (route === '/') {response.setHeader('Content-Type', 'text/html'); response.end(harness.view.webview.html); return;}
    if (route.startsWith('/media/')) {
      const file = path.resolve(harness.root, '.' + route);
      if (!file.startsWith(path.join(harness.root, 'media') + path.sep)) throw Error('invalid path');
      const types = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'};
      response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); response.end(fs.readFileSync(file)); return;
    }
    response.writeHead(404); response.end('Not found');
  } catch (error) {response.writeHead(500); response.end(String(error));}
});
server.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + server.address().port;
  harness.setBaseUrl(url); harness.provider.resolveWebviewView(harness.view);
  process.stdout.write(url + '\n');
});
async function stop() {await harness.stop(); server.close(() => process.exit(0));}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
