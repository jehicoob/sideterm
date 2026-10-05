"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PtyBridge = void 0;
const node_child_process_1 = require("node:child_process");
const node_events_1 = require("node:events");
/** One Python process shared by all tabs. StdIO only; no TCP ports or shell:true. */
class PtyBridge extends node_events_1.EventEmitter {
    script;
    python;
    child;
    starting;
    stopping;
    ready = false;
    line = '';
    stderr = '';
    pythonVersion = '';
    constructor(script, python) {
        super();
        this.script = script;
        this.python = python;
    }
    get pid() { return this.child?.pid; }
    get online() { return this.ready; }
    async start() {
        if (this.stopping)
            await this.stopping;
        if (this.ready)
            return;
        if (this.starting)
            return this.starting;
        this.starting = this.launch();
        try {
            await this.starting;
        }
        finally {
            this.starting = undefined;
        }
    }
    launch() {
        return new Promise((resolve, reject) => {
            this.line = '';
            this.stderr = '';
            this.ready = false;
            const child = (0, node_child_process_1.spawn)(this.python(), ['-I', '-S', '-u', this.script], {
                stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
                env: { ...process.env }, shell: false
            });
            this.child = child;
            let settled = false;
            const fail = (error) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(error);
                }
            };
            const timer = setTimeout(() => {
                fail(new Error('Python no respondió a tiempo. Revisa sideterm.pythonPath en la configuración remota.'));
                child.kill('SIGTERM');
            }, 6000);
            timer.unref();
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (text) => { this.stderr = (this.stderr + text).slice(-4096); });
            child.stdin.on('error', () => { });
            child.stdout.on('data', (text) => {
                this.line += text;
                if (this.line.length > 2 * 1024 * 1024) {
                    fail(new Error('Respuesta del motor PTY demasiado grande.'));
                    child.kill('SIGTERM');
                    return;
                }
                for (let index; (index = this.line.indexOf('\n')) !== -1;) {
                    const row = this.line.slice(0, index);
                    this.line = this.line.slice(index + 1);
                    let message;
                    try {
                        message = JSON.parse(row);
                    }
                    catch {
                        child.kill('SIGTERM');
                        fail(new Error('Protocolo PTY inválido.'));
                        return;
                    }
                    if (message.type === 'ready') {
                        if (message.protocol !== 1) {
                            fail(new Error('Versión del motor PTY incompatible.'));
                            child.kill();
                            return;
                        }
                        this.ready = true;
                        this.pythonVersion = message.python ?? '';
                        if (!settled) {
                            settled = true;
                            clearTimeout(timer);
                            resolve();
                        }
                    }
                    else {
                        this.emit('message', message);
                    }
                }
            });
            child.on('error', (err) => {
                fail(new Error(`No se pudo iniciar Python 3: ${err.message}. Configura sideterm.pythonPath en WSL.`));
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                const expected = !!this.stopping;
                if (this.child === child) {
                    this.ready = false;
                    this.child = undefined;
                }
                fail(new Error(`El motor PTY finalizó (${signal ?? code ?? 'desconocido'}). ${this.stderr}`.trim()));
                this.emit('stopped', { expected, code, signal });
            });
        });
    }
    send(message) {
        const input = this.child?.stdin;
        if (!this.ready || !input || input.destroyed || input.writableLength > 1024 * 1024)
            return false;
        input.write(JSON.stringify(message) + '\n');
        return true;
    }
    stop() {
        if (this.stopping)
            return this.stopping;
        const child = this.child;
        if (!child)
            return Promise.resolve();
        this.stopping = new Promise((resolve) => {
            const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1800);
            timer.unref();
            child.once('close', () => { clearTimeout(timer); resolve(); });
            if (this.ready)
                this.send({ type: 'shutdown' });
            child.stdin.end();
        });
        return this.stopping.finally(() => { this.stopping = undefined; });
    }
}
exports.PtyBridge = PtyBridge;
